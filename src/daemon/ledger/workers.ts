// 账本里的 Worker（M3，m3-plan 第 2、3 节）：Worker 的账本逻辑都在这里。
// - hub worker start / send / end / list，Worker 调 hub status；
// - 在哪干活：主文件夹是有提交的 git 仓库、又没给 --no-worktree → worktree（登记 worktree.create，建好了再起会话），
//   否则直接在主文件夹里干（直接登记 session.start 和第一条 session.send）。git 由 agent 接口在调 hubCall 之前异步探好
//   （HubCallContext.workspace），这里不做 I/O；git 没跑成就拒绝派活，不默默改成主文件夹；
// - Worker 的会话每一轮结束，在同一个事务里给项目经理的对话发那一行（kind worker），并把全文交给项目经理（session.send）；
// - Worker 的消息发不出去（session.send 次数用完）也发一行 turn_failed 交给项目经理；
// - 用户在网页上直接对 Worker 说的话：Worker 收到时（message.delivered）发一行 user_message 交给项目经理；
//   Worker 收工、还没开工时不收（assertWorkerOpenForUser，messages.ts 的 postUserMessage、retryMessage 调）；
// - 建 worktree 的回调（getWorktreeTask、onSetupStarted、onWorktreeCreated）和彻底失败（worktree_failed）；
//   配了准备命令的，跑的时候 Worker 会话显示“准备中”，跑完的结果加在任务说明前面，重启后没开工的重新登记建 worktree；
// - Worker 会话的启动上下文。
// 汇报格式、解析、那一行的写法、分支名在 shared/worker.ts；按角色放行的表在 shared/hub.ts；git 在 daemon/git/。
import { randomUUID } from "node:crypto";
import type { AnyActionRow } from "../../shared/actions.ts";
import { agentTextOf } from "../../shared/attachments.ts";
import { normalizeWorkerTitle, personaOrTemplate, utf8Bytes, workerMessageDedupeKey } from "../../shared/domain.ts";
import type {
  AgentSessionRow,
  ConversationId,
  MessageId,
  PmId,
  PmMode,
  SessionId,
  WorkerEvent,
  WorkerId,
  WorkerLineStatus,
  WorkerMessageMeta,
  WorkerRecord,
} from "../../shared/domain.ts";
import { turnFailureReason, type DriverEvent } from "../../shared/driver.ts";
import type { HubArgs, HubResult, WorkerHubStatus } from "../../shared/hub.ts";
import type { HubCallContext, LaunchContext, SetupOutcome, WorktreeTask } from "../../shared/ledger.ts";
import { MAX_TASK_BYTES } from "../../shared/limits.ts";
import { checkEffort, checkModel, effortLabel } from "../../shared/vendors.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { workerWorktreePath } from "../../shared/paths.ts";
import { parseWorkerReport, userToWorkerHeader, workerBranchName, workerLineText, workerReportHeader } from "../../shared/worker.ts";
import { SETUP_RECEIPT_NOTE, setupNote } from "../prompt.ts";
import { fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import type { Db } from "../store/index.ts";
import { exitFailureReason } from "./messages.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";
import { toConversation, toMessage, toWorkerRecord } from "./rows.ts";
import type { ConversationDbRow, MessageDbRow, ProjectDbRow, WorkerDbRow } from "./rows.ts";
import { idle } from "./sessions.ts";
import type { LedgerSessions } from "./sessions.ts";

/** 主文件夹有没提交的改动、又用 worktree 时，start 返回的话里的提醒（m3-plan 第 2.6 节）。 */
export const WORKTREE_DIRTY_NOTE = "注意：主文件夹里有没提交的改动，Worker 是从最后一次提交开始的，看不到这些改动。";
/** 这一轮被用户停止时那一行的原因。 */
export const TURN_STOPPED = "被停止了";
/** 这一轮出错、又没有错误信息时的原因。 */
const TURN_FAILED = "这一轮出错了";
/** 用户的话算 Worker 已收到的状态（user_message 那一行只给这些发）。 */
const RECEIVED_STATUSES: ReadonlySet<string> = new Set(["delivered", "processing", "replied"]);
/** 这一轮正常结束、却一段文字都没有时，交给项目经理的正文。 */
const NO_REPLY_TEXT = "（这一轮没有文字回复）";

/** Worker 对话里项目经理的话的去重键：任务说明一个 Worker 一条；打回、回答每次一条（hub 没有 clientId，用随机数）。 */
const taskDedupeKey = (workerId: WorkerId) => `pm:worker:${workerId}:task`;
const sendDedupeKey = (workerId: WorkerId) => `pm:worker:${workerId}:${randomUUID()}`;

/** Worker 会话这一轮的结局：report 带这一轮最后一段文字，turn_failed 带原因。 */
type TurnOutcome =
  | { event: "report"; turnMessageId: MessageId }
  | { event: "turn_failed"; turnMessageId: MessageId; messageIds: MessageId[]; reason: string };

/**
 * 驱动层事件里“这一轮结束了”的那几种（见 shared/ledger.ts 的 applyDriverEvent）；别的事件、关机、空闲退出是 null。
 * driver.error 带消息编号（写入前校验没过，这些消息不会再发）也算这一轮没做完。
 */
function turnOutcome(event: DriverEvent): TurnOutcome | null {
  if (event.type === "driver.error") {
    const ids = event.messageIds ?? [];
    return ids.length === 0 ? null : { event: "turn_failed", turnMessageId: Math.max(...ids), messageIds: ids, reason: event.message };
  }
  if (event.type !== "turn.ended" && event.type !== "session.exited") return null;
  if (event.messageIds.length === 0) return null;
  const turnMessageId = Math.max(...event.messageIds);
  const { messageIds } = event;
  if (event.type === "turn.ended") {
    // 关机时 SIGINT 结束的一轮：重启后接着做完再汇报（messages.ts 的 resumesAfterShutdown）
    if (event.shutdown === true) return null;
    if (event.interrupted) return { event: "turn_failed", turnMessageId, messageIds, reason: TURN_STOPPED };
    if (!event.ok) {
      const reason = event.error === undefined ? TURN_FAILED : turnFailureReason(event.error);
      return { event: "turn_failed", turnMessageId, messageIds, reason };
    }
    return { event: "report", turnMessageId };
  }
  // 有 result 的那一轮已经按 turn.ended 发过了；关机打断的重启后接着做完再汇报；空闲退出没有在途的消息
  if (event.hadResult) return null;
  if (event.reason === "interrupt") return { event: "turn_failed", turnMessageId, messageIds, reason: TURN_STOPPED };
  if (event.reason === "crash" || event.reason === "startup_failed") {
    return { event: "turn_failed", turnMessageId, messageIds, reason: exitFailureReason(event) };
  }
  return null;
}

/** 在 worktree 里干、还没开工（base_commit 要等 worktree 建好、准备命令跑完才写）。 */
const notStarted = (worker: Pick<WorkerDbRow, "workspace" | "base_commit">) => worker.workspace === "worktree" && worker.base_commit === null;

/**
 * 用户往对话里发消息、重试之前（messages.ts 的 postUserMessage、retryMessage，在事务里）。不是 Worker 的对话什么也不做。
 * 和 hub worker send 的口径一样：已收工拒收；还没开工（notStarted）也拒收，不然用户的话会赶在任务说明前面。
 * 网页用同样的意思判断输入框能不能用（web/selectors.ts 的 workerPhaseOf）。
 */
export function assertWorkerOpenForUser(db: Db, conversationId: ConversationId): void {
  const worker = db.get<Pick<WorkerDbRow, "id" | "status" | "workspace" | "base_commit">>(
    "SELECT id, status, workspace, base_commit FROM workers WHERE worker_conversation_id = ?",
    conversationId,
  );
  if (worker === undefined) return;
  if (worker.status === "ended") throw fail("conflict", `Worker #${worker.id} 已经收工了，不能再给它发消息`);
  if (notStarted(worker)) throw fail("conflict", `Worker 还在准备，等它开工后再发（Worker #${worker.id} 在建 worktree 或跑项目的准备命令）`);
}

/** 给 agent 看的一句“在哪干活”。 */
function describeWorkspace(worker: WorkerDbRow, mainFolder: string): string {
  return worker.workspace === "worktree"
    ? `在 worktree ${worker.worktree_path}（分支 ${worker.branch}）里干活`
    : `直接在项目的主文件夹 ${mainFolder} 里干活`;
}

export type LedgerWorkers = ReturnType<typeof createLedgerWorkers>;

export function createLedgerWorkers(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  messages: LedgerMessages,
  persona: LedgerPersona,
  projects: LedgerProjects,
  options: { worktreesDir: string },
) {
  const { db, now, write, enqueue } = ctx;
  const { currentSession, insertSession, liveOf, updateLive } = sessions;
  const { transition } = messages;
  const { pmRow } = persona;
  const { activeProjectOf, projectCard, syncSessionFolders } = projects;
  const { worktreesDir } = options;
  /**
   * 每个 Worker 会话这一轮开始（message.delivered）时库里最大的消息编号，只在内存里。取这一轮最后一段文字时只看它之后的，
   * 不会拿到上一轮的旧文字（上一轮还在跑时项目经理又发了一句，那一句的编号比上一轮的文字小）。重启后没有，就退回只按
   * 这一轮的消息编号算。
   */
  const turnStarts = new Map<SessionId, MessageId>();

  const workerRow = (id: WorkerId): WorkerDbRow | null => db.get<WorkerDbRow>("SELECT * FROM workers WHERE id = ?", id) ?? null;
  const projectRow = (id: number): ProjectDbRow => db.get<ProjectDbRow>("SELECT * FROM projects WHERE id = ?", id)!;
  /** Worker 的会话（一个 Worker 一个）。 */
  const workerSession = (workerId: WorkerId): AgentSessionRow => currentSession(workerRow(workerId)!.worker_conversation_id)!;
  const mainFolderOf = (projectId: number): string => projectCard(projectRow(projectId)).mainFolder;

  /** 项目经理管着的 Worker：不存在 → not_found；不是它派的 → forbidden。 */
  const ownWorker = (pmId: PmId, workerId: WorkerId): WorkerDbRow => {
    const row = workerRow(workerId);
    if (row === null) throw fail("not_found", `没有编号 ${workerId} 的 Worker`);
    if (row.pm_id !== pmId) throw fail("forbidden", `Worker #${workerId} 不是你派的，管不着`);
    return row;
  };

  const validTask = (raw: unknown, what: string): string => {
    if (typeof raw !== "string" || raw.trim() === "") throw fail("invalid", `${what}不能是空的`);
    if (utf8Bytes(raw) > MAX_TASK_BYTES) throw fail("invalid", `${what}不能超过 ${MAX_TASK_BYTES} 字节`);
    return raw;
  };

  /**
   * 项目经理对话里那一行（WorkerMessageMeta）。deliver：要交给项目经理（report、turn_failed、worktree_failed、user_message），
   * 消息从 queued 起照常走，登记 session.send（source system）；否则只给人看（started、ended）。
   * 去重键带事件类型（workerMessageDedupeKey），重复调用只有一行、只登记一次。
   */
  const insertLine = (
    p: Pending,
    worker: WorkerDbRow,
    line: { event: WorkerEvent; status: WorkerLineStatus | null; summary: string | null; turnMessageId: MessageId | null; deliver: string | null },
  ) => {
    const header = line.event === "user_message" ? userToWorkerHeader(worker.id, worker.title) : workerReportHeader(worker.id, worker.title);
    const meta: WorkerMessageMeta = {
      workerId: worker.id,
      workerConversationId: worker.worker_conversation_id,
      title: worker.title,
      readonly: worker.readonly === 1,
      event: line.event,
      status: line.status,
      summary: line.summary,
    };
    const pmSession = line.deliver === null ? null : currentSession(worker.pm_conversation_id);
    if (line.deliver !== null && pmSession === null) throw new Error(`conversation ${worker.pm_conversation_id} has no agent session`);
    const text = line.deliver === null ? workerLineText(meta) : `${header}\n\n${line.deliver}`;
    const t = now();
    const row = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, ?, 'system', 'worker', ?, ?, ?, ?, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
      worker.pm_conversation_id,
      pmSession?.id ?? null,
      worker.id,
      text,
      JSON.stringify(meta),
      workerMessageDedupeKey(worker.id, line.event, line.turnMessageId),
      pmSession === null ? null : "queued",
      t,
      t,
    );
    if (row === undefined) return;
    p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
    if (pmSession !== null) enqueue(p, { type: "session.send", params: { sessionId: pmSession.id, messageId: row.id, source: "system" } });
  };

  /** Worker 对话里一条项目经理的话（任务说明、打回），和用户消息一样从 queued 起走。 */
  const insertPmMessage = (p: Pending, worker: WorkerDbRow, session: AgentSessionRow, text: string, dedupeKey: string) => {
    const t = now();
    const row = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pm', 'text', ?, ?, 'queued', ?, ?) RETURNING *`,
      worker.worker_conversation_id,
      session.id,
      worker.id,
      text,
      dedupeKey,
      t,
      t,
    )!;
    p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
    return row;
  };

  /**
   * 收工了：Worker 对话里还在排队、没发给它的话标已停止，不会再发（比如 worktree 还没建好就收工了的任务说明）。
   * 已经写进去的那一轮照常跑完、照常汇报。
   */
  const stopQueued = (p: Pending, worker: WorkerDbRow) => {
    for (const row of db.all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND status = 'queued'", worker.worker_conversation_id)) {
      transition(p, row.id, "stopped");
    }
  };

  /** 起 Worker 的会话、把任务说明发给它（主文件夹里干的派活时就做，worktree 的建好了再做）。 */
  const enqueueFirstTurn = (p: Pending, worker: WorkerDbRow) => {
    const session = workerSession(worker.id);
    const task = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", taskDedupeKey(worker.id))!;
    enqueue(p, { type: "session.start", params: { sessionId: session.id, generation: session.generation } });
    enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: task.id, source: "user" } });
  };

  // ---- hub worker …（只给项目经理，见 shared/hub.ts 的 HUB_COMMAND_ROLES）----

  /** git 没跑成时拒绝派活的话（m3-plan 第 2.6 节：不默默改成在主文件夹里干）。 */
  const gitFailed = (error: string) =>
    new Error(`git 没跑成：${error}。可以重试；或者加 --no-worktree，明确让 Worker 在主文件夹里干。`);

  const startIn = (
    p: Pending,
    caller: AgentSessionRow & { pmId: PmId },
    args: HubArgs<"worker.start">,
    context: HubCallContext,
  ): HubResult<"worker.start"> => {
    const project = activeProjectOf(caller.pmId);
    if (project === null) throw fail("invalid", `你还没有项目，没法派 Worker：先用 ${HUB_COMMAND} project create --folder <主文件夹> 建一个`);
    const title = typeof args.title === "string" ? normalizeWorkerTitle(args.title) : null;
    if (title === null) throw fail("invalid", "Worker 的标题不能是空的，也不能带换行等控制字符");
    const task = validTask(args.task, "任务说明");
    // 模型、思考程度按项目经理那家的清单查；不给就用项目经理会话现在的（资料页改过的话是改过的）
    const vendor = caller.vendor as AgentVendor;
    const model = typeof args.model === "string" ? args.model.trim() || null : null;
    const effort = typeof args.effort === "string" ? args.effort.trim() || null : null;
    const badSetting = checkModel(vendor, model) ?? checkEffort(vendor, effort);
    if (badSetting !== null) throw fail("invalid", badSetting);
    const readonly = args.readonly === true;
    const card = projectCard(project);
    let probe = { isRepoWithCommit: false, hasUncommittedChanges: false };
    if (args.noWorktree !== true) {
      const workspaceProbe = context.workspace;
      if (workspaceProbe === undefined) throw new Error("worker.start without noWorktree needs context.workspace (probe the main folder first)");
      if (workspaceProbe.kind === "failed") throw gitFailed(workspaceProbe.error);
      probe = workspaceProbe;
    }
    const workspace = probe.isRepoWithCommit ? "worktree" : "main";
    const t = now();

    const conversation = toConversation(
      db.get<ConversationDbRow>(
        "INSERT INTO conversations (kind, pm_id, project_id, title, created_at) VALUES ('worker', ?, ?, ?, ?) RETURNING *",
        caller.pmId,
        project.id,
        title,
        t,
      )!,
    );
    p.changes.push({ type: "conversation.created", data: { conversation } });
    // 编号要先有才能定分支和目录：worktree 的先占个空串（满足 CHECK），马上改成真的
    const id = db.run(
      `INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, model, effort, readonly, workspace,
                            branch, worktree_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      project.id,
      caller.pmId,
      project.conversation_id,
      conversation.id,
      title,
      task,
      model,
      effort,
      readonly ? 1 : 0,
      workspace,
      workspace === "worktree" ? "" : null,
      workspace === "worktree" ? "" : null,
      t,
      t,
    ).lastInsertRowid;
    if (workspace === "worktree") {
      db.run(
        "UPDATE workers SET branch = ?, worktree_path = ? WHERE id = ?",
        workerBranchName(id, title),
        workerWorktreePath(worktreesDir, project.id, id),
        id,
      );
    }
    const worker = workerRow(id)!;
    const session = insertSession(p, {
      role: "worker",
      conversationId: conversation.id,
      pmId: null,
      workerId: id,
      cwd: worker.worktree_path ?? card.mainFolder,
      addDirs: workspace === "worktree" ? [] : card.otherFolders,
      generation: 1,
      vendor,
      model: model ?? caller.model,
      effort: effort ?? caller.effort,
    });
    insertPmMessage(p, worker, session, task, taskDedupeKey(id));
    insertLine(p, worker, { event: "started", status: null, summary: null, turnMessageId: null, deliver: null });
    if (workspace === "worktree") {
      enqueue(p, { type: "worktree.create", params: { workerId: id } });
      // 项目经理的会话带上 worktrees/<项目编号>/，验收时能看 Worker 的改动（下一条消息前自动重启生效）
      syncSessionFolders(project);
    } else {
      enqueueFirstTurn(p, worker);
    }

    const notes = [`已派出 Worker #${id}“${title}”，${describeWorkspace(worker, card.mainFolder)}`];
    if (workspace === "main" && args.noWorktree !== true) notes.push("（主文件夹不是有提交的 git 仓库，所以没建 worktree）");
    if (readonly) notes.push("。它是只读的，只看不改");
    notes.push(`。它每做完一轮，汇报会自动发给你；打回用 ${HUB_COMMAND} worker send ${id} --stdin，收工用 ${HUB_COMMAND} worker end ${id}。`);
    if (workspace === "worktree" && project.setup_command !== null) notes.push(SETUP_RECEIPT_NOTE);
    if (workspace === "worktree" && probe.hasUncommittedChanges) notes.push(WORKTREE_DIRTY_NOTE);
    return { text: notes.join(""), data: { worker: toWorkerRecord(worker) } };
  };

  const sendIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"worker.send">): HubResult<"worker.send"> => {
    const worker = ownWorker(caller.pmId, args.workerId);
    if (worker.status === "ended") throw fail("conflict", `Worker #${worker.id} 已经收工了，要接着做请重新派一个`);
    // 还没开工（在建 worktree、跑准备命令）：第一轮必须是任务说明，现在发的话会让会话提前起来
    if (notStarted(worker)) throw fail("conflict", `Worker 还在准备，等它开工后再发（Worker #${worker.id} 在建 worktree 或跑项目的准备命令）`);
    const text = validTask(args.text, "要发给 Worker 的话");
    const message = insertPmMessage(p, worker, workerSession(worker.id), text, sendDedupeKey(worker.id));
    enqueue(p, { type: "session.send", params: { sessionId: message.session_id!, messageId: message.id, source: "user" } });
    return {
      text: `已发给 Worker #${worker.id}“${worker.title}”，它会接着做，做完一轮汇报会自动发给你。`,
      data: { worker: toWorkerRecord(worker), messageId: message.id },
    };
  };

  const endIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"worker.end">): HubResult<"worker.end"> => {
    const worker = ownWorker(caller.pmId, args.workerId);
    if (worker.status === "ended") {
      return { text: `Worker #${worker.id}“${worker.title}”已经收工了，什么也没做。`, data: { worker: toWorkerRecord(worker) } };
    }
    const session = workerSession(worker.id);
    db.run("UPDATE workers SET status = 'ended', updated_at = ? WHERE id = ?", now(), worker.id);
    const ended = workerRow(worker.id)!;
    // 正在跑就等这一轮回完再关，然后作废令牌（session.end 的处理函数）
    enqueue(p, { type: "session.end", params: { sessionId: session.id, generation: session.generation } });
    stopQueued(p, ended);
    insertLine(p, ended, { event: "ended", status: null, summary: null, turnMessageId: null, deliver: null });
    const cleanup =
      ended.workspace === "worktree"
        ? ` worktree ${ended.worktree_path} 和分支 ${ended.branch} 还在：合并完用 git worktree remove ${ended.worktree_path} 删掉 worktree。`
        : "";
    return { text: `Worker #${ended.id}“${ended.title}”已收工。${cleanup}`, data: { worker: toWorkerRecord(ended) } };
  };

  const list = (caller: AgentSessionRow & { pmId: PmId }): HubResult<"worker.list"> => {
    const rows = db.all<WorkerDbRow>("SELECT * FROM workers WHERE pm_id = ? ORDER BY id", caller.pmId);
    if (rows.length === 0) return { text: "你还没有派过 Worker。", data: { workers: [] } };
    const lines = rows.map((w) => {
      const where = w.workspace === "worktree" ? `worktree ${w.worktree_path}（分支 ${w.branch}）` : "主文件夹";
      const state = w.status === "ended" ? "已收工" : liveOf(workerSession(w.id).id).activity === "preparing" ? "准备中" : "进行中";
      // 实际用的：会话那一行（--model、--effort 没给时是派活时项目经理的）
      const session = workerSession(w.id);
      const setting = `模型 ${ctx.modelLabel(session.vendor as AgentVendor, session.model)} · 思考程度 ${effortLabel(session.effort)}`;
      return `#${w.id} ${w.title} · ${state} · ${where} · ${setting}${w.readonly === 1 ? " · 只读" : ""}`;
    });
    return { text: `你派出的 Worker：\n${lines.join("\n")}`, data: { workers: rows.map(toWorkerRecord) } };
  };

  /** Worker 调 hub status：我是哪个 Worker、任务是什么、在哪干活。 */
  const status = (caller: AgentSessionRow): HubResult<"status"> => {
    const worker = workerRow(caller.workerId!)!;
    const pm = pmRow(worker.pm_id)!;
    const card = projectCard(projectRow(worker.project_id));
    const data: WorkerHubStatus = {
      role: "worker",
      pm: { id: pm.id, name: pm.name },
      sessionId: caller.id,
      conversationId: worker.worker_conversation_id,
      worker: toWorkerRecord(worker),
      project: card,
    };
    const readonly = worker.readonly === 1 ? "只读（只看不改），" : "";
    const text =
      `你是 Worker #${worker.id}“${worker.title}”，项目经理“${pm.name}”派的，${readonly}${describeWorkspace(worker, card.mainFolder)}。` +
      `\n\n任务说明：\n${worker.task}`;
    return { text, data };
  };

  // ---- 驱动层事件：Worker 这一轮结束 ----

  /** 在 applyDriverEvent 的同一个事务里、消息状态改完之后调。不是 Worker 的会话、不是一轮结束，什么也不做。 */
  /**
   * 这一轮没做完：一行 turn_failed，原因交给项目经理。去重键是这一轮（或发不出去的那条）消息的编号。
   * 这一轮里有用户直接对 Worker 说的话：带上原文；标了失败的写明用户那边可以自己点重试（不用项目经理转告）。
   */
  const insertTurnFailed = (p: Pending, worker: WorkerDbRow, turnMessageId: MessageId, messageIds: MessageId[], reason: string) => {
    const lines = [`这一轮没做完：${reason}。要它接着做用 ${HUB_COMMAND} worker send ${worker.id} --stdin，不要了用 ${HUB_COMMAND} worker end ${worker.id}。`];
    for (const id of messageIds) {
      const message = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
      if (message === undefined || message.sender !== "user" || message.worker_id !== worker.id) continue;
      const retry = message.status === "failed" ? "用户那边会看到发送失败，可以自己点重试。" : "";
      lines.push(`这一轮里有用户直接对它说的话：「${message.text}」。${retry}`);
    }
    insertLine(p, worker, { event: "turn_failed", status: null, summary: reason, turnMessageId, deliver: lines.join("\n") });
  };

  /**
   * Worker 收到了用户直接对它说的话（message.delivered）：每条一行 user_message，原文交给项目经理（不打断它，系统消息
   * 等它空闲再发）。只认 Worker 对话里带 Worker 编号的用户消息，而且真的写进去了（已送达、处理中、已回复；已停止、失败的
   * 不算）；重启后重发再送达，去重键挡住，不会出两行。
   */
  const insertUserMessageLines = (p: Pending, workerId: WorkerId, messageIds: MessageId[]) => {
    const worker = workerRow(workerId);
    if (worker === null) return;
    for (const id of messageIds) {
      const message = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
      if (message === undefined || message.sender !== "user" || message.worker_id !== workerId) continue;
      if (!RECEIVED_STATUSES.has(message.status ?? "")) continue;
      // 交给项目经理的带上附件的完整路径（和写给 Worker 的一样，见 shared/attachments.ts 的 agentTextOf）
      const deliver = agentTextOf(toMessage(message));
      insertLine(p, worker, { event: "user_message", status: null, summary: message.text, turnMessageId: id, deliver });
    }
  };

  const afterDriverEvent = (p: Pending, session: AgentSessionRow, event: DriverEvent) => {
    if (session.role !== "worker" || session.workerId === null) return;
    if (event.type === "message.delivered") {
      turnStarts.set(session.id, db.get<{ id: number | null }>("SELECT max(id) AS id FROM messages")!.id ?? 0);
      insertUserMessageLines(p, session.workerId, event.messageIds);
      return;
    }
    const outcome = turnOutcome(event);
    if (outcome === null) return;
    const worker = workerRow(session.workerId);
    if (worker === null) return;
    const turnStart = Math.max(outcome.turnMessageId, turnStarts.get(session.id) ?? 0);
    turnStarts.delete(session.id);
    if (outcome.event === "turn_failed") {
      insertTurnFailed(p, worker, outcome.turnMessageId, outcome.messageIds, outcome.reason);
      return;
    }
    // 这一轮最后一段文字：这一轮开始之后、这个会话的 agent 文字里最新的一条；没有就是“没有文字回复”
    const last = db.get<{ text: string }>(
      `SELECT text FROM messages WHERE session_id = ? AND sender = 'agent' AND kind = 'text' AND id > ? ORDER BY id DESC LIMIT 1`,
      session.id,
      turnStart,
    );
    const text = last?.text ?? "";
    const parsed = parseWorkerReport(text);
    insertLine(p, worker, {
      event: "report",
      status: parsed.kind === "ok" ? parsed.report.status : "unformatted",
      summary: parsed.kind === "ok" ? parsed.report.summary : parsed.summary,
      turnMessageId: outcome.turnMessageId,
      deliver: text.trim() === "" ? NO_REPLY_TEXT : text,
    });
  };

  // ---- 建 worktree（worktree.create 处理函数用）----

  const getWorktreeTask = (workerId: WorkerId): WorktreeTask | null => {
    const worker = workerRow(workerId);
    if (worker === null || worker.workspace !== "worktree") return null;
    return {
      workerId,
      sessionId: workerSession(workerId).id,
      repo: mainFolderOf(worker.project_id),
      branch: worker.branch!,
      worktreePath: worker.worktree_path!,
      status: worker.status as WorktreeTask["status"],
      setupCommand: projectRow(worker.project_id).setup_command,
    };
  };

  /**
   * 准备命令开始跑：Worker 的会话显示“准备中”（网页的状态行、hub worker list）。返回真的进了准备中没有：
   * Worker 不在了、已收工（比如建 worktree 的时候收工了）、已经开工的不改，返回 false，调用方就不跑准备命令。
   */
  const onSetupStarted = (workerId: WorkerId): boolean =>
    write((p) => {
      const worker = workerRow(workerId);
      if (worker === null || worker.workspace !== "worktree" || worker.status === "ended" || worker.base_commit !== null) return false;
      updateLive(p, workerSession(workerId).id, (l) => {
        l.activity = "preparing";
        l.currentTool = null;
        l.step = null;
      });
      return true;
    });

  /**
   * session.send 处理函数问（兜底，不管消息从哪来）：这条消息要不要先等着，免得 Worker 的会话被它提前拉起来、第一轮不是任务说明。
   * Worker 的会话、Worker 还开着时：还没开工（worktree 没建好、准备命令在跑）→ 什么都等；开工了、任务说明还在排队 → 除了任务说明都等。
   */
  const waitsForFirstTurn = (sessionId: SessionId, messageId: MessageId): boolean => {
    const workerId = db.get<{ worker_id: number | null }>("SELECT worker_id FROM agent_sessions WHERE id = ?", sessionId)?.worker_id ?? null;
    const worker = workerId === null ? null : workerRow(workerId);
    if (worker === null || worker.status === "ended") return false;
    if (notStarted(worker)) return true;
    const task = db.get<{ id: number; status: string }>("SELECT id, status FROM messages WHERE dedupe_key = ?", taskDedupeKey(worker.id));
    return task !== undefined && task.status === "queued" && task.id !== messageId;
  };

  /**
   * base_commit 和第一轮的两个动作在同一个事务里写，所以 base_commit 已经有了就说明做过了，重复调用什么也不做。
   * setup：准备命令跑完的结果，加在任务说明（Worker 对话里第一条消息）前面，推 message.updated；workers.task 留原文。
   * 准备中、正在停（网页上点了停止）的状态先回到空闲，收工了也一样。
   */
  const onWorktreeCreated = (workerId: WorkerId, baseCommit: string, setup?: SetupOutcome) => {
    write((p) => {
      const worker = workerRow(workerId);
      if (worker === null || worker.workspace !== "worktree" || worker.base_commit !== null) return;
      // 还没开工，会话没起过：准备中、正在停只可能是准备命令那段留下的
      const sessionId = workerSession(workerId).id;
      const activity = liveOf(sessionId).activity;
      if (activity === "preparing" || activity === "stopping") updateLive(p, sessionId, idle);
      if (worker.status === "ended") return;
      db.run("UPDATE workers SET base_commit = ?, updated_at = ? WHERE id = ?", baseCommit, now(), workerId);
      if (setup !== undefined) {
        const task = db.get<MessageDbRow>("SELECT * FROM messages WHERE dedupe_key = ?", taskDedupeKey(workerId))!;
        const row = db.get<MessageDbRow>(
          "UPDATE messages SET text = ?, updated_at = ? WHERE id = ? RETURNING *",
          `${setupNote(setup)}\n\n${task.text}`,
          now(),
          task.id,
        )!;
        p.changes.push({ type: "message.updated", data: { message: toMessage(row) } });
      }
      enqueueFirstTurn(p, worker);
    });
  };

  /**
   * 重启恢复（在 recoverAfterRestart 里调）：还没开工的 worktree Worker（open、base_commit 还是 NULL：worktree 没建完，
   * 或者准备命令被关机打断了）重新登记 worktree.create。done 的那一行按 NewAction 的规则重置成 pending；
   * addWorktree 重复执行算成功，准备命令从头再跑。返回登记了哪些 Worker。
   */
  const recoverWorktrees = (): WorkerId[] =>
    write((p) => {
      const ids = db
        .all<{ id: number }>("SELECT id FROM workers WHERE status = 'open' AND workspace = 'worktree' AND base_commit IS NULL ORDER BY id")
        .map((r) => r.id);
      for (const id of ids) enqueue(p, { type: "worktree.create", params: { workerId: id } });
      return ids;
    });

  /**
   * 动作彻底失败（ledger.onActionFailed，在同一个事务里、messages.ts 改完消息状态之后调）：
   * - worktree.create：Worker 标 ended、登记它会话的 session.end（同 endIn），项目经理对话里一行 worktree_failed 并交给它，
   *   任务说明标 failed；
   * - session.send 发的是 Worker 对话里项目经理或用户的话（Worker 起不来、消息写不进去）：一行 turn_failed 交给项目经理。
   *   Worker 已经收工的不发（收工后发不出去是意料之中的）。
   */
  const actionFailedIn = (p: Pending, action: AnyActionRow, error: string) => {
    if (action.type === "worktree.create") {
      const worker = workerRow(action.params.workerId);
      if (worker === null) return;
      if (worker.status !== "ended") {
        db.run("UPDATE workers SET status = 'ended', updated_at = ? WHERE id = ?", now(), worker.id);
        const session = workerSession(worker.id);
        enqueue(p, { type: "session.end", params: { sessionId: session.id, generation: session.generation } });
      }
      const deliver = `建 worktree 失败，这个 Worker 没能开工，已经收工：${error}。要的话修好问题后重新派一个。`;
      insertLine(p, workerRow(worker.id)!, { event: "worktree_failed", status: null, summary: error, turnMessageId: null, deliver });
      const task = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", taskDedupeKey(worker.id));
      if (task !== undefined) transition(p, task.id, "failed", error);
      return;
    }
    if (action.type !== "session.send") return;
    const message = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", action.params.messageId);
    if (message === undefined || (message.sender !== "pm" && message.sender !== "user") || message.worker_id === null) return;
    const worker = workerRow(message.worker_id);
    if (worker === null || worker.status === "ended") return;
    insertTurnFailed(p, worker, message.id, [message.id], error);
  };

  /** agent 接口在 worker.start 之前探 git 用：这个会话所属项目经理的项目主文件夹；不是项目经理的会话、还没有项目 → null。 */
  const workerStartFolder = (session: AgentSessionRow | null): string | null => {
    if (session === null || session.role !== "pm" || session.pmId === null) return null;
    const project = activeProjectOf(session.pmId);
    return project === null ? null : projectCard(project).mainFolder;
  };

  // ---- 启动上下文 ----

  /** Worker 会话的 LaunchContext（见 shared/ledger.ts）；不是 Worker 的会话返回 null。 */
  const launchContextFor = (session: AgentSessionRow): LaunchContext | null => {
    if (session.role !== "worker" || session.workerId === null) return null;
    const worker = workerRow(session.workerId);
    if (worker === null) return null;
    const pm = pmRow(worker.pm_id)!;
    return {
      sessionId: session.id,
      role: "worker",
      conversationId: worker.worker_conversation_id,
      pm: { id: pm.id, name: pm.name, mode: pm.mode as PmMode, persona: personaOrTemplate(pm.persona) },
      project: projectCard(projectRow(worker.project_id)),
      worker: toWorkerRecord(worker),
    };
  };

  return {
    startIn,
    sendIn,
    endIn,
    list,
    status,
    afterDriverEvent,
    getWorktreeTask,
    onSetupStarted,
    waitsForFirstTurn,
    onWorktreeCreated,
    recoverWorktrees,
    actionFailedIn,
    workerStartFolder,
    launchContextFor,
  };
}

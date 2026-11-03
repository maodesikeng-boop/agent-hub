// 账本里的 Worker（M3，m3-plan 第 2、3 节）：Worker 的账本逻辑都在这里。
// - hub worker start / send / end / list，Worker 调 hub status；
// - 在哪干活：主文件夹是有提交的 git 仓库、又没给 --no-worktree → worktree（登记 worktree.create，建好了再起会话），
//   否则直接在主文件夹里干（直接登记 session.start 和第一条 session.send）；
// - Worker 的会话每一轮结束，在同一个事务里给项目经理的对话发那一行（kind worker），并把全文交给项目经理（session.send）；
// - 建 worktree 的两个回调（getWorktreeTask、onWorktreeCreated）和彻底失败（onWorktreeFailed）；
// - Worker 会话的启动上下文。
// 汇报格式、解析、那一行的写法、分支名在 shared/worker.ts；按角色放行的表在 shared/hub.ts；git 在 daemon/git/。
import { randomUUID } from "node:crypto";
import type { ActionRow } from "../../shared/actions.ts";
import { normalizeWorkerTitle, personaOrTemplate, utf8Bytes, workerMessageDedupeKey } from "../../shared/domain.ts";
import type {
  AgentSessionRow,
  MessageId,
  PmId,
  PmMode,
  WorkerEvent,
  WorkerId,
  WorkerLineStatus,
  WorkerMessageMeta,
  WorkerRecord,
} from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { HubArgs, HubResult, WorkerHubStatus } from "../../shared/hub.ts";
import type { LaunchContext, WorktreeTask } from "../../shared/ledger.ts";
import { MAX_MODEL_CHARS, MAX_TASK_BYTES } from "../../shared/limits.ts";
import { workerWorktreePath } from "../../shared/paths.ts";
import { parseWorkerReport, workerBranchName, workerLineText, workerReportHeader } from "../../shared/worker.ts";
import { hasUncommittedChangesSync, isRepoWithCommitSync } from "../git/index.ts";
import { fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { exitFailureReason } from "./messages.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";
import { toConversation, toMessage, toWorkerRecord } from "./rows.ts";
import type { ConversationDbRow, MessageDbRow, ProjectDbRow, WorkerDbRow } from "./rows.ts";
import type { LedgerSessions } from "./sessions.ts";

/**
 * hub worker start 判断在哪干活要用的两个 git 判断，同步的（hubCall 是同步接口）。
 * 账本的构造参数（LedgerOptions.git），默认用 daemon/git 的同步版，测试换假的。
 */
export interface WorkerGit {
  /** 是有提交的 git 仓库（m3-plan 第 2.6 节：git -C <主文件夹> rev-parse --verify HEAD 成功）。 */
  isRepoWithCommit(folder: string): boolean;
  /** 有没提交的改动：只用来在 start 返回的话里多一句提醒。 */
  hasUncommittedChanges(folder: string): boolean;
}

export const defaultWorkerGit: WorkerGit = {
  isRepoWithCommit: (folder) => isRepoWithCommitSync(folder),
  hasUncommittedChanges: (folder) => hasUncommittedChangesSync(folder),
};

/** 主文件夹有没提交的改动、又用 worktree 时，start 返回的话里的提醒（m3-plan 第 2.6 节）。 */
export const WORKTREE_DIRTY_NOTE = "注意：主文件夹里有没提交的改动，Worker 是从最后一次提交开始的，看不到这些改动。";
/** 这一轮被用户停止时那一行的原因。 */
export const TURN_STOPPED = "被停止了";
/** 这一轮出错、又没有错误信息时的原因。 */
const TURN_FAILED = "这一轮出错了";
/** 这一轮正常结束、却一段文字都没有时，交给项目经理的正文。 */
const NO_REPLY_TEXT = "（这一轮没有文字回复）";

/** Worker 对话里项目经理的话的去重键：任务说明一个 Worker 一条；打回、回答每次一条（hub 没有 clientId，用随机数）。 */
const taskDedupeKey = (workerId: WorkerId) => `pm:worker:${workerId}:task`;
const sendDedupeKey = (workerId: WorkerId) => `pm:worker:${workerId}:${randomUUID()}`;

/** Worker 会话这一轮的结局：report 带这一轮最后一段文字，turn_failed 带原因。 */
type TurnOutcome = { event: "report"; turnMessageId: MessageId } | { event: "turn_failed"; turnMessageId: MessageId; reason: string };

/** 驱动层事件里“这一轮结束了”的那几种（见 shared/ledger.ts 的 applyDriverEvent）；别的事件、关机、空闲退出是 null。 */
function turnOutcome(event: DriverEvent): TurnOutcome | null {
  if (event.type !== "turn.ended" && event.type !== "session.exited") return null;
  if (event.messageIds.length === 0) return null;
  const turnMessageId = Math.max(...event.messageIds);
  if (event.type === "turn.ended") {
    if (event.interrupted) return { event: "turn_failed", turnMessageId, reason: TURN_STOPPED };
    if (!event.ok) {
      const reason = event.error === undefined ? TURN_FAILED : `${event.error.subtype}: ${event.error.message}`;
      return { event: "turn_failed", turnMessageId, reason };
    }
    return { event: "report", turnMessageId };
  }
  // 有 result 的那一轮已经按 turn.ended 发过了；关机打断的重启后接着做完再汇报；空闲退出没有在途的消息
  if (event.hadResult) return null;
  if (event.reason === "interrupt") return { event: "turn_failed", turnMessageId, reason: TURN_STOPPED };
  if (event.reason === "crash" || event.reason === "startup_failed") return { event: "turn_failed", turnMessageId, reason: exitFailureReason(event) };
  return null;
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
  options: { worktreesDir: string; git: WorkerGit },
) {
  const { db, now, write, enqueue } = ctx;
  const { currentSession, insertSession } = sessions;
  const { transition } = messages;
  const { pmRow } = persona;
  const { activeProjectOf, projectCard, syncSessionFolders } = projects;
  const { worktreesDir, git } = options;

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
   * 项目经理对话里那一行（WorkerMessageMeta）。deliver：要交给项目经理（report、turn_failed、worktree_failed），
   * 消息从 queued 起照常走，登记 session.send（source system）；否则只给人看（started、ended）。
   * 去重键带事件类型（workerMessageDedupeKey），重复调用只有一行、只登记一次。
   */
  const insertLine = (
    p: Pending,
    worker: WorkerDbRow,
    line: { event: WorkerEvent; status: WorkerLineStatus | null; summary: string | null; turnMessageId: MessageId | null; deliver: string | null },
  ) => {
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
    const text = line.deliver === null ? workerLineText(meta) : `${workerReportHeader(worker.id, worker.title)}\n\n${line.deliver}`;
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

  /** 起 Worker 的会话、把任务说明发给它（主文件夹里干的派活时就做，worktree 的建好了再做）。 */
  const enqueueFirstTurn = (p: Pending, worker: WorkerDbRow) => {
    const session = workerSession(worker.id);
    const task = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", taskDedupeKey(worker.id))!;
    enqueue(p, { type: "session.start", params: { sessionId: session.id, generation: session.generation } });
    enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: task.id, source: "user" } });
  };

  // ---- hub worker …（只给项目经理，见 shared/hub.ts 的 HUB_COMMAND_ROLES）----

  const startIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"worker.start">): HubResult<"worker.start"> => {
    const project = activeProjectOf(caller.pmId);
    if (project === null) throw fail("invalid", "你还没有项目，没法派 Worker：先用 hub project create --folder <主文件夹> 建一个");
    const title = typeof args.title === "string" ? normalizeWorkerTitle(args.title) : null;
    if (title === null) throw fail("invalid", "Worker 的标题不能是空的，也不能带换行等控制字符");
    const task = validTask(args.task, "任务说明");
    const model = typeof args.model === "string" ? args.model.trim() || null : null;
    if (model !== null && [...model].length > MAX_MODEL_CHARS) throw fail("invalid", `模型名最多 ${MAX_MODEL_CHARS} 个字`);
    const readonly = args.readonly === true;
    const card = projectCard(project);
    const isRepo = git.isRepoWithCommit(card.mainFolder);
    const workspace = isRepo && args.noWorktree !== true ? "worktree" : "main";
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
      `INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, model, readonly, workspace,
                            branch, worktree_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      project.id,
      caller.pmId,
      project.conversation_id,
      conversation.id,
      title,
      task,
      model,
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
      model: model ?? caller.model,
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
    notes.push(`。它每做完一轮，汇报会自动发给你；打回用 hub worker send ${id} --stdin，收工用 hub worker end ${id}。`);
    if (workspace === "worktree" && git.hasUncommittedChanges(card.mainFolder)) notes.push(WORKTREE_DIRTY_NOTE);
    return { text: notes.join(""), data: { worker: toWorkerRecord(worker) } };
  };

  const sendIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"worker.send">): HubResult<"worker.send"> => {
    const worker = ownWorker(caller.pmId, args.workerId);
    if (worker.status === "ended") throw fail("conflict", `Worker #${worker.id} 已经收工了，要接着做请重新派一个`);
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
      return `#${w.id} ${w.title} · ${w.status === "open" ? "进行中" : "已收工"} · ${where}${w.readonly === 1 ? " · 只读" : ""}`;
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
  const afterDriverEvent = (p: Pending, session: AgentSessionRow, event: DriverEvent) => {
    if (session.role !== "worker" || session.workerId === null) return;
    const outcome = turnOutcome(event);
    if (outcome === null) return;
    const worker = workerRow(session.workerId);
    if (worker === null) return;
    if (outcome.event === "turn_failed") {
      const deliver = `这一轮没做完：${outcome.reason}。要它接着做用 hub worker send ${worker.id} --stdin，不要了用 hub worker end ${worker.id}。`;
      insertLine(p, worker, { event: "turn_failed", status: null, summary: outcome.reason, turnMessageId: outcome.turnMessageId, deliver });
      return;
    }
    // 这一轮最后一段文字：这一轮的消息之后、这个会话的 agent 文字里最新的一条
    const last = db.get<{ text: string }>(
      `SELECT text FROM messages WHERE session_id = ? AND sender = 'agent' AND kind = 'text' AND id > ? ORDER BY id DESC LIMIT 1`,
      session.id,
      outcome.turnMessageId,
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
      repo: mainFolderOf(worker.project_id),
      branch: worker.branch!,
      worktreePath: worker.worktree_path!,
      status: worker.status as WorktreeTask["status"],
    };
  };

  /** base_commit 和第一轮的两个动作在同一个事务里写，所以 base_commit 已经有了就说明做过了，重复调用什么也不做。 */
  const onWorktreeCreated = (workerId: WorkerId, baseCommit: string) => {
    write((p) => {
      const worker = workerRow(workerId);
      if (worker === null || worker.workspace !== "worktree" || worker.status === "ended" || worker.base_commit !== null) return;
      db.run("UPDATE workers SET base_commit = ?, updated_at = ? WHERE id = ?", baseCommit, now(), workerId);
      enqueueFirstTurn(p, worker);
    });
  };

  /** worktree.create 彻底失败：Worker 标 ended，项目经理对话里一行 worktree_failed 并交给它，任务说明标 failed。 */
  const onWorktreeFailed = (action: ActionRow<"worktree.create">, error: string) => {
    write((p) => {
      const worker = workerRow(action.params.workerId);
      if (worker === null) return;
      if (worker.status !== "ended") db.run("UPDATE workers SET status = 'ended', updated_at = ? WHERE id = ?", now(), worker.id);
      const deliver = `建 worktree 失败，这个 Worker 没能开工，已经收工：${error}。要的话修好问题后重新派一个。`;
      insertLine(p, workerRow(worker.id)!, { event: "worktree_failed", status: null, summary: error, turnMessageId: null, deliver });
      const task = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", taskDedupeKey(worker.id));
      if (task !== undefined) transition(p, task.id, "failed", error);
    });
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
    onWorktreeCreated,
    onWorktreeFailed,
    launchContextFor,
  };
}

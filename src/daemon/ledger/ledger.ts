// 账本（设计第 6.2 节）：业务表的唯一写者。每个命令一个事务，提交之后才推变化、通知新登记的动作。
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AnyActionRow, NewAction } from "../../shared/actions.ts";
import type { Change, ChangeType, ConversationSnapshot, MessagesPage, StateSnapshot } from "../../shared/api.ts";
import {
  PM_MODES,
  PM_MODE_LABELS,
  SYSTEM_MESSAGE_PREFIX,
  agentMessageDedupeKey,
  canTransitionMessage,
  isOneOf,
  normalizeName,
  personaOrTemplate,
  systemMessageDedupeKey,
  userMessageDedupeKey,
  utf8Bytes,
} from "../../shared/domain.ts";
import type {
  AgentSessionRow,
  ConversationId,
  HealthModule,
  Message,
  MessageId,
  MessageStatus,
  PersonaChange,
  PersonaChangeId,
  PmId,
  PmMode,
  Project,
  ProjectFolder,
  ProjectId,
  RateLimitInfo,
  SessionActivity,
  SessionId,
  SessionState,
  SystemMessageMeta,
} from "../../shared/domain.ts";
import type { DriverEvent, SessionExitedEvent } from "../../shared/driver.ts";
import type { HubArgs, HubCommand, HubData, HubResult, ProjectCard } from "../../shared/hub.ts";
import { ConversationNotFoundError, LedgerRequestError } from "../../shared/ledger.ts";
import type {
  CreatePmInput,
  CreatePmResult,
  CreateProjectInput,
  CreateProjectResult,
  EditPersonaInput,
  EditPersonaResult,
  LaunchContext,
  Ledger,
  LedgerActor,
  LedgerErrorCode,
  PersonaView,
  PostUserMessageInput,
  ResolveFolder,
  SyncPersonaFilesResult,
} from "../../shared/ledger.ts";
import {
  CHANGE_BUFFER_SIZE,
  MAX_DESCRIPTION_CHARS,
  MAX_HANDOFF_BYTES,
  MAX_MODEL_CHARS,
  MAX_NAME_CHARS,
  MAX_PERSONA_BYTES,
  MAX_REASON_CHARS,
  MESSAGE_PAGE_SIZE,
  PERSONA_CHANGES_LIMIT,
} from "../../shared/limits.ts";
import { handoffFilePath, personaFilePath } from "../../shared/paths.ts";
import { enqueueAction } from "../actions/index.ts";
import { getAgentSession, toAgentSessionRow } from "../store/index.ts";
import type { AgentSessionDbRow, Db } from "../store/index.ts";
import { createChangeLog } from "./change-log.ts";
import type { ChangeInput } from "./change-log.ts";
import {
  contentHash,
  createResolveFolder,
  realpathOrLiteral,
  summarizeArgs,
  truncateField,
  writeFileAtomic as defaultWriteFileAtomic,
} from "./files.ts";
import {
  toConversation,
  toHandoff,
  toHealth,
  toMessage,
  toPersonaChange,
  toPm,
  toProject,
  toProjectFolder,
} from "./rows.ts";
import type {
  ConversationDbRow,
  HandoffDbRow,
  HealthDbRow,
  MessageDbRow,
  PersonaChangeDbRow,
  PmDbRow,
  ProjectDbRow,
  ProjectFolderDbRow,
} from "./rows.ts";
import { summarizeToolCall } from "./tool-summary.ts";

export type SqliteLedger = Ledger;

export interface LedgerOptions {
  now?: () => number;
  /** 本次启动的初始 seq，默认启动时刻的毫秒时间戳（比上次运行用过的都大）。 */
  initialSeq?: number;
  changeBufferSize?: number;
  /** pm-home/ 的根目录；项目经理私聊的工作目录是 <pmHomeRoot>/<项目经理编号>/，createPm 负责建。必填。 */
  pmHomeRoot: string;
  /**
   * state/personas/（HubPaths.personasDir）。不给就不写、不同步性格设定文件（只给不碰性格设定的旧测试用），
   * 正文照样以数据库为准。守护进程一定要给。
   */
  personasDir?: string;
  /** state/handoffs/（HubPaths.handoffsDir）。不给的话 project.assign 报错（写不了交接文件）。守护进程一定要给。 */
  handoffsDir?: string;
  /** 数据目录（HubPaths.home），默认 resolveFolder 用它拒绝数据目录里的文件夹。默认 pmHomeRoot 的上一级（同 HubPaths 的布局）。 */
  dataHome?: string;
  /** 展开 `~` 用（默认 resolveFolder、detach 退回字面路径时），默认 os.homedir()。 */
  userHome?: string;
  /** 文件夹校验，默认 createResolveFolder({ dataHome, userHome })。 */
  resolveFolder?: ResolveFolder;
  /** 写性格设定、交接文件（临时文件 + 改名）。测试换成会失败的。 */
  writeFileAtomic?: (file: string, content: string) => void;
}

type StopEvent = { conversationId: ConversationId; sessionId: SessionId };

/** 一个事务里攒下的、提交后才发出去的东西；回滚就整个丢掉。 */
interface Pending {
  changes: ChangeInput[];
  actions: AnyActionRow[];
  stops: StopEvent[];
  /** 这个事务里推出去的会话状态（比较用的键），提交后才记进 pushed。 */
  pushed: Map<SessionId, string>;
  /** 提交之后要做的事（写性格设定文件），在推变化之前做；出错只记日志。 */
  after: (() => void)[];
  /** 回滚时要撤掉的东西（事务里已经写好的交接文件）。 */
  undo: (() => void)[];
}

/** 一个事务里几条变化的推送顺序（见 api.ts 的 CHANGE_TYPES）。 */
const CHANGE_RANK: Readonly<Record<ChangeType, number>> = {
  "pm.created": 0,
  "pm.updated": 0,
  "project.created": 1,
  "project.updated": 1,
  "conversation.created": 2,
  "session.created": 3,
  "folders.updated": 4,
  "message.created": 5,
  "message.updated": 5,
  "session.status": 6,
  "health.updated": 7,
};

/** 性格设定的这次修改是谁做的（账本内部用）。 */
type PersonaEditor = { actor: "user" } | { actor: "file" } | { actor: "pm"; session: AgentSessionRow };

const fail = (code: LedgerErrorCode, message: string) => new LedgerRequestError(code, message);

const BAD_NAME = `不能是空的、超过 ${MAX_NAME_CHARS} 个字，或带换行等控制字符`;

/** 只在内存里的会话状态（守护进程重启后从头开始）。status 不在这里，只从 agent_sessions 那一行读。 */
interface LiveSession {
  activity: SessionActivity;
  currentTool: string | null;
  rateLimit?: RateLimitInfo | null;
}

const ACTIVE_MESSAGE_STATUSES = "('delivered', 'processing')";

function exitFailureReason(event: SessionExitedEvent): string {
  if (event.signal !== null) return `${event.reason}: signal ${event.signal}`;
  if (event.exitCode !== null) return `${event.reason}: exit code ${event.exitCode}`;
  return event.reason;
}

export function createLedger(db: Db, options: LedgerOptions): SqliteLedger {
  const now = options.now ?? Date.now;
  const userHome = options.userHome ?? homedir();
  const dataHome = options.dataHome ?? dirname(options.pmHomeRoot);
  const resolveFolder = options.resolveFolder ?? createResolveFolder({ dataHome, userHome });
  const writeFile = options.writeFileAtomic ?? defaultWriteFileAtomic;
  const { personasDir, handoffsDir } = options;
  const log = createChangeLog(options.initialSeq ?? Date.now(), options.changeBufferSize ?? CHANGE_BUFFER_SIZE);
  const changeListeners = new Set<(change: Change) => void>();
  const actionListeners = new Set<(action: AnyActionRow) => void>();
  const stopListeners = new Set<(event: StopEvent) => void>();
  const live = new Map<SessionId, LiveSession>();
  /** 上次推给网页的会话状态（不含 lastEventAt）；没推过的会话第一次一定推。 */
  const pushed = new Map<SessionId, string>();

  const notify = <T>(listeners: Set<(value: T) => void>, value: T) => {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error("agent-hub ledger listener:", error);
      }
    }
  };

  const subscribe = <T>(listeners: Set<T>, listener: T) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  /** 在一个事务里做 fn，提交后按顺序发变化、动作登记、停止请求。 */
  const write = <T>(fn: (p: Pending) => T): T => {
    // 并进外层事务的话，下面的通知会在外层提交前发出去，外层回滚就推了不存在的变化
    if (db.inTransaction) throw new Error("ledger write inside an outer transaction");
    const pending: Pending = { changes: [], actions: [], stops: [], pushed: new Map(), after: [], undo: [] };
    let result: T;
    try {
      result = db.transaction(() => fn(pending));
    } catch (error) {
      for (const undo of pending.undo) {
        try {
          undo();
        } catch (undoError) {
          console.error("agent-hub ledger undo:", undoError);
        }
      }
      throw error;
    }
    for (const after of pending.after) {
      try {
        after();
      } catch (error) {
        console.error("agent-hub ledger after commit:", error);
      }
    }
    for (const [id, key] of pending.pushed) pushed.set(id, key);
    pending.changes.sort((a, b) => CHANGE_RANK[a.type] - CHANGE_RANK[b.type]);
    for (const input of pending.changes) notify(changeListeners, log.append(input));
    for (const action of pending.actions) notify(actionListeners, action);
    for (const stop of pending.stops) notify(stopListeners, stop);
    return result;
  };

  const enqueue = (p: Pending, action: NewAction) => {
    const { row, enqueued } = enqueueAction(db, action, now());
    if (enqueued) p.actions.push(row);
  };

  // ---- 读 ----

  const conversationExists = (id: ConversationId) =>
    db.get("SELECT 1 AS x FROM conversations WHERE id = ?", id) !== undefined;

  const getMessage = (id: MessageId): Message | null => {
    const row = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
    return row === undefined ? null : toMessage(row);
  };

  /** 对话当前这一代的会话。 */
  const currentSession = (conversationId: ConversationId): AgentSessionRow | null => {
    const row = db.get<AgentSessionDbRow>(
      "SELECT * FROM agent_sessions WHERE conversation_id = ? ORDER BY generation DESC LIMIT 1",
      conversationId,
    );
    return row === undefined ? null : toAgentSessionRow(row);
  };

  const liveOf = (id: SessionId): LiveSession => live.get(id) ?? { activity: "idle", currentTool: null };

  const sessionState = (row: AgentSessionRow): SessionState => {
    const l = liveOf(row.id);
    return {
      sessionId: row.id,
      conversationId: row.conversationId,
      pmId: row.pmId,
      generation: row.generation,
      status: row.status,
      activity: l.activity,
      currentTool: l.currentTool,
      rateLimit: l.rateLimit !== undefined ? l.rateLimit : row.rateLimit,
      lastEventAt: row.lastEventAt,
    };
  };

  /**
   * 改内存里的会话状态，再按 agent_sessions 那一行算出网页看到的状态，和上次推出去的比，变了就推一条 session.status。
   * 和上次推的比、不和“改之前按行算的”比：驱动层先写库再发事件也不会漏推。lastEventAt 不参与比较。
   */
  const updateLive = (p: Pending, sessionId: SessionId, mutate: (l: LiveSession) => void) => {
    const row = getAgentSession(db, sessionId);
    if (row === null) return;
    const next = { ...liveOf(sessionId) };
    mutate(next);
    live.set(sessionId, next);
    const after = sessionState(row);
    const key = JSON.stringify({ ...after, lastEventAt: null });
    if ((p.pushed.get(sessionId) ?? pushed.get(sessionId)) === key) return;
    p.pushed.set(sessionId, key);
    p.changes.push({ type: "session.status", data: { session: after } });
  };

  const working = (currentTool: string | null) => (l: LiveSession) => {
    if (l.activity !== "stopping") l.activity = "working";
    l.currentTool = currentTool;
  };

  const idle = (l: LiveSession) => {
    l.activity = "idle";
    l.currentTool = null;
  };

  const page = (rows: MessageDbRow[]): MessagesPage => {
    const hasMore = rows.length > MESSAGE_PAGE_SIZE;
    return { messages: rows.slice(0, MESSAGE_PAGE_SIZE).reverse().map(toMessage), hasMore };
  };

  // ---- 写 ----

  /** 按 MESSAGE_STATUS_TRANSITIONS 改状态；不合法（包括同状态）、找不到、没有状态的消息忽略。 */
  const transition = (p: Pending, id: MessageId, to: MessageStatus, reason: string | null = null) => {
    const message = getMessage(id);
    if (message === null || message.status === null || !canTransitionMessage(message.status, to)) return;
    db.run(
      "UPDATE messages SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?",
      to,
      to === "failed" ? reason : null,
      now(),
      id,
    );
    p.changes.push({ type: "message.updated", data: { message: getMessage(id)! } });
  };

  const insertAgentMessage = (
    p: Pending,
    session: AgentSessionRow,
    fields: { kind: "text" | "tool"; text: string; meta: Record<string, unknown> | null; dedupeKey: string },
  ) => {
    if (session.conversationId === null) return;
    const t = now();
    const row = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, session_id, ticket_id, sender, kind, text, meta, collapsed, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
      session.conversationId,
      session.id,
      session.ticketId,
      fields.kind,
      fields.text,
      fields.meta === null ? null : JSON.stringify(fields.meta),
      fields.kind === "tool" ? 1 : 0,
      fields.dedupeKey,
      t,
      t,
    );
    if (row !== undefined) p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
  };

  const reportHealthIn = (p: Pending, module: HealthModule, error: string | null) => {
    const row = db.get<HealthDbRow>("SELECT * FROM health WHERE module = ?", module);
    const t = now();
    if (error === null) {
      if (row === undefined || (row.consecutive_failures === 0 && row.last_error === null)) return;
      db.run("UPDATE health SET consecutive_failures = 0, last_error = NULL, updated_at = ? WHERE module = ?", t, module);
    } else {
      db.run(
        `INSERT INTO health (module, consecutive_failures, last_error, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT (module) DO UPDATE SET consecutive_failures = consecutive_failures + 1, last_error = excluded.last_error, updated_at = excluded.updated_at`,
        module,
        error,
        t,
      );
    }
    const updated = db.get<HealthDbRow>("SELECT * FROM health WHERE module = ?", module)!;
    p.changes.push({ type: "health.updated", data: { health: toHealth(updated) } });
  };

  const applyEvent = (p: Pending, session: AgentSessionRow, event: DriverEvent) => {
    const sessionId = session.id;
    switch (event.type) {
      case "session.started":
        // 状态（running）由驱动层写进那一行；这里只清掉上一次没等到退出的“正在停”
        updateLive(p, sessionId, (l) => {
          if (l.activity === "stopping") idle(l);
        });
        return;
      case "message.delivered":
      case "message.processing": {
        const to = event.type === "message.delivered" ? "delivered" : "processing";
        for (const id of event.messageIds) transition(p, id, to);
        updateLive(p, sessionId, working(liveOf(sessionId).currentTool));
        return;
      }
      case "agent.text":
        insertAgentMessage(p, session, {
          kind: "text",
          text: event.text,
          meta: null,
          dedupeKey: agentMessageDedupeKey(sessionId, event.uuid),
        });
        updateLive(p, sessionId, working(null));
        return;
      case "agent.tool":
        insertAgentMessage(p, session, {
          kind: "tool",
          text: summarizeToolCall(event.name, event.input),
          meta: { toolUseId: event.toolUseId, name: event.name, input: event.input },
          dedupeKey: agentMessageDedupeKey(sessionId, event.uuid, event.toolUseId),
        });
        updateLive(p, sessionId, working(event.name));
        return;
      case "turn.ended": {
        const reason = event.error === undefined ? "turn_failed" : `${event.error.subtype}: ${event.error.message}`;
        for (const id of event.messageIds) {
          if (event.interrupted) transition(p, id, "stopped");
          else if (event.ok) transition(p, id, "replied");
          else transition(p, id, "failed", reason);
        }
        updateLive(p, sessionId, idle);
        return;
      }
      case "rate_limit":
        updateLive(p, sessionId, (l) => {
          l.rateLimit = event.info;
        });
        return;
      case "session.exited": {
        for (const id of event.messageIds) {
          if (event.reason === "interrupt" || event.reason === "shutdown") transition(p, id, "stopped");
          else if (event.reason === "crash" || event.reason === "startup_failed") transition(p, id, "failed", exitFailureReason(event));
        }
        updateLive(p, sessionId, idle);
        return;
      }
      case "driver.error":
        for (const id of event.messageIds ?? []) transition(p, id, "failed", event.message);
        reportHealthIn(p, "driver", event.message);
        return;
    }
  };

  // ---- M2：项目经理、项目、文件夹、性格设定 ----

  const pmRow = (id: PmId): PmDbRow | null => db.get<PmDbRow>("SELECT * FROM pms WHERE id = ?", id) ?? null;

  const requirePm = (id: PmId): PmDbRow => {
    const row = pmRow(id);
    if (row === null) throw fail("not_found", `没有编号 ${id} 的项目经理`);
    return row;
  };

  /** 项目经理的会话；不是（不存在、不是 pm、没有 pm_id）返回 null。 */
  const pmSession = (id: SessionId): (AgentSessionRow & { pmId: PmId }) | null => {
    const row = getAgentSession(db, id);
    return row !== null && row.role === "pm" && row.pmId !== null ? (row as AgentSessionRow & { pmId: PmId }) : null;
  };

  const projectRow = (id: ProjectId): ProjectDbRow => db.get<ProjectDbRow>("SELECT * FROM projects WHERE id = ?", id)!;

  const activeProjectByName = (name: string): ProjectDbRow | null => {
    const normalized = normalizeName(name);
    if (normalized === null) return null;
    return db.get<ProjectDbRow>("SELECT * FROM projects WHERE name = ? AND status = 'active'", normalized) ?? null;
  };

  /** 按名字找进行中的项目，并确认是这个项目经理现在管的。 */
  const managedProject = (pmId: PmId, name: string): ProjectDbRow => {
    const row = activeProjectByName(name);
    if (row === null) throw fail("not_found", `没有叫“${name}”的项目`);
    if (row.pm_id !== pmId) throw fail("forbidden", `项目“${row.name}”不归你管，只能操作自己管的项目`);
    return row;
  };

  /** 没移除的文件夹，按编号排。 */
  const foldersOf = (projectId: ProjectId): ProjectFolder[] =>
    db
      .all<ProjectFolderDbRow>("SELECT * FROM project_folders WHERE project_id = ? AND removed_at IS NULL ORDER BY id", projectId)
      .map(toProjectFolder);

  const projectCard = (row: ProjectDbRow): ProjectCard => {
    const folders = foldersOf(row.id);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      mainFolder: folders.find((f) => f.isMain)?.path ?? "",
      otherFolders: folders.filter((f) => !f.isMain).map((f) => f.path),
    };
  };

  const managedProjects = (pmId: PmId): ProjectDbRow[] =>
    db.all<ProjectDbRow>("SELECT * FROM projects WHERE pm_id = ? AND status = 'active' ORDER BY id", pmId);

  const privateConversation = (pmId: PmId): ConversationDbRow | null =>
    db.get<ConversationDbRow>("SELECT * FROM conversations WHERE kind = 'pm' AND pm_id = ? ORDER BY id LIMIT 1", pmId) ?? null;

  const insertSession = (
    p: Pending,
    fields: { conversationId: ConversationId; pmId: PmId; cwd: string; addDirs: string[]; generation: number; model: string | null },
  ): AgentSessionRow => {
    const t = now();
    const id = db.run(
      `INSERT INTO agent_sessions (role, conversation_id, pm_id, vendor_session_id, cwd, add_dirs, generation, model, created_at, updated_at)
       VALUES ('pm', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fields.conversationId,
      fields.pmId,
      randomUUID(),
      fields.cwd,
      JSON.stringify(fields.addDirs),
      fields.generation,
      fields.model,
      t,
      t,
    ).lastInsertRowid;
    const row = getAgentSession(db, id)!;
    p.changes.push({ type: "session.created", data: { session: sessionState(row) } });
    return row;
  };

  /**
   * 写一条系统消息（规则见 domain.ts 的 SystemMessageMeta）。toAgent 不是 null 时同时发给这个会话：
   * 文字带【系统】、状态 queued、登记 session.send（source: system）。
   */
  const insertSystemMessage = (
    p: Pending,
    conversationId: ConversationId,
    meta: SystemMessageMeta,
    text: string,
    toAgent: SessionId | null = null,
  ): Message => {
    const t = now();
    const row = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'system', 'text', ?, ?, ?, ?, ?, ?) RETURNING *`,
      conversationId,
      toAgent,
      toAgent === null ? text : SYSTEM_MESSAGE_PREFIX + text,
      JSON.stringify(meta),
      systemMessageDedupeKey(conversationId, meta),
      toAgent === null ? null : "queued",
      t,
      t,
    )!;
    if (toAgent !== null) enqueue(p, { type: "session.send", params: { sessionId: toAgent, messageId: row.id, source: "system" } });
    const message = toMessage(row);
    p.changes.push({ type: "message.created", data: { message } });
    return message;
  };

  /** 群最新一代会话的 addDirs 跟着项目的附加文件夹走，推 folders.updated。 */
  const foldersChanged = (p: Pending, project: ProjectDbRow): ProjectFolder[] => {
    const folders = foldersOf(project.id);
    const latest = currentSession(project.conversation_id);
    if (latest !== null) {
      db.run(
        "UPDATE agent_sessions SET add_dirs = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(folders.filter((f) => !f.isMain).map((f) => f.path)),
        now(),
        latest.id,
      );
    }
    p.changes.push({ type: "folders.updated", data: { projectId: project.id, folders } });
    return folders;
  };

  /**
   * 写性格设定文件（临时文件 + 改名），写成功才更新 persona_file_hash。没配 personasDir 什么也不做。
   * 写失败只记日志：数据库已经提交，下次启动 syncPersonaFiles 按数据库重写。
   */
  const persistPersonaFile = (pmId: PmId, text: string): boolean => {
    if (personasDir === undefined) return false;
    const file = personaFilePath(personasDir, pmId);
    try {
      writeFile(file, text);
    } catch (error) {
      console.error(`agent-hub: 写性格设定文件失败 ${file}:`, error);
      return false;
    }
    db.run("UPDATE pms SET persona_file = ?, persona_file_hash = ? WHERE id = ?", file, contentHash(text), pmId);
    return true;
  };

  const validName = (raw: string, what: string): string => {
    const name = typeof raw === "string" ? normalizeName(raw) : null;
    if (name === null) throw fail("invalid", `${what}名字不对：${BAD_NAME}`);
    return name;
  };

  const validPersonaText = (text: string) => {
    if (typeof text !== "string" || utf8Bytes(text) > MAX_PERSONA_BYTES) {
      throw fail("invalid", `性格设定太长，最多 ${MAX_PERSONA_BYTES / 1024} KB`);
    }
  };

  const validMode = (mode: unknown): PmMode => {
    if (!isOneOf(PM_MODES, mode)) throw fail("invalid", `模式只能是 ${PM_MODES.join(" 或 ")}`);
    return mode;
  };

  const getPersona = (pmId: PmId): PersonaView => {
    const pm = requirePm(pmId);
    const changes = db
      .all<PersonaChangeDbRow>("SELECT * FROM persona_changes WHERE pm_id = ? ORDER BY id DESC LIMIT ?", pmId, PERSONA_CHANGES_LIMIT)
      .map(toPersonaChange);
    return { pmId, text: personaOrTemplate(pm.persona), mode: pm.mode as PmMode, changes, revertableChangeId: changes[0]?.id ?? null };
  };

  /**
   * 改性格设定（editPersona、撤销、启动时发现手改都走这里），参数已经校验过。没变化（且不是撤销）返回 null。
   * 撤销哪怕内容一样也记一条（revertOf）。提交后写文件。
   */
  const editPersonaIn = (
    p: Pending,
    pm: PmDbRow,
    next: { text: string; mode: PmMode; reason: string | null },
    editor: PersonaEditor,
    revertOf: PersonaChangeId | null = null,
  ): PersonaChange | null => {
    const textBefore = personaOrTemplate(pm.persona);
    const modeBefore = pm.mode as PmMode;
    if (revertOf === null && next.text === textBefore && next.mode === modeBefore && pm.persona !== null) return null;
    const t = now();
    db.run("UPDATE pms SET persona = ?, mode = ? WHERE id = ?", next.text, next.mode, pm.id);
    const change = toPersonaChange(
      db.get<PersonaChangeDbRow>(
        `INSERT INTO persona_changes (pm_id, actor, session_id, text_before, text_after, mode_before, mode_after, reason, revert_of, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        pm.id,
        editor.actor,
        editor.actor === "pm" ? editor.session.id : null,
        textBefore,
        next.text,
        modeBefore,
        next.mode,
        next.reason,
        revertOf,
        t,
      )!,
    );
    p.changes.push({ type: "pm.updated", data: { pm: toPm(pmRow(pm.id)!) } });
    const modeNote = next.mode === modeBefore ? "" : `（模式：${PM_MODE_LABELS[modeBefore]} → ${PM_MODE_LABELS[next.mode]}）`;
    const reasonNote = next.reason === null ? "" : `。理由：${next.reason}`;
    let text: string;
    if (revertOf !== null) text = `已撤销${pm.name}的上一次性格设定修改${modeNote}`;
    else if (editor.actor === "pm") text = `${pm.name}改了自己的做事习惯${modeNote}${reasonNote}`;
    else if (editor.actor === "file") text = `发现${pm.name}的性格设定文件被手改过，已按文件更新`;
    else text = `你改了${pm.name}的性格设定${modeNote}${reasonNote}`;
    const conversationId =
      editor.actor === "pm" && editor.session.conversationId !== null ? editor.session.conversationId : privateConversation(pm.id)?.id;
    if (conversationId !== undefined) {
      insertSystemMessage(p, conversationId, { event: "persona.changed", pmId: pm.id, personaChangeId: change.id, revertOf }, text);
    }
    p.after.push(() => persistPersonaFile(pm.id, next.text));
    return change;
  };

  /** 校验并改性格设定（editPersona、hub persona.edit），在调用方的事务里。 */
  const editPersonaChecked = (p: Pending, pmId: PmId, input: EditPersonaInput, editor: PersonaEditor): PersonaChange | null => {
    const pm = requirePm(pmId);
    if (input.text === undefined && input.mode === undefined) throw fail("invalid", "新的性格设定正文和模式至少给一个");
    if (input.text !== undefined) validPersonaText(input.text);
    const mode = input.mode === undefined ? (pm.mode as PmMode) : validMode(input.mode);
    const reason = input.reason?.trim() || null;
    if (reason !== null && [...reason].length > MAX_REASON_CHARS) throw fail("invalid", `理由最多 ${MAX_REASON_CHARS} 个字`);
    return editPersonaIn(p, pm, { text: input.text ?? personaOrTemplate(pm.persona), mode, reason }, editor);
  };

  const editPersona = (pmId: PmId, input: EditPersonaInput, actor: LedgerActor): EditPersonaResult => {
    let editor: PersonaEditor = { actor: "user" };
    if (actor.kind === "session") {
      const session = pmSession(actor.sessionId);
      if (session === null || session.pmId !== pmId) throw fail("forbidden", "只能改自己的性格设定");
      editor = { actor: "pm", session };
    }
    const change = write((p) => editPersonaChecked(p, pmId, input, editor));
    return { change, persona: getPersona(pmId) };
  };

  const createProjectIn = (p: Pending, input: CreateProjectInput): CreateProjectResult => {
    const name = validName(input.name, "项目");
    const description = typeof input.description === "string" ? input.description.trim() || null : null;
    if (description !== null && [...description].length > MAX_DESCRIPTION_CHARS) {
      throw fail("invalid", `项目说明最多 ${MAX_DESCRIPTION_CHARS} 个字`);
    }
    const pm = requirePm(input.pmId);
    if (activeProjectByName(name) !== null) throw fail("conflict", `已经有一个叫“${name}”的项目了，换个名字`);
    const path = resolveFolder(input.folder);
    const owner = db.get<{ name: string }>(
      `SELECT p.name FROM project_folders f JOIN projects p ON p.id = f.project_id
       WHERE f.path = ? AND f.is_main = 1 AND f.removed_at IS NULL`,
      path,
    );
    if (owner !== undefined) throw fail("conflict", `这个文件夹已经是项目“${owner.name}”的主文件夹：${path}`);
    const t = now();
    const conversationId = db.run(
      "INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('project_group', ?, ?, ?)",
      pm.id,
      name,
      t,
    ).lastInsertRowid;
    const projectId = db.run(
      "INSERT INTO projects (name, description, status, pm_id, conversation_id, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, ?)",
      name,
      description,
      pm.id,
      conversationId,
      t,
      t,
    ).lastInsertRowid;
    db.run("UPDATE conversations SET project_id = ? WHERE id = ?", projectId, conversationId);
    const mainFolder = toProjectFolder(
      db.get<ProjectFolderDbRow>(
        "INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (?, ?, 1, ?) RETURNING *",
        projectId,
        path,
        t,
      )!,
    );
    const project = toProject(projectRow(projectId));
    const conversation = toConversation(db.get<ConversationDbRow>("SELECT * FROM conversations WHERE id = ?", conversationId)!);
    p.changes.push({ type: "project.created", data: { project } });
    p.changes.push({ type: "conversation.created", data: { conversation } });
    const session = insertSession(p, { conversationId, pmId: pm.id, cwd: path, addDirs: [], generation: 1, model: pm.default_model });
    p.changes.push({ type: "folders.updated", data: { projectId, folders: [mainFolder] } });
    insertSystemMessage(p, conversationId, { event: "project.created", projectId }, `项目已建好：${name}，主文件夹 ${path}，项目经理 ${pm.name}`);
    return { project, mainFolder, conversation, sessionId: session.id };
  };

  /** 系统消息要不要同时发给群里的 agent：调用者就是群最新一代自己就不发（见 SystemMessageMeta）。 */
  const folderNoticeTarget = (caller: AgentSessionRow, project: ProjectDbRow): SessionId | null => {
    const latest = currentSession(project.conversation_id);
    return latest === null || latest.id === caller.id ? null : latest.id;
  };

  const attachIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"project.attach">): HubResult<"project.attach"> => {
    const project = managedProject(caller.pmId, args.project);
    const path = resolveFolder(args.folder);
    if (db.get("SELECT 1 AS x FROM project_folders WHERE project_id = ? AND path = ? AND removed_at IS NULL", project.id, path) !== undefined) {
      throw fail("conflict", `这个文件夹已经挂在项目“${project.name}”上了：${path}`);
    }
    const folder = toProjectFolder(
      db.get<ProjectFolderDbRow>(
        "INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (?, ?, 0, ?) RETURNING *",
        project.id,
        path,
        now(),
      )!,
    );
    foldersChanged(p, project);
    insertSystemMessage(
      p,
      project.conversation_id,
      { event: "folder.attached", projectId: project.id, folderId: folder.id, path },
      `已挂上文件夹：${path}（下一条消息起生效）`,
      folderNoticeTarget(caller, project),
    );
    return { text: `已把 ${path} 挂到项目“${project.name}”上，群里下一条消息起能用。`, data: { project: toProject(project), folder } };
  };

  const detachIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"project.detach">): HubResult<"project.detach"> => {
    const project = managedProject(caller.pmId, args.project);
    const path = realpathOrLiteral(args.folder, userHome);
    const row = db.get<ProjectFolderDbRow>(
      "SELECT * FROM project_folders WHERE project_id = ? AND path = ? AND removed_at IS NULL",
      project.id,
      path,
    );
    if (row === undefined) throw fail("not_found", `项目“${project.name}”上没有挂这个文件夹：${path}`);
    if (row.is_main === 1) throw fail("invalid", `主文件夹不能移除：${path}`);
    db.run("UPDATE project_folders SET removed_at = ? WHERE id = ?", now(), row.id);
    const folder = toProjectFolder(db.get<ProjectFolderDbRow>("SELECT * FROM project_folders WHERE id = ?", row.id)!);
    foldersChanged(p, project);
    insertSystemMessage(
      p,
      project.conversation_id,
      { event: "folder.detached", projectId: project.id, folderId: folder.id, path },
      `已移除文件夹：${path}（只是不再挂在项目上，磁盘上的文件没动；下一条消息起生效）`,
      folderNoticeTarget(caller, project),
    );
    return { text: `已把 ${path} 从项目“${project.name}”上移除。`, data: { project: toProject(project), folder } };
  };

  /**
   * 会话换代的唯一入口：给这个对话开下一代会话（沿用上一代的 cwd、addDirs），登记上一代的 session.end，
   * 把还在排队的消息改发给下一代。上一代这一轮回完再关、令牌在它 ended 之后作废，见 handlers.ts 的 session.end 处理函数。
   * M2 只有交接用；以后自动换代也走这里。
   */
  const nextGeneration = (p: Pending, conversationId: ConversationId, owner: { pmId: PmId; model: string | null }) => {
    const old = currentSession(conversationId)!;
    const next = insertSession(p, {
      conversationId,
      pmId: owner.pmId,
      cwd: old.cwd,
      addDirs: old.addDirs,
      generation: old.generation + 1,
      model: owner.model,
    });
    enqueue(p, { type: "session.end", params: { sessionId: old.id, generation: old.generation } });
    const queued = db.all<{ id: number; sender: string }>(
      "SELECT id, sender FROM messages WHERE conversation_id = ? AND status = 'queued' AND session_id IS NOT NULL AND session_id != ? ORDER BY id",
      conversationId,
      next.id,
    );
    for (const message of queued) {
      db.run("UPDATE messages SET session_id = ? WHERE id = ?", next.id, message.id);
      enqueue(p, {
        type: "session.send",
        params: { sessionId: next.id, messageId: message.id, source: message.sender === "system" ? "system" : "user" },
      });
    }
    return { old, next };
  };

  const assignIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"project.assign">): HubResult<"project.assign"> => {
    const project = managedProject(caller.pmId, args.project);
    const handoffText = typeof args.handoff === "string" ? args.handoff : "";
    if (handoffText.trim() === "") throw fail("invalid", "交接正文不能是空的：先写清楚交接再换人");
    if (utf8Bytes(handoffText) > MAX_HANDOFF_BYTES) throw fail("invalid", `交接正文太长，最多 ${MAX_HANDOFF_BYTES / 1024} KB`);
    const toName = normalizeName(args.to);
    const from = pmRow(caller.pmId)!;
    if (toName !== null && toName === from.name) throw fail("invalid", "不能交给自己");
    const to = toName === null ? undefined : db.get<PmDbRow>("SELECT * FROM pms WHERE name = ?", toName);
    if (to === undefined) throw fail("not_found", `没有叫“${args.to}”的项目经理（hub pm list 可以看有哪些）`);
    if (handoffsDir === undefined) throw new Error("ledger: handoffsDir is not configured");
    const t = now();
    const { old, next } = nextGeneration(p, project.conversation_id, { pmId: to.id, model: to.default_model });
    // 文件名要带交接编号，所以先插一行（file 先空着），拿到编号再定文件名、写文件、回填
    const inserted = db.get<HandoffDbRow>(
      `INSERT INTO handoffs (project_id, from_session_id, to_session_id, from_pm_id, to_pm_id, file, reason, created_at)
       VALUES (?, ?, ?, ?, ?, '', 'reassign', ?) RETURNING *`,
      project.id,
      old.id,
      next.id,
      from.id,
      to.id,
      t,
    )!;
    const file = handoffFilePath(handoffsDir, project.id, inserted.id, t);
    writeFile(file, handoffText);
    p.undo.push(() => rmSync(file, { force: true }));
    const handoff = toHandoff(db.get<HandoffDbRow>("UPDATE handoffs SET file = ? WHERE id = ? RETURNING *", file, inserted.id)!);
    db.run("UPDATE projects SET pm_id = ?, updated_at = ? WHERE id = ?", to.id, t, project.id);
    const updated = toProject(projectRow(project.id));
    p.changes.push({ type: "project.updated", data: { project: updated } });
    const meta: SystemMessageMeta = { event: "project.reassigned", projectId: project.id, handoffId: handoff.id, fromPmId: from.id, toPmId: to.id };
    insertSystemMessage(p, project.conversation_id, meta, `项目经理由${from.name}换成${to.name}，交接在这里：${file}`);
    const toPrivate = privateConversation(to.id);
    if (toPrivate !== null) {
      const target = currentSession(toPrivate.id);
      insertSystemMessage(
        p,
        toPrivate.id,
        meta,
        `${from.name}把 ${project.name} 交给了你，以后 ${project.name} 群里由你回复。交接正文在 ${file}，群里的会话启动时也会带上。`,
        target?.id ?? null,
      );
    }
    return {
      text: `已把项目“${project.name}”交给${to.name}，交接已存好。群里之后由${to.name}回复；群里原来的会话回完这一轮就结束。`,
      data: { project: updated, handoff, sessionId: next.id },
    };
  };

  const runHub = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, command: HubCommand, args: unknown): HubResult<HubCommand> => {
    switch (command) {
      case "status": {
        const pm = pmRow(caller.pmId)!;
        const conversation = db.get<ConversationDbRow>("SELECT * FROM conversations WHERE id = ?", caller.conversationId ?? -1);
        const projects = managedProjects(pm.id).map(projectCard);
        const where =
          conversation === undefined
            ? "不在任何对话里"
            : conversation.kind === "project_group"
              ? `在项目“${projectRow(conversation.project_id!).name}”的群里`
              : "在和用户的私聊里";
        const list = projects.length === 0 ? "现在没有管着项目。" : `管着 ${projects.length} 个项目：${projects.map((x) => x.name).join("、")}。`;
        const data: HubData<"status"> = {
          pm: { id: pm.id, name: pm.name, mode: pm.mode as PmMode },
          sessionId: caller.id,
          conversation: {
            id: conversation?.id ?? -1,
            kind: (conversation?.kind ?? "pm") as HubData<"status">["conversation"]["kind"],
            projectId: conversation?.project_id ?? null,
          },
          projects,
        };
        return { text: `你是项目经理“${pm.name}”（${PM_MODE_LABELS[pm.mode as PmMode]}），现在${where}，${list}`, data };
      }
      case "pm.list": {
        const pms = db.all<PmDbRow>("SELECT * FROM pms ORDER BY id").map((pm) => ({
          id: pm.id,
          name: pm.name,
          mode: pm.mode as PmMode,
          projects: managedProjects(pm.id).map((x) => x.name),
        }));
        const lines = pms.map((pm) => `- ${pm.name}（${PM_MODE_LABELS[pm.mode]}）：${pm.projects.length === 0 ? "没有项目" : pm.projects.join("、")}`);
        return { text: `所有项目经理：\n${lines.join("\n")}`, data: { pms } };
      }
      case "project.create": {
        const a = args as HubArgs<"project.create">;
        const result = createProjectIn(p, { name: a.name, folder: a.folder, pmId: caller.pmId, ...(a.description !== undefined ? { description: a.description } : {}) });
        const { project, mainFolder, conversation } = result;
        return {
          text: `已建好项目“${project.name}”，主文件夹 ${mainFolder.path}；左栏多了群“${conversation.title}”，以后这个项目的事在群里聊。`,
          data: { project, mainFolder, conversation },
        };
      }
      case "project.attach":
        return attachIn(p, caller, args as HubArgs<"project.attach">);
      case "project.detach":
        return detachIn(p, caller, args as HubArgs<"project.detach">);
      case "project.assign":
        return assignIn(p, caller, args as HubArgs<"project.assign">);
      case "persona.show": {
        const view = getPersona(caller.pmId);
        return { text: `模式：${PM_MODE_LABELS[view.mode]}\n\n${view.text}`, data: { text: view.text, mode: view.mode } };
      }
      case "persona.edit": {
        const change = editPersonaChecked(p, caller.pmId, args as HubArgs<"persona.edit">, { actor: "pm", session: caller });
        const text =
          change === null ? "性格设定和模式都和现在一样，没有改动。" : "已改好自己的做事习惯，下一条消息起生效；用户可以在资料页撤销。";
        return { text, data: { change } };
      }
    }
  };

  const recordHubCall = (sessionId: SessionId, command: string, args: unknown, ok: boolean, errorCode: string | null, result: string) => {
    db.run(
      "INSERT INTO hub_calls (session_id, command, args, ok, error_code, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      sessionId,
      command,
      JSON.stringify(summarizeArgs(typeof args === "object" && args !== null ? args : {})),
      ok ? 1 : 0,
      errorCode,
      truncateField(result),
      now(),
    );
  };

  /** syncPersonaFiles 的一个项目经理。返回它进了哪张单子。 */
  const syncPersonaFile = (pm: PmDbRow): "recorded" | "rewritten" | null => {
    const file = personaFilePath(personasDir!, pm.id);
    let content: string | null;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      content = null;
    }
    // 1. M1 升上来的：文件在就按文件填，没有就用模板；不记修改
    if (pm.persona === null) {
      if (content !== null) {
        db.run("UPDATE pms SET persona = ?, persona_file = ?, persona_file_hash = ? WHERE id = ?", content, file, contentHash(content), pm.id);
        return null;
      }
      db.run("UPDATE pms SET persona = ? WHERE id = ?", personaOrTemplate(null), pm.id);
      persistPersonaFile(pm.id, personaOrTemplate(null));
      return "rewritten";
    }
    // 2. 文件不在或读不了
    if (content === null) {
      persistPersonaFile(pm.id, pm.persona);
      return "rewritten";
    }
    const hash = contentHash(content);
    // 3. 没人动过文件：内容不一样说明上次没写成
    if (hash === pm.persona_file_hash) {
      if (content === pm.persona) return null;
      persistPersonaFile(pm.id, pm.persona);
      return "rewritten";
    }
    // 4. 文件变过
    if (content === pm.persona) {
      db.run("UPDATE pms SET persona_file = ?, persona_file_hash = ? WHERE id = ?", file, hash, pm.id);
      return null;
    }
    if (pm.persona_file_hash === null) {
      persistPersonaFile(pm.id, pm.persona);
      return "rewritten";
    }
    if (utf8Bytes(content) > MAX_PERSONA_BYTES) {
      console.error(`agent-hub: 手改的性格设定文件超过 ${MAX_PERSONA_BYTES} 字节，按数据库重写：${file}`);
      persistPersonaFile(pm.id, pm.persona);
      return "rewritten";
    }
    write((p) => editPersonaIn(p, pm, { text: content, mode: pm.mode as PmMode, reason: null }, { actor: "file" }));
    return "recorded";
  };

  return {
    postUserMessage(input: PostUserMessageInput) {
      return write((p) => {
        if (!conversationExists(input.conversationId)) throw new ConversationNotFoundError(input.conversationId);
        const dedupeKey = userMessageDedupeKey(input.conversationId, input.clientId);
        const existing = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", dedupeKey);
        if (existing !== undefined) return { messageId: existing.id };
        const session = currentSession(input.conversationId);
        if (session === null) throw new Error(`conversation ${input.conversationId} has no agent session`);
        const t = now();
        const row = db.get<MessageDbRow>(
          `INSERT INTO messages (conversation_id, session_id, sender, kind, text, dedupe_key, status, created_at, updated_at)
           VALUES (?, ?, 'user', 'text', ?, ?, 'queued', ?, ?) RETURNING *`,
          input.conversationId,
          session.id,
          input.text,
          dedupeKey,
          t,
          t,
        )!;
        enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: row.id, source: "user" } });
        p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
        return { messageId: row.id };
      });
    },

    requestStop(conversationId) {
      if (!conversationExists(conversationId)) throw new ConversationNotFoundError(conversationId);
      const session = currentSession(conversationId);
      if (session === null) return;
      const working = liveOf(session.id).activity !== "idle";
      // 重启后内存里是空闲、库里还有处理中的消息：进程不在，只记下停止请求，不标“正在停”（不会有事件把它清掉）
      const leftover =
        !working &&
        db.get(
          `SELECT 1 AS x FROM messages WHERE session_id = ? AND status IN ${ACTIVE_MESSAGE_STATUSES} LIMIT 1`,
          session.id,
        ) !== undefined;
      if (!working && !leftover) return;
      write((p) => {
        if (working) {
          updateLive(p, session.id, (l) => {
            l.activity = "stopping";
          });
        }
        p.stops.push({ conversationId, sessionId: session.id });
      });
    },

    snapshot(): StateSnapshot {
      const conversations: ConversationSnapshot[] = db
        .all<ConversationDbRow>("SELECT * FROM conversations ORDER BY id")
        .map((row) => {
          const { messages, hasMore } = page(
            db.all<MessageDbRow>("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?", row.id, MESSAGE_PAGE_SIZE + 1),
          );
          return { conversation: toConversation(row), messages, hasMore };
        });
      return {
        seq: log.seq,
        pms: db.all<PmDbRow>("SELECT * FROM pms ORDER BY id").map(toPm),
        projects: db.all<ProjectDbRow>("SELECT * FROM projects WHERE status != 'deleted' ORDER BY id").map(toProject),
        folders: db
          .all<ProjectFolderDbRow>(
            `SELECT f.* FROM project_folders f JOIN projects p ON p.id = f.project_id
             WHERE f.removed_at IS NULL AND p.status != 'deleted' ORDER BY f.id`,
          )
          .map(toProjectFolder),
        conversations,
        sessions: db.all<AgentSessionDbRow>("SELECT * FROM agent_sessions ORDER BY id").map((r) => sessionState(toAgentSessionRow(r))),
        health: db.all<HealthDbRow>("SELECT * FROM health ORDER BY module").map(toHealth),
      };
    },

    messagesBefore(conversationId, before) {
      return page(
        db.all<MessageDbRow>(
          "SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
          conversationId,
          before,
          MESSAGE_PAGE_SIZE + 1,
        ),
      );
    },

    changesSince: (seq) => log.since(seq),
    onChange: (listener) => subscribe(changeListeners, listener),
    onStopRequested: (listener) => subscribe(stopListeners, listener),
    onActionEnqueued: (listener) => subscribe(actionListeners, listener),

    applyDriverEvent(sessionId, event) {
      const session = getAgentSession(db, sessionId);
      if (session === null) return;
      write((p) => applyEvent(p, session, event));
    },

    refreshSessionState(sessionId) {
      write((p) => updateLive(p, sessionId, idle));
    },

    recoverAfterRestart() {
      return write((p) => {
        const rows = db.all<{ id: number; session_id: number; sender: string; status: string }>(
          `SELECT m.id, m.session_id, m.sender, m.status FROM messages m
           WHERE m.session_id IS NOT NULL
             AND (
               m.status IN ('delivered', 'processing')
               -- 排队中的已有活动动作就不用管；已送达、处理中的总要再登记一次，把参数改成 resend
               OR (m.status = 'queued' AND NOT EXISTS (
                 SELECT 1 FROM actions a
                 WHERE a.type = 'session.send' AND a.dedupe_key = CAST(m.id AS TEXT) AND a.status IN ('pending', 'running')
               ))
             )
           ORDER BY m.id`,
        );
        const resentMessageIds: MessageId[] = [];
        const requeuedMessageIds: MessageId[] = [];
        // 按最早一条被打断的消息排，旧的先恢复
        const recoveredSessionIds: SessionId[] = [];
        for (const row of rows) {
          const interrupted = row.status !== "queued";
          (interrupted ? resentMessageIds : requeuedMessageIds).push(row.id);
          if (interrupted && !recoveredSessionIds.includes(row.session_id)) recoveredSessionIds.push(row.session_id);
        }
        for (const sessionId of recoveredSessionIds) {
          const session = getAgentSession(db, sessionId)!;
          enqueue(p, { type: "session.start", params: { sessionId, generation: session.generation, recovery: true } });
        }
        for (const row of rows) {
          const source = row.sender === "system" ? "system" : "user";
          const resend = row.status !== "queued";
          enqueue(p, {
            type: "session.send",
            params: { sessionId: row.session_id, messageId: row.id, source, ...(resend ? { resend: true } : {}) },
          });
        }
        return { resentMessageIds, requeuedMessageIds, recoveredSessionIds };
      });
    },

    createPm(input: CreatePmInput): CreatePmResult {
      const name = validName(input.name, "项目经理");
      const mode = validMode(input.mode);
      validPersonaText(input.persona);
      const defaultModel = input.defaultModel?.trim() || null;
      if (defaultModel !== null && [...defaultModel].length > MAX_MODEL_CHARS) throw fail("invalid", `模型名最多 ${MAX_MODEL_CHARS} 个字`);
      const result = write((p) => {
        if (db.get("SELECT 1 AS x FROM pms WHERE name = ?", name) !== undefined) {
          throw fail("conflict", `已经有一个叫“${name}”的项目经理了，换个名字`);
        }
        const t = now();
        const pmId = db.run(
          "INSERT INTO pms (name, mode, default_model, persona, created_at) VALUES (?, ?, ?, ?, ?)",
          name,
          mode,
          defaultModel,
          input.persona,
          t,
        ).lastInsertRowid;
        if (personasDir !== undefined) db.run("UPDATE pms SET persona_file = ? WHERE id = ?", personaFilePath(personasDir, pmId), pmId);
        const pm = toPm(pmRow(pmId)!);
        const conversationRow = db.get<ConversationDbRow>(
          "INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('pm', ?, ?, ?) RETURNING *",
          pmId,
          name,
          t,
        )!;
        const cwd = join(options.pmHomeRoot, String(pmId));
        mkdirSync(cwd, { recursive: true });
        p.changes.push({ type: "pm.created", data: { pm } });
        const conversation = toConversation(conversationRow);
        p.changes.push({ type: "conversation.created", data: { conversation } });
        const session = insertSession(p, { conversationId: conversation.id, pmId, cwd, addDirs: [], generation: 1, model: defaultModel });
        p.after.push(() => persistPersonaFile(pmId, input.persona));
        return { pm, conversation, sessionId: session.id };
      });
      return result;
    },

    getMessage,

    onActionFailed(action, error) {
      // session.start 失败时执行器每次都已经记过 health，这里不再记
      if (action.type === "session.send") {
        write((p) => transition(p, action.params.messageId, "failed", error));
      }
    },

    reportHealth(module, error) {
      write((p) => reportHealthIn(p, module, error));
    },

    createProject(input, actor) {
      if (actor.kind === "session") {
        const session = pmSession(actor.sessionId);
        if (session === null || session.pmId !== input.pmId) throw fail("forbidden", "只能给自己建项目");
      }
      return write((p) => createProjectIn(p, input));
    },

    getPersona,

    editPersona,

    revertPersonaChange(changeId) {
      const row = db.get<PersonaChangeDbRow>("SELECT * FROM persona_changes WHERE id = ?", changeId);
      if (row === undefined) throw fail("not_found", `没有编号 ${changeId} 的修改记录`);
      const change = write((p) => {
        const latest = db.get<{ id: number }>("SELECT id FROM persona_changes WHERE pm_id = ? ORDER BY id DESC LIMIT 1", row.pm_id)!;
        if (latest.id !== row.id) throw fail("conflict", "只能撤销最近一次修改");
        return editPersonaIn(
          p,
          pmRow(row.pm_id)!,
          { text: row.text_before, mode: row.mode_before as PmMode, reason: null },
          { actor: "user" },
          row.id,
        );
      });
      return { change, persona: getPersona(row.pm_id) };
    },

    retryMessage(messageId) {
      return write((p) => {
        const message = getMessage(messageId);
        if (message === null) throw fail("not_found", `没有编号 ${messageId} 的消息`);
        if (message.sender !== "user") throw fail("conflict", "只能重试自己发的消息");
        if (message.status !== "failed") throw fail("conflict", "只有发送失败的消息能重试");
        const session = currentSession(message.conversationId);
        if (session === null) throw new Error(`conversation ${message.conversationId} has no agent session`);
        db.run(
          "UPDATE messages SET status = 'queued', failure_reason = NULL, session_id = ?, updated_at = ? WHERE id = ?",
          session.id,
          now(),
          messageId,
        );
        enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId, source: "user" } });
        p.changes.push({ type: "message.updated", data: { message: getMessage(messageId)! } });
        return { messageId };
      });
    },

    hubCall<C extends HubCommand>(sessionId: SessionId, command: C, args: HubArgs<C>): HubResult<C> {
      const session = getAgentSession(db, sessionId);
      const caller = pmSession(sessionId);
      try {
        if (caller === null) throw fail("forbidden", "这个会话不是项目经理的会话，不能用 hub");
        return write((p) => {
          const result = runHub(p, caller, command, args);
          recordHubCall(sessionId, command, args, true, null, result.text);
          return result as HubResult<C>;
        });
      } catch (error) {
        if (session !== null) {
          const code = error instanceof LedgerRequestError ? error.code : "internal";
          const message = error instanceof Error ? error.message : String(error);
          try {
            write(() => recordHubCall(sessionId, command, args, false, code, message));
          } catch (recordError) {
            console.error("agent-hub: 记 hub_calls 失败:", recordError);
          }
        }
        throw error;
      }
    },

    getLaunchContext(sessionId): LaunchContext {
      const session = pmSession(sessionId);
      const conversation =
        session?.conversationId == null ? undefined : db.get<ConversationDbRow>("SELECT * FROM conversations WHERE id = ?", session.conversationId);
      if (session === null || conversation === undefined) throw fail("not_found", `会话 ${sessionId} 不存在或不是项目经理的会话`);
      const pm = pmRow(session.pmId)!;
      const projectDb = conversation.kind === "project_group" && conversation.project_id !== null ? projectRow(conversation.project_id) : null;
      let handoff: LaunchContext["handoff"] = null;
      if (projectDb !== null) {
        const row = db.get<HandoffDbRow & { from_pm_name: string }>(
          `SELECT h.*, p.name AS from_pm_name FROM handoffs h JOIN pms p ON p.id = h.from_pm_id
           WHERE h.project_id = ? ORDER BY h.id DESC LIMIT 1`,
          projectDb.id,
        );
        if (row !== undefined) {
          let text: string;
          try {
            text = readFileSync(row.file, "utf8");
          } catch {
            text = `（交接文件读不了：${row.file}）`;
          }
          handoff = { id: row.id, fromPmName: row.from_pm_name, text, createdAt: row.created_at };
        }
      }
      return {
        sessionId,
        role: session.role,
        conversation: { id: conversation.id, kind: toConversation(conversation).kind },
        pm: { id: pm.id, name: pm.name, mode: pm.mode as PmMode, persona: personaOrTemplate(pm.persona) },
        managedProjects: managedProjects(pm.id).map(projectCard),
        project: projectDb === null ? null : projectCard(projectDb),
        handoff,
      };
    },

    syncPersonaFiles(): SyncPersonaFilesResult {
      const result: SyncPersonaFilesResult = { recordedPmIds: [], rewrittenPmIds: [] };
      if (personasDir === undefined) return result;
      for (const pm of db.all<PmDbRow>("SELECT * FROM pms ORDER BY id")) {
        const outcome = syncPersonaFile(pm);
        if (outcome === "recorded") result.recordedPmIds.push(pm.id);
        else if (outcome === "rewritten") result.rewrittenPmIds.push(pm.id);
      }
      return result;
    },
  };
}

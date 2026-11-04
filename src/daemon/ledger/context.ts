// 账本各部分共用的东西：数据库、事务（write：提交后才推变化、通知动作和停止请求）、动作登记、健康状态。
// 账本拆成几个文件（messages.ts、sessions.ts……），都拿同一个 LedgerContext；只有 createLedger 建它。
import type { AnyActionRow, NewAction } from "../../shared/actions.ts";
import type { Change, ChangeType } from "../../shared/api.ts";
import type { ConversationId, HealthModule, SessionId } from "../../shared/domain.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import type { LedgerErrorCode, ResolveFolder } from "../../shared/ledger.ts";
import { CHANGE_BUFFER_SIZE } from "../../shared/limits.ts";
import { modelLabel, type AgentVendor, type ModelCatalog } from "../../shared/vendors.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import { enqueueAction } from "../actions/index.ts";
import type { Db } from "../store/index.ts";
import { createChangeLog } from "./change-log.ts";
import type { ChangeInput, ChangeLog } from "./change-log.ts";
import { toHealth } from "./rows.ts";
import type { HealthDbRow } from "./rows.ts";

export type StopEvent = { conversationId: ConversationId; sessionId: SessionId };

/** 一个事务里攒下的、提交后才发出去的东西；回滚就整个丢掉。 */
export interface Pending {
  changes: ChangeInput[];
  actions: AnyActionRow[];
  stops: StopEvent[];
  /** 这个事务里推出去的会话状态（比较用的键），提交后才记进 pushed。 */
  pushed: Map<SessionId, string>;
  /** 提交之后要做的事（写性格设定文件），在推变化之前做；出错只记日志。 */
  after: (() => void)[];
}

/** 一个事务里几条变化的推送顺序（见 api.ts 的 CHANGE_TYPES）。 */
const CHANGE_RANK: Readonly<Record<ChangeType, number>> = {
  "pm.created": 0,
  "pm.updated": 0,
  "project.created": 1,
  "conversation.created": 2,
  "session.created": 3,
  "folders.updated": 4,
  "message.created": 5,
  "message.updated": 5,
  "session.status": 6,
  "health.updated": 7,
};

export const fail = (code: LedgerErrorCode, message: string) => new LedgerRequestError(code, message);

export interface LedgerContext {
  db: Db;
  now: () => number;
  log: ChangeLog;
  changeListeners: Set<(change: Change) => void>;
  actionListeners: Set<(action: AnyActionRow) => void>;
  stopListeners: Set<(event: StopEvent) => void>;
  /** 上次推给网页的会话状态（不含 lastEventAt）；没推过的会话第一次一定推。 */
  pushed: Map<SessionId, string>;
  subscribe<T>(listeners: Set<T>, listener: T): () => void;
  /** 在一个事务里做 fn，提交后按顺序发变化、动作登记、停止请求。 */
  write<T>(fn: (p: Pending) => T): T;
  enqueue(p: Pending, action: NewAction): void;
  reportHealthIn(p: Pending, module: HealthModule, error: string | null): void;
  /** 系统消息、hub 输出里的模型名：用缓存着的模型名单里的名字（“Opus 4.6”），没有名单用打包的，都没有原样。 */
  modelLabel(vendor: AgentVendor, model: string | null): string;
}

/** 账本用到的目录和文件操作（LedgerOptions 补上默认值之后），persona.ts、projects.ts、workers.ts 用。 */
export interface LedgerFiles {
  pmHomeRoot: string;
  personasDir: string | undefined;
  /** worktrees/ 的根目录（LedgerOptions.worktreesDir 补上默认值）。 */
  worktreesDir: string;
  userHome: string;
  resolveFolder: ResolveFolder;
  writeFile: (file: string, content: string) => void;
}

export interface LedgerContextOptions {
  now?: () => number;
  /** 现在缓存着的模型名单（daemon/driver/model-catalog.ts 的 ModelCatalogs.current），还没问到是 null。 */
  modelCatalog?: (vendor: AgentVendor) => ModelCatalog | null;
  initialSeq?: number;
  changeBufferSize?: number;
}

export function createLedgerContext(db: Db, options: LedgerContextOptions): LedgerContext {
  const now = options.now ?? Date.now;
  const log = createChangeLog(options.initialSeq ?? Date.now(), options.changeBufferSize ?? CHANGE_BUFFER_SIZE);
  const changeListeners = new Set<(change: Change) => void>();
  const actionListeners = new Set<(action: AnyActionRow) => void>();
  const stopListeners = new Set<(event: StopEvent) => void>();
  const pushed = new Map<SessionId, string>();

  const notify = <T>(listeners: Set<(value: T) => void>, value: T) => {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error(`${LOG_PREFIX} ledger listener:`, error);
      }
    }
  };

  const subscribe = <T>(listeners: Set<T>, listener: T) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const write = <T>(fn: (p: Pending) => T): T => {
    // 并进外层事务的话，下面的通知会在外层提交前发出去，外层回滚就推了不存在的变化
    if (db.inTransaction) throw new Error("ledger write inside an outer transaction");
    const pending: Pending = { changes: [], actions: [], stops: [], pushed: new Map(), after: [] };
    const result = db.transaction(() => fn(pending));
    for (const after of pending.after) {
      try {
        after();
      } catch (error) {
        console.error(`${LOG_PREFIX} ledger after commit:`, error);
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

  const label = (vendor: AgentVendor, model: string | null) => {
    const catalog = options.modelCatalog?.(vendor) ?? null;
    return catalog === null ? modelLabel(vendor, model) : modelLabel(vendor, model, catalog);
  };
  return { db, now, log, changeListeners, actionListeners, stopListeners, pushed, subscribe, write, enqueue, reportHealthIn, modelLabel: label };
}

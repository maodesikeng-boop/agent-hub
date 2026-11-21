// The ledger is the only writer of business tables; changes, actions and stop requests are emitted only after commit.
import { hostname } from "node:os";
import type { AnyActionRow, NewAction } from "../../shared/actions.ts";
import type { Change, ChangeType, ComposerCommand } from "../../shared/api.ts";
import type { AgentSessionRow, ConversationId, HealthModule, SessionId } from "../../shared/domain.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import type { LedgerErrorCode, ResolveFolder } from "../../shared/ledger.ts";
import { CHANGE_BUFFER_SIZE } from "../../shared/limits.ts";
import { modelLabel, modelShortLabel, type AgentVendor, type ModelCatalog, type VendorAvailability } from "../../shared/vendors.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import { enqueueAction } from "../actions/index.ts";
import type { Db } from "../store/index.ts";
import { createChangeLog } from "./change-log.ts";
import type { ChangeInput, ChangeLog } from "./change-log.ts";
import { toHealth } from "./rows.ts";
import type { HealthDbRow } from "./rows.ts";
import { composerBaseOf } from "../vendors/index.ts";
import type { ModelCatalogs } from "../driver/model-catalog.ts";
import { osSandboxAvailable } from "../driver/write-scope.ts";

export type StopEvent = { conversationId: ConversationId; sessionId: SessionId };

/** Side effects collected inside a transaction; dropped entirely on rollback. */
export interface Pending {
  changes: ChangeInput[];
  actions: AnyActionRow[];
  stops: StopEvent[];
  pushed: Map<SessionId, string>;
  after: (() => void)[];
}

const CHANGE_RANK: Readonly<Record<ChangeType, number>> = {
  "pm.created": 0,
  "pm.updated": 0,
  "pm.removed": 0,
  "project.created": 1,
  "project.updated": 1,
  "conversation.created": 2,
  "conversation.purged": 2,
  "session.created": 3,
  "folders.updated": 4,
  "message.created": 5,
  "message.updated": 5,
  "task_graph.created": 6,
  "task_graph.updated": 6,
  "router.settings.updated": 6,
  "router.item.created": 6,
  "router.item.updated": 6,
  "router.reports.archived_all": 6,
  "router.command.created": 6,
  "router.command.updated": 6,
  "session.status": 7,
  "health.updated": 8,
  "schedule.updated": 9,
  "schedule.removed": 9,
};

export const fail = (code: LedgerErrorCode, message: string) => new LedgerRequestError(code, message);

export interface LedgerContext {
  db: Db;
  now: () => number;
  log: ChangeLog;
  changeListeners: Set<(change: Change) => void>;
  actionListeners: Set<(action: AnyActionRow) => void>;
  stopListeners: Set<(event: StopEvent) => void>;
  pushed: Map<SessionId, string>;
  subscribe<T>(listeners: Set<T>, listener: T): () => void;
  write<T>(fn: (p: Pending) => T): T;
  /** The transaction currently inside `write`, so reads can see state staged for commit. */
  activePending(): Pending | null;
  /** In-memory changes such as streaming text deltas bypass the transaction and are broadcast immediately. */
  emitChange(input: ChangeInput): void;
  enqueue(p: Pending, action: NewAction): void;
  reportHealthIn(p: Pending, module: HealthModule, error: string | null): void;
  modelCatalog(vendor: AgentVendor): ModelCatalog | null;
  vendorAvailability(vendor: AgentVendor): VendorAvailability;
  modelLabel(vendor: AgentVendor, model: string | null): string;
  modelShortLabel(vendor: AgentVendor, model: string | null): string;
  commandBlockReason(session: Pick<AgentSessionRow, "vendor" | "cwd" | "addDirs">, text: string): string | null;
  osSandboxed(): boolean;
  deviceName(): string;
  /** Monotonic write-transaction generation used to invalidate derived snapshots such as DeviceRouterDigest. */
  writeGeneration(): number;
}

export interface LedgerFiles {
  pmHomeRoot: string;
  personasDir: string | undefined;
  pmMemoryDir?: string;
  pmMemoryFallbackDir: string;
  worktreesDir: string;
  extraWorktreeRoots?: () => readonly string[];
  launchDir?: string;
  setupLogsDir?: string;
  userHome: string;
  resolveFolder: ResolveFolder;
  writeFile: (file: string, content: string) => void;
}

export interface LedgerContextOptions {
  now?: () => number;
  models?: Pick<ModelCatalogs, "current" | "availability">;
  knownCommands?: (session: Pick<AgentSessionRow, "vendor" | "cwd" | "addDirs">) => ComposerCommand[] | null;
  initialSeq?: number;
  changeBufferSize?: number;
  osSandboxed?: () => boolean;
  deviceName?: () => string;
}

export function createLedgerContext(db: Db, options: LedgerContextOptions): LedgerContext {
  const now = options.now ?? Date.now;
  const log = createChangeLog(options.initialSeq ?? 0, options.changeBufferSize ?? CHANGE_BUFFER_SIZE);
  const changeListeners = new Set<(change: Change) => void>();
  const actionListeners = new Set<(action: AnyActionRow) => void>();
  const stopListeners = new Set<(event: StopEvent) => void>();
  const pushed = new Map<SessionId, string>();
  let generation = 0;
  let active: Pending | null = null;

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
    // Notifying inside an outer transaction would publish changes that the outer rollback could undo.
    if (db.inTransaction) throw new Error("ledger write inside an outer transaction");
    const pending: Pending = { changes: [], actions: [], stops: [], pushed: new Map(), after: [] };
    active = pending;
    let result: T;
    try {
      result = db.transaction(() => fn(pending));
    } finally {
      active = null;
    }
    generation++;
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

  const emitChange = (input: ChangeInput) => {
    notify(changeListeners, log.append(input));
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

  const modelCatalog = (vendor: AgentVendor) => options.models?.current(vendor) ?? null;
  const vendorAvailability = (vendor: AgentVendor): VendorAvailability => options.models?.availability(vendor) ?? "unknown";
  const label = (vendor: AgentVendor, model: string | null) => {
    const catalog = modelCatalog(vendor);
    return catalog === null ? modelLabel(vendor, model) : modelLabel(vendor, model, catalog);
  };
  const shortLabel = (vendor: AgentVendor, model: string | null) => {
    const catalog = modelCatalog(vendor);
    return catalog === null ? modelShortLabel(vendor, model) : modelShortLabel(vendor, model, catalog);
  };
  const commandBlockReason = (session: Pick<AgentSessionRow, "vendor" | "cwd" | "addDirs">, text: string) =>
    composerBaseOf(session.vendor)?.blockReason(text, options.knownCommands?.(session) ?? null) ?? null;
  return {
    db,
    now,
    log,
    changeListeners,
    actionListeners,
    stopListeners,
    pushed,
    subscribe,
    write,
    activePending: () => active,
    emitChange,
    enqueue,
    reportHealthIn,
    modelCatalog,
    vendorAvailability,
    modelLabel: label,
    modelShortLabel: shortLabel,
    commandBlockReason,
    osSandboxed: options.osSandboxed ?? (() => osSandboxAvailable()),
    deviceName: options.deviceName ?? (() => hostname()),
    writeGeneration: () => generation,
  };
}

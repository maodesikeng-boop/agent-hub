// Invariant: resource inspection coalesces concurrent scans, caches results for RESOURCES_INSPECT_TTL_MS, bounds every filesystem walk, and validates ownership before any discard action.
import { existsSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { LedgerRequestError } from "../../shared/index.ts";
import {
  ACTIONS_TERMINAL_MAX_ROWS,
  COMPLETED_GRAPHS_MAX_ROWS,
  DAEMON_LOG_MAX_BYTES,
  FEISHU_DECISIONS_MAX_ROWS,
  FEISHU_POSTS_MAX_ROWS,
  FEISHU_ROUTER_EVENTS_MAX_ROWS,
  HUB_CALLS_MAX_ROWS,
  MAX_BROWSER_SESSIONS,
  RESOURCE_DECISIONS_MAX_ROWS,
  RESOURCES_DIR_SCAN_MAX_ENTRIES,
  RESOURCES_DIR_SCAN_TIMEOUT_MS,
  RESOURCES_HELD_MAX_ITEMS,
  RESOURCES_INSPECT_TTL_MS,
  RESOURCES_WARN_RATIO,
  ROUTER_AUDIT_LOG_MAX_ROWS,
  ROUTER_COMMANDS_RETENTION_MAX,
  ROUTER_ITEMS_TERMINAL_MAX_ROWS,
  SENT_FILES_DISK_MAX_BYTES,
  SETUP_LOGS_MAX_FILES,
  SKILL_CARRYOVER_RECORDS_MAX,
  UPLOADS_DISK_MAX_BYTES,
} from "../../shared/limits.ts";
import type { HubPaths } from "../../shared/paths.ts";
import type {
  DatabaseResourceSummary,
  DatabaseTableUsage,
  DirectoryResourceUsage,
  HeldProcessResource,
  HeldResourceItem,
  HeldResourceKind,
  HeldTempDirResource,
  HeldWorktreeResource,
  ResourceCleanupResponse,
  ResourceDecisionRequest,
  ResourceDecisionResponse,
  ResourcesSnapshot,
} from "../../shared/resources.ts";
import { normalizePathForComparison } from "../platform/index.ts";
import type { SessionTmpStore } from "../session-tmp.ts";
import type { Db } from "../store/index.ts";
import type { BranchCleanup } from "./branch-cleanup.ts";
import type { ResourceDecisionsStore } from "./decisions.ts";
import type { SessionProcess } from "./session-processes.ts";

export interface DirectoryScanOptions {
  readonly maxEntries?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly excludeDirs?: readonly string[];
}

export interface DirectoryScanResult {
  readonly bytes: number;
  readonly fileCount: number;
  readonly truncated: boolean;
}

export interface WorktreeResourcePort {
  inspectHeldWorktrees(): Promise<HeldWorktreeResource[]>;
  discardWorktree(workerId: number, options?: { deleteBranch?: boolean }): Promise<{ removedBytes: number }>;
  runOnce(): Promise<unknown>;
}

export interface ProcessResourcePort {
  readonly trackedCount: number;
  /** Resolves null when the process table could not be read. */
  listLeakedTaggedProcesses(): Promise<SessionProcess[] | null>;
  reapTaggedProcess(pid: number, tag: string): Promise<boolean>;
}

export interface ResourceInspectorDeps {
  readonly db: Db;
  readonly paths: Pick<
    HubPaths,
    | "dbFile"
    | "worktreesDir"
    | "sentFilesDir"
    | "uploadsDir"
    | "logsDir"
    | "setupLogsDir"
    | "syncBackupsDir"
    | "launchDir"
    | "pmMemoryDir"
    | "pmHomeDir"
    | "stateDir"
  >;
  readonly extraWorktreeRoots?: () => readonly string[];
  readonly decisions: ResourceDecisionsStore;
  readonly worktrees: WorktreeResourcePort;
  readonly branches: BranchCleanup;
  readonly sessionTmp: SessionTmpStore;
  readonly processes: ProcessResourcePort;
  readonly runDbRetention: () => Promise<{ rows: number; pages: number }>;
  readonly runFileCleanup: () => Promise<{ removedFiles: number }>;
  readonly activeSessionIds: () => ReadonlySet<number>;
  readonly now?: () => number;
}

export interface ResourceInspector {
  /**
   * Precondition: none.
   * Postcondition: returns a bounded ResourcesSnapshot, reusing a fresh cached snapshot within RESOURCES_INSPECT_TTL_MS unless refresh is true.
   */
  inspect(options?: { refresh?: boolean }): Promise<ResourcesSnapshot>;

  /**
   * Precondition: req.targetKey identifies a currently managed held resource.
   * Postcondition: applies keep, unkeep, or validated discard (never touching unmanaged paths, active sessions, or protected branches), invalidates the cache, and returns the fresh snapshot.
   */
  decide(req: ResourceDecisionRequest): Promise<ResourceDecisionResponse>;

  /**
   * Precondition: none.
   * Postcondition: runs one bounded pass of safe automatic cleanups without deleting held unsaved work, invalidates the cache, and returns counts plus the fresh snapshot.
   */
  runCleanup(): Promise<ResourceCleanupResponse>;

  /**
   * Precondition: none.
   * Postcondition: aborts any in-flight scan so daemon shutdown never stalls or touches a closed database.
   */
  close(): void;
}

const TABLE_GLOBAL_ROW_LIMITS: Readonly<Record<string, number>> = {
  actions: ACTIONS_TERMINAL_MAX_ROWS,
  hub_calls: HUB_CALLS_MAX_ROWS,
  router_items: ROUTER_ITEMS_TERMINAL_MAX_ROWS,
  router_commands: ROUTER_COMMANDS_RETENTION_MAX,
  router_audit_log: ROUTER_AUDIT_LOG_MAX_ROWS,
  task_graphs: COMPLETED_GRAPHS_MAX_ROWS,
  feishu_posts: FEISHU_POSTS_MAX_ROWS,
  feishu_decisions: FEISHU_DECISIONS_MAX_ROWS,
  feishu_router_events: FEISHU_ROUTER_EVENTS_MAX_ROWS,
  browser_sessions: MAX_BROWSER_SESSIONS,
  resource_decisions: RESOURCE_DECISIONS_MAX_ROWS,
  loaded_skills: SKILL_CARRYOVER_RECORDS_MAX,
};

function safeFileSize(path: string): number {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Precondition: db is an open SQLite database.
 * Postcondition: measures DB file size, WAL size, freelist bytes, and per-table usage via dbstat (falling back cleanly to row counts with bytes: null when dbstat is unavailable).
 */
export function measureDatabaseUsage(db: Db, dbFile: string): DatabaseResourceSummary {
  const fileBytes = safeFileSize(dbFile);
  const walBytes = safeFileSize(`${dbFile}-wal`);
  const pageSize = db.get<{ page_size?: number }>("PRAGMA page_size")?.page_size ?? 4096;
  const freelistCount = db.get<{ freelist_count?: number }>("PRAGMA freelist_count")?.freelist_count ?? 0;
  const freelistBytes = pageSize * freelistCount;

  const tableNames = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((r) => r.name);

  let dbstatAvailable = true;
  const bytesByTable = new Map<string, number>();
  try {
    const statRows = db.all<{ tbl: string; bytes: number }>(
      `SELECT coalesce(m.tbl_name, d.name) AS tbl, sum(d.pgsize) AS bytes
         FROM dbstat d
         LEFT JOIN sqlite_master m ON m.name = d.name AND m.type IN ('table', 'index')
        GROUP BY tbl`,
    );
    for (const row of statRows) bytesByTable.set(row.tbl, Number(row.bytes) || 0);
  } catch {
    dbstatAvailable = false;
  }

  const tables: DatabaseTableUsage[] = tableNames.map((table) => {
    const rows = db.get<{ n: number }>(`SELECT count(*) AS n FROM ${quoteIdent(table)}`)?.n ?? 0;
    const rowLimit = TABLE_GLOBAL_ROW_LIMITS[table] ?? null;
    const bytes = dbstatAvailable ? (bytesByTable.get(table) ?? 0) : null;
    const warning = rowLimit !== null && rows >= rowLimit * RESOURCES_WARN_RATIO;
    return { table, bytes, rows, rowLimit, warning };
  });

  tables.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || b.rows - a.rows || a.table.localeCompare(b.table));

  return { fileBytes, walBytes, freelistBytes, dbstatAvailable, tables };
}

/**
 * Precondition: dir is an absolute path (missing directories return zeros).
 * Postcondition: asynchronously sums regular file bytes and counts without following symlinks, stopping cleanly at maxEntries, timeoutMs, or signal abort.
 */
export async function measureDirectoryUsage(
  dir: string,
  options: DirectoryScanOptions = {},
): Promise<DirectoryScanResult> {
  const maxEntries = options.maxEntries ?? RESOURCES_DIR_SCAN_MAX_ENTRIES;
  const timeoutMs = options.timeoutMs ?? RESOURCES_DIR_SCAN_TIMEOUT_MS;
  const signal = options.signal;
  const excluded = new Set((options.excludeDirs ?? []).map((p) => normalizePathForComparison(resolve(p))));
  const deadline = Date.now() + timeoutMs;

  if (signal?.aborted) return { bytes: 0, fileCount: 0, truncated: true };
  try {
    const rootStat = await lstat(dir);
    if (rootStat.isSymbolicLink()) return { bytes: 0, fileCount: 0, truncated: false };
    if (rootStat.isFile()) return { bytes: rootStat.size, fileCount: 1, truncated: false };
    if (!rootStat.isDirectory()) return { bytes: 0, fileCount: 0, truncated: false };
  } catch {
    return { bytes: 0, fileCount: 0, truncated: false };
  }

  let bytes = 0;
  let fileCount = 0;
  let entriesSeen = 0;
  let truncated = false;
  const stack = [dir];

  while (stack.length > 0) {
    if (signal?.aborted || Date.now() >= deadline) {
      truncated = true;
      break;
    }
    const current = stack.pop()!;
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      continue;
    }
    for (const name of names) {
      if (signal?.aborted || Date.now() >= deadline || entriesSeen >= maxEntries) {
        truncated = true;
        break;
      }
      entriesSeen++;
      const full = join(current, name);
      if (excluded.size > 0 && excluded.has(normalizePathForComparison(resolve(full)))) continue;
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) {
        bytes += st.size;
        fileCount++;
      }
    }
    if (truncated) break;
  }

  return { bytes, fileCount, truncated };
}

async function scanDirectories(
  deps: ResourceInspectorDeps,
  signal: AbortSignal,
): Promise<DirectoryResourceUsage[]> {
  const { paths } = deps;
  const scanOpts = { maxEntries: RESOURCES_DIR_SCAN_MAX_ENTRIES, timeoutMs: RESOURCES_DIR_SCAN_TIMEOUT_MS, signal };

  const worktreeRoots = [...new Set([paths.worktreesDir, ...(deps.extraWorktreeRoots?.() ?? [])])];
  let worktreesBytes = 0;
  let worktreesFiles = 0;
  let worktreesTruncated = false;
  for (const root of worktreeRoots) {
    const res = await measureDirectoryUsage(root, scanOpts);
    worktreesBytes += res.bytes;
    worktreesFiles += res.fileCount;
    worktreesTruncated = worktreesTruncated || res.truncated;
  }

  const specs: Array<{
    id: string;
    label: string;
    dir: string;
    maxBytes: number | null;
    maxFiles: number | null;
    excludeDirs?: readonly string[];
  }> = [
    { id: "sentFiles", label: "Delivered files", dir: paths.sentFilesDir, maxBytes: SENT_FILES_DISK_MAX_BYTES, maxFiles: null },
    { id: "uploads", label: "Uploads", dir: paths.uploadsDir, maxBytes: UPLOADS_DISK_MAX_BYTES, maxFiles: null },
    { id: "setupLogs", label: "Setup logs", dir: paths.setupLogsDir, maxBytes: null, maxFiles: SETUP_LOGS_MAX_FILES },
    { id: "logs", label: "Daemon logs", dir: paths.logsDir, maxBytes: DAEMON_LOG_MAX_BYTES, maxFiles: null, excludeDirs: [paths.setupLogsDir] },
    { id: "syncBackups", label: "Sync backups", dir: paths.syncBackupsDir, maxBytes: null, maxFiles: null },
    { id: "launch", label: "Launch files", dir: paths.launchDir, maxBytes: null, maxFiles: null },
    { id: "pmMemory", label: "PM memory", dir: paths.pmMemoryDir, maxBytes: null, maxFiles: null },
  ];

  const out: DirectoryResourceUsage[] = [
    {
      id: "worktrees",
      label: "Worktrees",
      bytes: worktreesBytes,
      fileCount: worktreesFiles,
      maxBytes: null,
      maxFiles: null,
      truncated: worktreesTruncated,
      warning: false,
    },
  ];

  for (const spec of specs) {
    if (signal.aborted) break;
    const res = await measureDirectoryUsage(spec.dir, {
      ...scanOpts,
      ...(spec.excludeDirs ? { excludeDirs: spec.excludeDirs } : {}),
    });
    const warning =
      (spec.maxBytes !== null && res.bytes >= spec.maxBytes * RESOURCES_WARN_RATIO) ||
      (spec.maxFiles !== null && res.fileCount >= spec.maxFiles * RESOURCES_WARN_RATIO);
    out.push({
      id: spec.id,
      label: spec.label,
      bytes: res.bytes,
      fileCount: res.fileCount,
      maxBytes: spec.maxBytes,
      maxFiles: spec.maxFiles,
      truncated: res.truncated,
      warning,
    });
  }
  return out;
}

async function scanOrphanTempDirs(
  sessionTmp: SessionTmpStore,
  activeSessionIds: ReadonlySet<number>,
  signal: AbortSignal,
): Promise<HeldTempDirResource[]> {
  const held: HeldTempDirResource[] = [];
  for (const entry of sessionTmp.listTracked()) {
    if (signal.aborted) break;
    if (activeSessionIds.has(entry.sessionId)) continue;
    if (!existsSync(entry.path)) continue;
    const usage = await measureDirectoryUsage(entry.path, {
      maxEntries: RESOURCES_DIR_SCAN_MAX_ENTRIES,
      timeoutMs: RESOURCES_DIR_SCAN_TIMEOUT_MS,
      signal,
    });
    const name = basename(entry.path);
    held.push({
      kind: "temp_dir",
      targetKey: name,
      reason: "orphaned_temp_dir",
      label: name,
      projectId: null,
      projectName: null,
      bytes: usage.bytes,
      detectedAt: entry.createdAt,
      samplePaths: [],
      keptAt: null,
      sessionId: entry.sessionId,
      tmpPath: entry.path,
    });
  }
  return held;
}

const processTargetKey = (proc: Pick<SessionProcess, "pid" | "tag">) => `${proc.pid}:${proc.tag}`;

/**
 * Precondition: keptKeys holds `kind:targetKey` of every Keep decision and active holds every live session.
 * Postcondition: stops ended sessions' processes that run inside their own folders unless the user kept them; processes elsewhere stay for the user to decide. Returns the number stopped.
 */
export async function reapEndedSessionProcesses(
  processes: ProcessResourcePort,
  keptKeys: ReadonlySet<string>,
  active: ReadonlySet<number>,
  signal?: AbortSignal,
): Promise<number> {
  let reaped = 0;
  for (const proc of (await processes.listLeakedTaggedProcesses()) ?? []) {
    if (signal?.aborted) break;
    if (!proc.sessionPrivate) continue;
    if (proc.sessionId !== null && active.has(proc.sessionId)) continue;
    if (keptKeys.has(`process:${processTargetKey(proc)}`)) continue;
    if (await processes.reapTaggedProcess(proc.pid, proc.tag)) reaped++;
  }
  return reaped;
}

function compareHeldItems(a: HeldResourceItem, b: HeldResourceItem): number {
  const aKept = a.keptAt !== null ? 1 : 0;
  const bKept = b.keptAt !== null ? 1 : 0;
  if (aKept !== bKept) return aKept - bKept;
  const byteDiff = (b.bytes ?? -1) - (a.bytes ?? -1);
  if (byteDiff !== 0) return byteDiff;
  return b.detectedAt - a.detectedAt || a.targetKey.localeCompare(b.targetKey);
}

/**
 * Precondition: all dependency ports are wired to live daemon services.
 * Postcondition: returns a ResourceInspector with TTL caching, in-flight coalescing, and shutdown cancellation.
 */
export function createResourceInspector(deps: ResourceInspectorDeps): ResourceInspector {
  const now = deps.now ?? Date.now;
  const closeController = new AbortController();
  let closed = false;
  let cached: { snapshot: ResourcesSnapshot; at: number } | null = null;
  let inflight: Promise<ResourcesSnapshot> | null = null;
  let cacheEpoch = 0;

  const assertOpen = () => {
    if (closed || closeController.signal.aborted) {
      throw new LedgerRequestError("conflict", "Resource inspector is shutting down");
    }
  };

  const invalidate = () => {
    cacheEpoch++;
    cached = null;
    inflight = null;
  };

  const runScan = async (): Promise<ResourcesSnapshot> => {
    assertOpen();
    const signal = closeController.signal;
    const scannedAt = now();
    const database = measureDatabaseUsage(deps.db, deps.paths.dbFile);
    const activeSessions = deps.activeSessionIds();

    const [directories, heldWorktrees, branchInfo, orphanTempDirs, leakedProcs] = await Promise.all([
      scanDirectories(deps, signal),
      deps.worktrees.inspectHeldWorktrees(),
      deps.branches.inspect(),
      scanOrphanTempDirs(deps.sessionTmp, activeSessions, signal),
      deps.processes.listLeakedTaggedProcesses(),
    ]);
    assertOpen();

    const heldProcesses: HeldProcessResource[] = (leakedProcs ?? [])
      .filter((p) => p.sessionId === null || !activeSessions.has(p.sessionId))
      .map((p) => ({
        kind: "process",
        targetKey: processTargetKey(p),
        reason: p.sessionPrivate ? "leaked_process" : "shared_process",
        label: p.command || `PID ${p.pid}`,
        projectId: null,
        projectName: null,
        bytes: null,
        detectedAt: scannedAt,
        samplePaths: p.cwd === null ? [] : [p.cwd],
        keptAt: null,
        sessionId: p.sessionId,
        pid: p.pid,
        command: p.command,
        cwd: p.cwd,
      }));

    const rawHeld: HeldResourceItem[] = [...heldWorktrees, ...branchInfo.held, ...orphanTempDirs, ...heldProcesses];
    const liveKeys = new Set(rawHeld.map((item) => `${item.kind}:${item.targetKey}`));
    // A failed scan is not proof that a kept item is gone, so only fully scanned kinds drop their missing Keep decisions.
    const scannedKinds = new Set<HeldResourceKind>(["worktree", "temp_dir"]);
    if (branchInfo.complete) scannedKinds.add("git_branch");
    if (leakedProcs !== null) scannedKinds.add("process");
    deps.decisions.pruneMissing(liveKeys, scannedKinds);
    const keptByKey = new Map(deps.decisions.list().map((row) => [`${row.kind}:${row.targetKey}`, row.decidedAt]));

    const mergedHeld = rawHeld
      .map((item): HeldResourceItem => ({ ...item, keptAt: keptByKey.get(`${item.kind}:${item.targetKey}`) ?? null }))
      .sort(compareHeldItems);

    const attentionCount = mergedHeld.reduce((n, item) => n + (item.keptAt === null ? 1 : 0), 0);
    const heldTruncated = mergedHeld.length > RESOURCES_HELD_MAX_ITEMS;
    const held = heldTruncated ? mergedHeld.slice(0, RESOURCES_HELD_MAX_ITEMS) : mergedHeld;

    const totalDiskBytes =
      database.fileBytes +
      database.walBytes +
      directories.reduce((sum, dir) => sum + dir.bytes, 0);

    return {
      scannedAt,
      database,
      directories,
      branches: branchInfo.repos,
      processes: {
        trackedCount: deps.processes.trackedCount,
        leakedCount: heldProcesses.length,
      },
      held,
      heldTruncated,
      totalDiskBytes,
      attentionCount,
    };
  };

  const inspect = (options: { refresh?: boolean } = {}): Promise<ResourcesSnapshot> => {
    assertOpen();
    if (!options.refresh && cached !== null && now() - cached.at < RESOURCES_INSPECT_TTL_MS) {
      return Promise.resolve(cached.snapshot);
    }
    if (!options.refresh && inflight !== null) return inflight;

    const startEpoch = cacheEpoch;
    const task = runScan()
      .then((snapshot) => {
        if (!closed && cacheEpoch === startEpoch) {
          cached = { snapshot, at: now() };
        }
        return snapshot;
      })
      .finally(() => {
        if (inflight === task) inflight = null;
      });
    inflight = task;
    return task;
  };

  const decide = async (req: ResourceDecisionRequest): Promise<ResourceDecisionResponse> => {
    assertOpen();
    const current = await inspect({ refresh: true });
    assertOpen();
    const target = current.held.find((item) => item.kind === req.kind && item.targetKey === req.targetKey);
    if (target === undefined) {
      throw new LedgerRequestError("not_found", `Managed held resource not found: ${req.kind}:${req.targetKey}`);
    }

    let removedBytes = 0;
    if (req.action === "keep") {
      deps.decisions.keep(target.kind, target.targetKey, target.reason, now());
    } else if (req.action === "unkeep") {
      deps.decisions.unkeep(target.kind, target.targetKey);
    } else if (req.action === "discard") {
      if (target.kind === "worktree") {
        const res = await deps.worktrees.discardWorktree(target.workerId, { deleteBranch: req.deleteBranch });
        removedBytes = res.removedBytes;
      } else if (target.kind === "git_branch") {
        await deps.branches.discardBranch(target.repoFolder, target.branch);
      } else if (target.kind === "temp_dir") {
        const active = deps.activeSessionIds();
        if (target.sessionId !== null && active.has(target.sessionId)) {
          throw new LedgerRequestError("conflict", `Session ${target.sessionId} is still active`);
        }
        if (target.sessionId !== null) {
          await deps.sessionTmp.remove(target.sessionId, closeController.signal);
          removedBytes = target.bytes ?? 0;
        }
      } else if (target.kind === "process") {
        const active = deps.activeSessionIds();
        if (target.sessionId !== null && active.has(target.sessionId)) {
          throw new LedgerRequestError("conflict", `Session ${target.sessionId} is still active`);
        }
        const colon = target.targetKey.indexOf(":");
        const tag = colon === -1 ? "" : target.targetKey.slice(colon + 1);
        await deps.processes.reapTaggedProcess(target.pid, tag);
      }
      assertOpen();
      deps.decisions.unkeep(target.kind, target.targetKey);
    }

    invalidate();
    const snapshot = await inspect({ refresh: true });
    return { snapshot, removedBytes };
  };

  const runCleanup = async (): Promise<ResourceCleanupResponse> => {
    assertOpen();
    const dbRes = await deps.runDbRetention();
    assertOpen();
    const fileRes = await deps.runFileCleanup();
    assertOpen();
    const wtRes = await deps.worktrees.runOnce();
    assertOpen();
    const brRes = await deps.branches.runOnce();
    assertOpen();
    const active = deps.activeSessionIds();
    const tmpRes = await deps.sessionTmp.sweepOrphans(active, closeController.signal);
    assertOpen();

    const keptKeys = new Set(deps.decisions.list().map((row) => `${row.kind}:${row.targetKey}`));
    const reapedProcesses = await reapEndedSessionProcesses(deps.processes, keptKeys, active, closeController.signal);
    assertOpen();

    invalidate();
    const snapshot = await inspect({ refresh: true });
    return {
      snapshot,
      purgedDbRows: dbRes.rows,
      reclaimedDbPages: dbRes.pages,
      removedFiles: fileRes.removedFiles,
      removedWorktrees: Array.isArray(wtRes) ? wtRes.length : 0,
      removedBranches: brRes.deleted.length,
      removedTempDirs: tmpRes.removedPaths.length,
      reapedProcesses,
    };
  };

  const close = (): void => {
    closed = true;
    closeController.abort();
    invalidate();
  };

  return { inspect, decide, runCleanup, close };
}

export type { DirectoryResourceUsage };

// agy has no fork API: copy its undocumented per-conversation sqlite db and rewrite the cascade and trajectory ids.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { DB_BUSY_TIMEOUT_MS, agentLaunchArgs } from "../../shared/index.ts";
import type { TokenUsage } from "../../shared/index.ts";
import { agyCliDataDir, agyDataPaths, agyIsolatedHomeEnv } from "./paths.ts";
import {
  AGY_PLAN_PERMISSION_ARGS,
  AGY_PRINT_ARGS,
  AGY_STREAM_ARGS,
  buildAgyUserLine,
  buildChildEnv,
  detectAgyArgsConflict,
  parseAgyUsage,
} from "./protocol.ts";
import { spawnOwnedProcess } from "../../daemon/platform/index.ts";
import { forceKill, killFreshGroup, termGroupAfterExit } from "../../daemon/driver/process.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import { ForkUnsupportedError } from "../../daemon/handover/forker.ts";
import { existingAgyPromptRules } from "./rules.ts";
import type { ForkHandle, ForkSource, ForkWriteResult, SessionForker } from "../../daemon/handover/forker.ts";

const AGY_DATA_DIR = agyCliDataDir();
// IDs are 36-char UUIDs; byte replacement needs equal length.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_SUBDIRS = ["brain", "annotations", "implicit", "presence"] as const;
const SUMMARY_TABLES = ["conversation_summaries", "conversations_fts"] as const;
const STDERR_TAIL_CHARS = 2_000;
const SQLITE_NOTADB = 26;

export interface AgyCopyOptions {
  root?: string;
  platform?: string;
}

const isUuid = (id: string): boolean => UUID_PATTERN.test(id);

function isNotADatabase(error: unknown): boolean {
  const e = error as { errcode?: unknown; message?: unknown } | null;
  return e?.errcode === SQLITE_NOTADB || (typeof e?.message === "string" && /not a database/i.test(e.message));
}

function removeDbFiles(file: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(file + suffix, { force: true });
}

function readTrajectoryId(db: DatabaseSync, srcId: string): string {
  const columns = (db.prepare("pragma table_info(trajectory_meta)").all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.length === 0) throw new ForkUnsupportedError("agy 库里没有 trajectory_meta");
  for (const need of ["trajectory_id", "cascade_id"]) {
    if (!columns.includes(need)) throw new ForkUnsupportedError(`agy 库的 trajectory_meta 里没有 ${need} 列`);
  }
  const metas = db.prepare("select trajectory_id, cascade_id from trajectory_meta").all() as Array<{ trajectory_id: unknown; cascade_id: unknown }>;
  if (metas.length !== 1) throw new ForkUnsupportedError(`agy 库的 trajectory_meta 有 ${metas.length} 行，只认 1 行`);
  const { trajectory_id: trajectoryId, cascade_id: cascadeId } = metas[0]!;
  if (cascadeId !== srcId) throw new ForkUnsupportedError("agy 库的 cascade_id 和会话编号对不上");
  if (typeof trajectoryId !== "string" || !isUuid(trajectoryId)) throw new ForkUnsupportedError("agy 库的 trajectory_id 不是 UUID 的样子，换不了同长编号");
  return trajectoryId;
}

// IDs are equal-length ASCII, so a latin1 pass replaces bytes in text and blob cells alike.
function replaceInAllCells(db: DatabaseSync, replacements: ReadonlyArray<readonly [from: string, to: string]>): void {
  const swap = (s: string): string => replacements.reduce((acc, [from, to]) => acc.replaceAll(from, to), s);
  const tables = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as Array<{ name: string }>;
  db.exec("begin");
  try {
    for (const { name } of tables) {
      const columns = (db.prepare(`pragma table_info("${name}")`).all() as Array<{ name: string }>).map((c) => c.name);
      let all: Array<Record<string, unknown>>;
      try {
        all = db.prepare(`select rowid as "__rowid", ${columns.map((c) => `"${c}"`).join(", ")} from "${name}"`).all();
      } catch {
        throw new ForkUnsupportedError(`agy 库的表 ${name} 读不出 rowid`);
      }
      for (const row of all) {
        for (const column of columns) {
          const value = row[column];
          let next: string | Uint8Array | null = null;
          if (typeof value === "string") {
            const swapped = swap(value);
            if (swapped !== value) next = swapped;
          } else if (value instanceof Uint8Array) {
            const text = Buffer.from(value).toString("latin1");
            const swapped = swap(text);
            if (swapped !== text) next = Buffer.from(swapped, "latin1");
          }
          if (next !== null) db.prepare(`update "${name}" set "${column}" = ? where rowid = ?`).run(next, row["__rowid"] as number);
        }
      }
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function removeSummaryRows(root: string, id: string): void {
  const file = agyDataPaths(root).summaryDb;
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file, { timeout: DB_BUSY_TIMEOUT_MS });
  try {
    for (const table of SUMMARY_TABLES) {
      try {
        db.prepare(`delete from ${table} where conversation_id = ?`).run(id);
      } catch (error) {
        if (!/no such table/i.test(error instanceof Error ? error.message : "")) throw error;
      }
    }
  } finally {
    db.close();
  }
}

function readOutput(stdout: string): { result: Record<string, unknown> | null; lastStepUsage: unknown } {
  let result: Record<string, unknown> | null = null;
  let lastStepUsage: unknown = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.event === "result") {
      result = typeof event.result === "object" && event.result !== null ? (event.result as Record<string, unknown>) : event;
    } else if (event.event === "step_update") {
      const usage = (event.step_update as { usage?: unknown } | undefined)?.usage;
      if (usage !== undefined && usage !== null) lastStepUsage = usage;
    }
  }
  return { result, lastStepUsage };
}

function usageOf(raw: unknown): TokenUsage {
  const u = parseAgyUsage(raw);
  return { ...u, context: u.input + u.cacheRead + u.cacheWrite };
}

// Reuse the main session's rules dir: the product prompt lives there, not in the copied history.
function buildForkArgs(src: ForkSource, forkId: string): string[] {
  const args = [...AGY_STREAM_ARGS, "--conversation", forkId, ...AGY_PLAN_PERMISSION_ARGS, ...agentLaunchArgs({ vendor: "agy", model: src.model, effort: src.effort })];
  for (const dir of src.addDirs) args.push("--add-dir", dir);
  const promptRulesDir = src.launch.promptFile.trim() === "" ? null : existingAgyPromptRules(src.launch.promptFile);
  if (promptRulesDir) args.push("--add-dir", promptRulesDir);
  args.push(...AGY_PRINT_ARGS);
  return args;
}

export function createAgyCopyForker(options: AgyCopyOptions = {}): SessionForker {
  const paths = agyDataPaths(options.root ?? AGY_DATA_DIR);
  const { root } = paths;
  const platform = options.platform ?? process.platform;

  return {
    id: "agy-copy",
    kind: "copy",

    async fork(src: ForkSource, signal: AbortSignal): Promise<ForkHandle> {
      const srcId = src.vendorSessionId;
      if (!isUuid(srcId)) throw new ForkUnsupportedError(`agy 会话编号不是 UUID 的样子：${srcId}`);
      const srcFile = paths.conversationDb(srcId);
      if (!existsSync(srcFile)) throw new ForkUnsupportedError(`找不到 agy 对话库：${srcFile}`);
      signal.throwIfAborted();

      const newId = crypto.randomUUID();
      const dstFile = paths.conversationDb(newId);
      const dstBrain = paths.brainDir(newId);
      try {
        const from = new DatabaseSync(srcFile, { readOnly: true, timeout: DB_BUSY_TIMEOUT_MS });
        try {
          await backup(from, dstFile);
        } finally {
          from.close();
        }
        const db = new DatabaseSync(dstFile, { timeout: DB_BUSY_TIMEOUT_MS });
        try {
          const oldTrajectoryId = readTrajectoryId(db, srcId);
          replaceInAllCells(db, [
            [srcId, newId],
            [oldTrajectoryId, crypto.randomUUID()],
          ]);
        } finally {
          db.close();
        }
        chmodSync(dstFile, 0o600);
        const srcBrain = paths.brainDir(srcId);
        if (existsSync(srcBrain)) cpSync(srcBrain, dstBrain, { recursive: true });
      } catch (error) {
        removeDbFiles(dstFile);
        rmSync(dstBrain, { recursive: true, force: true });
        if (isNotADatabase(error)) throw new ForkUnsupportedError(`agy 对话库不是 sqlite 文件：${srcFile}`);
        throw error;
      }
      return { forkId: newId, extra: { root } };
    },

    async write(src: ForkSource, fork: ForkHandle, prompt: string, signal: AbortSignal): Promise<ForkWriteResult> {
      signal.throwIfAborted();
      const baseEnv = buildChildEnv(process.env, src.launch.env);
      const env = {
        ...baseEnv,
        ...agyIsolatedHomeEnv({
          userHome: baseEnv.HOME ?? homedir(),
          platform,
          env: baseEnv,
          exists: existsSync,
        }),
      };
      const spawned = spawnOwnedProcess(src.executablePath, buildForkArgs(src, fork.forkId), { cwd: src.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      const child: ChildProcessWithoutNullStreams = spawned.child;
      trackChild(child, "handover:agy", { detached: spawned.detached });
      child.once("exit", () => termGroupAfterExit(child));
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS)));
      child.stdin.on("error", () => {});
      const onAbort = () => {
        killFreshGroup(child);
        void forceKill(child);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, sig) => {
            resolve({ code, signal: sig });
          });
          child.stdin.end(buildAgyUserLine(prompt) + "\n");
        });
        signal.throwIfAborted();
        const { result, lastStepUsage } = readOutput(stdout);
        if (exit.code !== 0) {
          const detail = (stderr.trim() || (typeof result?.error === "string" ? result.error : "")).trim();
          if (detectAgyArgsConflict(detail) === "no_conversation") throw new ForkUnsupportedError(`agy 找不到复制出来的对话 ${fork.forkId}：${detail}`);
          throw new Error(`agy 退出 ${exit.code ?? exit.signal}${detail === "" ? "" : `：${detail}`}`);
        }
        if (result === null) throw new Error("agy 没给出 result 事件");
        const status = typeof result.status === "string" ? result.status : "SUCCESS";
        const response = typeof result.response === "string" ? result.response : "";
        if (status !== "SUCCESS") throw new Error(`agy 这一轮没成功（${status}）：${typeof result.error === "string" && result.error !== "" ? result.error : response}`);
        return { text: response, usage: usageOf(result.usage ?? lastStepUsage) };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },

    async remove(fork: ForkHandle): Promise<void> {
      const id = fork.forkId;
      if (!isUuid(id)) throw new Error(`agy 复制那份的编号不是 UUID 的样子，不删：${id}`);
      const wherePaths = agyDataPaths(fork.extra?.root ?? root);
      removeDbFiles(wherePaths.conversationDb(id));
      for (const sub of ID_SUBDIRS) {
        const dir = wherePaths.subDir(sub);
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
          if (name === id || name.startsWith(`${id}.`)) rmSync(join(dir, name), { recursive: true, force: true });
        }
      }
      removeSummaryRows(wherePaths.root, id);
    },
  };
}

export const AGY_FORKERS: readonly SessionForker[] = [createAgyCopyForker()];

// agy 复制会话去后台写交接的办法（docs/background-handover-design.md 第 2.3、2.6 节）：自己造的“拷库”（kind copy），靠 agy 没公开的存储格式——
// 一个会话一个 sqlite 库 conversations/<编号>.db，库里 trajectory_meta 一行记着会话编号（cascade_id）和轨迹编号（trajectory_id）。
// fork：sqlite 备份接口拷一份（原进程开着、有 WAL 也行）→ 库里所有格里的这两个编号逐字节换成同长新 UUID（protobuf 里有长度前缀，长度不能变）
//       → brain/<编号>/ 一起拷。write：agy --conversation <新编号> 续跑一轮（只读模式、不带 HUB_*）。remove：照 #108 的 cleanup.py 删干净。
// 格式对不上（没有库、没有 trajectory_meta、编号对不上或不是 UUID、agy 说找不到这个对话）一律抛 ForkUnsupportedError，账本退回“本会话写交接”。
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { DB_BUSY_TIMEOUT_MS, agentLaunchArgs } from "../../shared/index.ts";
import type { TokenUsage } from "../../shared/index.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../../shared/hub.ts";
import { agyCliDataDir, agyDataPaths } from "./paths.ts";
import {
  AGY_PLAN_PERMISSION_ARGS,
  AGY_PRINT_ARGS,
  AGY_STREAM_ARGS,
  buildAgyUserLine,
  buildChildEnv,
  detectAgyArgsConflict,
  parseAgyUsage,
} from "./protocol.ts";
import { forceKill, killFreshGroup, termGroupAfterExit } from "../../daemon/driver/process.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import { ForkUnsupportedError } from "../../daemon/handover/forker.ts";
import type { ForkHandle, ForkSource, ForkWriteResult, SessionForker } from "../../daemon/handover/forker.ts";

/** agy 的数据目录（对话库、brain、摘要库都在里面）；和 driver/transcript.ts 找对话库用的是同一个位置。 */
const AGY_DATA_DIR = agyCliDataDir();
/** 会话编号、轨迹编号的样子：36 个字符的 UUID。换编号要同长，所以不是这个样子就当格式不认识。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 除了 conversations/ 和 brain/，agy 还会在这几个目录下按编号放东西（目录、<编号>.xxx 文件）。remove 一并删。 */
const ID_SUBDIRS = ["brain", "annotations", "implicit", "presence"] as const;
/** 摘要库里按会话编号存行的表（照 #108 的 cleanup.py）。 */
const SUMMARY_TABLES = ["conversation_summaries", "conversations_fts"] as const;
/** write 出错时带进错误消息的标准错误结尾长度。 */
const STDERR_TAIL_CHARS = 2_000;
/** sqlite 的 SQLITE_NOTADB：打开的不是 sqlite 文件。 */
const SQLITE_NOTADB = 26;

export interface AgyCopyOptions {
  /** agy 的数据目录，默认 AGY_DATA_DIR；测试用。存进 handle.extra，remove 用同一个。 */
  root?: string;
}

const isUuid = (id: string): boolean => UUID_PATTERN.test(id);

function isNotADatabase(error: unknown): boolean {
  const e = error as { errcode?: unknown; message?: unknown } | null;
  return e?.errcode === SQLITE_NOTADB || (typeof e?.message === "string" && /not a database/i.test(e.message));
}

/** 删掉 <库>.db 和它的 -wal、-shm、-journal。 */
function removeDbFiles(file: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(file + suffix, { force: true });
}

/** 复制出来的库里 trajectory_meta 要正好一行：cascade_id 是原会话编号，trajectory_id 是 UUID；返回轨迹编号。 */
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

/** 把库里所有表所有格（文本、二进制）里的 from 逐字节换成 to。编号都是 ASCII 且同长，用 latin1 过一遍二进制就是逐字节。 */
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

/** 摘要库里删这个编号的行；没有这个库、没有这两张表（格式变了）都算没有。 */
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

/** 一轮的结果事件里取文字和用量：result 里的 response / usage；result 没带 usage 就用最后一个 step_update 的。 */
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

/** 复制那份的启动参数：续跑新编号；只读模式（不开写文件、跑命令的权限）；模型、思考程度、附加目录照原会话。 */
function buildForkArgs(src: ForkSource, forkId: string): string[] {
  const args = [...AGY_STREAM_ARGS, "--conversation", forkId, ...AGY_PLAN_PERMISSION_ARGS, ...agentLaunchArgs({ vendor: "agy", model: src.model, effort: src.effort })];
  for (const dir of src.addDirs) args.push("--add-dir", dir);
  args.push(...AGY_PRINT_ARGS);
  return args;
}

export function createAgyCopyForker(options: AgyCopyOptions = {}): SessionForker {
  const paths = agyDataPaths(options.root ?? AGY_DATA_DIR);
  const { root } = paths;

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
      const env = buildChildEnv(process.env, src.launch.env);
      delete env[ENV_HUB_TOKEN];
      delete env[ENV_HUB_SOCK];
      const child = spawn(src.executablePath, buildForkArgs(src, fork.forkId), { cwd: src.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      trackChild(child, "handover:agy", { detached: true });
      child.once("exit", () => termGroupAfterExit(child));
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS)));
      child.stdin.on("error", () => {}); // 进程提前退了，写不进去：看退出码和输出
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

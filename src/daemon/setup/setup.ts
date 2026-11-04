// worktree 准备命令（hub project setup）：建好 Worker 的 worktree 后，在里面用 shell 跑一次项目配的命令，跑完 Worker 再开工。
// 跑命令的逻辑都在这里：shell、环境变量、日志、超时、强制结束（复用 driver/process.ts 的 forceKillTree）、
// 同时跑着的那些（停止、收工、关机时结束它们）。什么时候跑、结果怎么交给 Worker 在 handlers.ts 和 ledger/workers.ts。
// 用到的数在 src/shared/limits.ts，日志路径在 src/shared/paths.ts。
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionId, SetupOutcome, WorkerId } from "../../shared/index.ts";
import {
  ENV_SETUP_ROOT_PATH,
  ENV_SETUP_WORKTREE_PATH,
  KILL_WAIT_MS,
  LOG_PREFIX,
  SETUP_LOG_MAX_BYTES,
  SETUP_OUTPUT_TAIL_BYTES,
  SETUP_OUTPUT_TAIL_LINES,
  SETUP_TIMEOUT_MS,
  STDIO_DRAIN_MS,
} from "../../shared/index.ts";
import { forceKillTree, streamClosed, termGroupAfterExit } from "../driver/process.ts";
import { buildChildEnv } from "../driver/protocol.ts";

// ---- 不传给准备命令的环境变量（名单只在这里）----
// 只去模型和 hub 的凭据：hub 的令牌和 socket（HUB_*）、守护进程的配置（AGENT_HUB_*）、Claude / Anthropic / Bedrock / Foundry 的
// 密钥和令牌。GH、AWS、NPM 这类别的令牌照常传（装私有依赖可能要用）。名字按大写比较。
// 对照 https://code.claude.com/docs/en/env-vars（2026-11 核过）：ANTHROPIC_API_KEY、ANTHROPIC_AUTH_TOKEN、ANTHROPIC_AWS_API_KEY、
// ANTHROPIC_FOUNDRY_API_KEY、ANTHROPIC_FOUNDRY_AUTH_TOKEN、AWS_BEARER_TOKEN_BEDROCK、CLAUDE_CODE_OAUTH_TOKEN、
// CLAUDE_CODE_OAUTH_REFRESH_TOKEN、CLAUDE_CODE_CLIENT_CERT / _KEY / _KEY_PASSPHRASE（mTLS）、MCP_CLIENT_SECRET。
const SETUP_ENV_DENY_PREFIXES = ["HUB_", "AGENT_HUB_", "ANTHROPIC_", "CLAUDE_CODE_OAUTH_", "AWS_BEARER_TOKEN_"];
const SETUP_ENV_DENY_NAMES = ["CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY", "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE", "MCP_CLIENT_SECRET"];
/** Claude Code 自己的各种令牌（会话、消息通道……），以后新加的也拦住。 */
const SETUP_ENV_DENY_PATTERN = /^CLAUDE_CODE_.*_TOKEN$/;

function deniedSetupEnv(name: string): boolean {
  const upper = name.toUpperCase();
  return SETUP_ENV_DENY_NAMES.includes(upper) || SETUP_ENV_DENY_PREFIXES.some((p) => upper.startsWith(p)) || SETUP_ENV_DENY_PATTERN.test(upper);
}

/** 用哪个 shell 跑：用户的 $SHELL（-c，不是登录 shell），没有就 /bin/sh。 */
export function setupShell(env: Record<string, string | undefined>): string {
  return env.SHELL || "/bin/sh";
}

/** 准备命令的环境变量：守护进程自己的，去掉父会话那几个（buildChildEnv）和模型、hub 的凭据（deniedSetupEnv），加上主文件夹、worktree 两个路径。 */
export function buildSetupEnv(
  base: Record<string, string | undefined>,
  paths: { rootPath: string; worktreePath: string },
): Record<string, string> {
  const env = buildChildEnv(base, undefined);
  for (const key of Object.keys(env)) {
    if (deniedSetupEnv(key)) delete env[key];
  }
  return { ...env, [ENV_SETUP_ROOT_PATH]: paths.rootPath, [ENV_SETUP_WORKTREE_PATH]: paths.worktreePath };
}

/** ESC 开头的终端控制序列：CSI（颜色、清行）、OSC（窗口标题，BEL 或 ESC \\ 结尾）、两个字符的。 */
const ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/gu;
/** 换行和制表符以外的 C0、DEL、C1 控制字符。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/**
 * 命令的输出、命令原文交给 agent 看之前洗一遍（不让它们在附注里伪造格式）：CRLF 当换行；去掉终端控制序列；
 * 每行只留最后一个 \r 之后的（进度条反复刷新同一行）；再去掉剩下的控制字符。日志文件里留原样。
 */
export function cleanTerminalText(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replace(ESCAPE_SEQUENCE, "")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n")
    .replace(CONTROL_CHARS, "");
}

/** 输出的最后 maxLines 行、最多 maxBytes 字节（从后往前截，截在半个字上的那个字丢掉），洗过（cleanTerminalText）。末尾的空行去掉。 */
export function outputTail(output: Buffer, maxLines: number, maxBytes: number): string {
  let bytes = output.length > maxBytes ? output.subarray(output.length - maxBytes) : output;
  // 截在多字节字符中间：跳过开头的续字节（10xxxxxx）
  if (bytes !== output) {
    let i = 0;
    while (i < bytes.length && (bytes[i]! & 0xc0) === 0x80) i++;
    bytes = bytes.subarray(i);
  }
  const lines = cleanTerminalText(bytes.toString("utf8")).replace(/\s+$/u, "").split("\n");
  return lines.slice(-maxLines).join("\n");
}

export interface RunSetupOptions {
  command: string;
  /** worktree 目录：命令在这里跑。 */
  cwd: string;
  /** 项目主文件夹（AGENT_HUB_ROOT_PATH）。 */
  rootPath: string;
  /** 日志文件（paths.ts 的 workerSetupLogPath），追加写。 */
  logPath: string;
  /** 默认 SETUP_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** 默认 setupShell(process.env)。 */
  shell?: string;
  /** 默认 process.env。 */
  baseEnv?: Record<string, string | undefined>;
  /** abort：强制结束，结果是 stopped。 */
  signal?: AbortSignal;
  /** 默认 SETUP_LOG_MAX_BYTES（测试改小）。 */
  logMaxBytes?: number;
  now?: () => number;
}

/** 开日志文件（追加）；写不了返回原因，命令照样跑。 */
function openLog(logPath: string): { fd: number | null; error: string | null } {
  try {
    // 和 launch.ts 的启动文件目录一样只给自己：日志里有命令原文和输出
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    return { fd: openSync(logPath, "a", 0o600), error: null };
  } catch (error) {
    return { fd: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 在 cwd 里用 `<shell> -c <command>` 跑一次准备命令。不抛错：worktree 目录不在、起不来、中途意外出错都是 failed（原因在 error）。
 * - detached（自己一个进程组）；标准输入是 /dev/null，不会卡在等输入上；
 * - 标准输出和标准错误合在一起，边收边追加进日志（每次一段，段头写时间和命令，超过 logMaxBytes 写“后面省略”但照样读完），
 *   内存里只留最后一截给 tail；
 * - 超时、abort：forceKillTree 连同所有后代一起杀；正常退出后给它的进程组补一个 SIGTERM，清掉留在后台的；
 *   退出后管道最多再读 STDIO_DRAIN_MS（后台进程占着管道时不一直等）。
 */
export async function runSetupCommand(options: RunSetupOptions): Promise<SetupOutcome> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? SETUP_TIMEOUT_MS;
  const logMaxBytes = options.logMaxBytes ?? SETUP_LOG_MAX_BYTES;
  const baseEnv = options.baseEnv ?? process.env;
  const shell = options.shell ?? setupShell(baseEnv);
  const started = now();
  const log = openLog(options.logPath);
  let logError = log.error;
  let logged = 0;
  let logCut = false;
  const writeLog = (text: string | Buffer) => {
    if (log.fd === null) return;
    try {
      writeSync(log.fd, typeof text === "string" ? Buffer.from(text) : text);
    } catch (error) {
      logError ??= errorMessage(error);
    }
  };
  writeLog(`\n=== ${new Date(started).toISOString()} 在 ${options.cwd} 跑准备命令 ===\n${options.command}\n---\n`);

  // 只留最后一截：够 tail 用就行
  const keepBytes = SETUP_OUTPUT_TAIL_BYTES * 2;
  let kept = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    kept = Buffer.concat([kept, chunk]);
    if (kept.length > keepBytes) kept = kept.subarray(kept.length - keepBytes);
    if (logCut) return;
    const room = logMaxBytes - logged;
    if (chunk.length <= room) {
      writeLog(chunk);
      logged += chunk.length;
    } else {
      writeLog(chunk.subarray(0, room));
      writeLog(`\n……（日志超过 ${logMaxBytes} 字节，后面省略）\n`);
      logged = logMaxBytes;
      logCut = true;
    }
  };

  const finish = (fields: Pick<SetupOutcome, "kind" | "exitCode" | "signal" | "error">): SetupOutcome => {
    const durationMs = now() - started;
    const how = fields.error ?? (fields.signal !== null ? `信号 ${fields.signal}` : `退出码 ${fields.exitCode}`);
    writeLog(`\n--- 结束（${fields.kind}，${how}），用时 ${Math.round(durationMs / 1000)} 秒 ---\n`);
    if (log.fd !== null) {
      try {
        closeSync(log.fd);
      } catch {
        // 关不上也没什么可做的
      }
      log.fd = null;
    }
    return {
      ...fields,
      command: options.command,
      timeoutMs,
      durationMs,
      tail: outputTail(kept, SETUP_OUTPUT_TAIL_LINES, SETUP_OUTPUT_TAIL_BYTES),
      logPath: options.logPath,
      logError,
    };
  };

  if (options.signal?.aborted) return finish({ kind: "stopped", exitCode: null, signal: null, error: null });
  // 先查目录：不在的话 spawn 只会报一句看不懂的“spawn /bin/zsh ENOENT”
  if (!isDirectory(options.cwd)) return finish({ kind: "failed", exitCode: null, signal: null, error: `worktree 目录不在：${options.cwd}` });
  try {
    return await runChild();
  } catch (error) {
    // 意外出错（spawn 同步抛错之类）：照样写日志结尾、关掉日志文件，给 failed
    return finish({ kind: "failed", exitCode: null, signal: null, error: `准备命令出错：${errorMessage(error)}` });
  }

  async function runChild(): Promise<SetupOutcome> {
    const child = spawn(shell, ["-c", options.command], {
      cwd: options.cwd,
      env: buildSetupEnv(baseEnv, { rootPath: options.rootPath, worktreePath: options.cwd }),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    let killedFor: "timeout" | "stopped" | null = null;
    let killing: Promise<void> | null = null;
    const kill = (why: "timeout" | "stopped") => {
      if (killedFor !== null || child.pid === undefined) return;
      killedFor = why;
      killing = forceKillTree(child.pid, true);
    };
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    const onAbort = () => kill("stopped");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | { error: Error }>((resolve) => {
      child.once("error", (error) => resolve({ error }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);

    if ("error" in exited) {
      return finish({ kind: "failed", exitCode: null, signal: null, error: `准备命令起不来：${exited.error.message}` });
    }
    if (killedFor === null) termGroupAfterExit(child);
    if (killing !== null) await killing;
    const drain = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, STDIO_DRAIN_MS);
    await Promise.all([streamClosed(child.stdout), streamClosed(child.stderr)]);
    clearTimeout(drain);

    if (killedFor !== null) return finish({ kind: killedFor, exitCode: null, signal: exited.signal, error: null });
    const ok = exited.code === 0;
    return finish({ kind: ok ? "ok" : "failed", exitCode: exited.code, signal: exited.signal, error: null });
  }
}

/**
 * 交给 runner 跑的一次准备命令。onDone 在跑完（成功、失败、超时、被停止）时调；关机打断的不调。
 * onDone 抛错、或者跑命令本身意外抛错时，runner 再调一次 onDone，结果是 failed、原因“准备命令出错：…”，
 * 免得 Worker 一直停在准备中。
 */
export interface SetupJob {
  workerId: WorkerId;
  sessionId: SessionId;
  command: string;
  cwd: string;
  rootPath: string;
  logPath: string;
  onDone: (outcome: SetupOutcome) => void;
}

export interface SetupRunner {
  /** 开始跑。这个 Worker 已经在跑、或者已经 shutdown 了：什么也不做，返回 false。 */
  start(job: SetupJob): boolean;
  /** 停掉这个会话正在跑的准备命令（网页上点停止、hub worker end）：结果是 stopped，照常调 onDone。没在跑什么也不做。 */
  cancel(sessionId: SessionId): void;
  /** 关机：全部强制结束，不调 onDone（重启后重跑）。最多等 KILL_WAIT_MS。之后 start 一律不跑。 */
  shutdown(): Promise<void>;
}

export interface SetupRunnerOptions {
  timeoutMs?: number;
  shell?: string;
  baseEnv?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

/** 管同时跑着的准备命令：按 Worker 去重，按会话停，关机时一起结束。 */
export function createSetupRunner(options: SetupRunnerOptions = {}): SetupRunner {
  const log = options.log ?? ((line) => console.error(line));
  const timeoutMs = options.timeoutMs ?? SETUP_TIMEOUT_MS;
  const running = new Map<WorkerId, { sessionId: SessionId; controller: AbortController; done: Promise<void> }>();
  let closed = false;

  /** 交给 onDone；它抛错记一行日志，返回抛的错（没出错是 undefined）。 */
  const deliver = (job: SetupJob, outcome: SetupOutcome): { error: unknown } | undefined => {
    try {
      job.onDone(outcome);
      return undefined;
    } catch (error) {
      log(`${LOG_PREFIX} 准备命令跑完了，交给账本时出错（Worker #${job.workerId}）：${errorMessage(error)}`);
      return { error };
    }
  };
  /** 兜底的结果：Worker 照常开工，附注写“准备命令出错：原因”。 */
  const errorOutcome = (job: SetupJob, error: unknown): SetupOutcome => ({
    kind: "failed",
    command: job.command,
    exitCode: null,
    signal: null,
    error: `准备命令出错：${errorMessage(error)}`,
    timeoutMs,
    durationMs: 0,
    tail: "",
    logPath: job.logPath,
    logError: null,
  });

  return {
    start(job) {
      if (closed || running.has(job.workerId)) return false;
      const controller = new AbortController();
      const done = runSetupCommand({
        command: job.command,
        cwd: job.cwd,
        rootPath: job.rootPath,
        logPath: job.logPath,
        signal: controller.signal,
        timeoutMs,
        ...(options.shell !== undefined ? { shell: options.shell } : {}),
        ...(options.baseEnv !== undefined ? { baseEnv: options.baseEnv } : {}),
      })
        .then((outcome) => {
          running.delete(job.workerId);
          if (closed) return;
          // 第一次交不进去（比如写库出错）：换成“准备命令出错”再交一次
          const failed = deliver(job, outcome);
          if (failed !== undefined) deliver(job, errorOutcome(job, failed.error));
        })
        .catch((error: unknown) => {
          running.delete(job.workerId);
          log(`${LOG_PREFIX} 准备命令出错（Worker #${job.workerId}）：${errorMessage(error)}`);
          if (!closed) deliver(job, errorOutcome(job, error));
        });
      running.set(job.workerId, { sessionId: job.sessionId, controller, done });
      return true;
    },
    cancel(sessionId) {
      for (const entry of running.values()) if (entry.sessionId === sessionId) entry.controller.abort();
    },
    async shutdown() {
      closed = true;
      const entries = [...running.values()];
      for (const entry of entries) entry.controller.abort();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(entries.map((e) => e.done)),
        new Promise((resolve) => (timer = setTimeout(resolve, KILL_WAIT_MS))),
      ]);
      clearTimeout(timer);
    },
  };
}

#!/usr/bin/env node
// 假 claude：照 M0 实测（docs/m0-report.md）的 `claude -p --input-format stream-json --output-format stream-json
// --verbose --replay-user-messages` 行为回应，事件字段名照抄 M0 的记录。驱动层测试用它代替真 claude。
//
// 环境变量：
// - FAKE_CLAUDE_SCRIPT：剧本（JSON 文件，见 FakeScript）。不给就每轮回一句 "ok"。剧本里的 sessions 按会话
//   （角色、工作目录）另选剧本（M3：项目经理和 Worker 各写各的，见 FakeSessionScript）。
// - FAKE_CLAUDE_LOG：把命令行参数、每一行标准输入、收到的信号、退出码记成 JSONL（见 FakeLogEntry）。
// - FAKE_CLAUDE_STATE：状态目录，记哪些会话 ID 已经存在、一共跑了几轮（跨进程）。默认是日志所在目录；
//   两个都没给就记在进程内存里（只在这一个进程里算数）。
// - FAKE_CLAUDE_PROBE：启动时试着写这个文件，结果记进日志（kind probe），测 Worker 的可写范围。
//
// 默认行为：
// - --session-id 一个已经存在的 ID（剧本 rejectSessionArgs 时一律当已存在 / 不存在）：标准错误 “Error: Session ID … is already in use.”，退出码 1；
//   --resume 一个不存在的 ID：标准错误 “No conversation found with session ID: …”，再输出一条
//   error_during_execution 的 result，退出码 1。
// - 每轮开头发 system/init；先回显收到的消息（isReplay），再按剧本发 assistant、rate_limit_event、result。
//   剧本 lateReplay 时回显推迟到第一个不是 sleepMs、waitFile 的步骤之前（更像真 claude：开始处理时才回显）。
// - 忙时收到的几条合并成下一轮的一条（回显里是几段 text）。
// - 剧本 capabilities 里有 msg_lifecycle_v1 时照真 claude 2.1.314（docs/mid-turn-messages.md）：init 带 capabilities；
//   带 uuid 的 user 行出 command_lifecycle（写进来就 queued，被取走 started——第一条在 init 之前——，那一轮 result 之后 completed）；
//   忙时写进来的在当前工具（tool、bash 步骤）跑完后被同一轮取走（各自回显 + started），没赶上的（只剩文字时）排到下一轮；
//   interrupt 带 cancel_queued 时把还没取走的取消（回执 cancelled、各出 cancelled），不带就照旧排到下一轮。
// - 坏的输入行（不是 JSON、message.role 不是 "user"）：标准错误写一行，退出码 1。
// - initialize 控制消息：回 control_response，带剧本里的 commands（剧本 commands）；
// - mcp_status 控制消息：回剧本里的 mcpServers（只读 Worker 的 can_use_tool 判断用）；驱动回的 control_response（allow/deny）记进日志，不当用户消息；
// - interrupt 控制消息：回 control_response，再出 `[Request interrupted by user]`（工具调用中是
//   `[Request interrupted by user for tool use]`）和一条 result，进程不退出。
// - SIGINT：结束这一轮（`[Request interrupted by user]` + is_error 的 result），然后退出码 0。
// - 标准输入关掉：跑完手上这一轮再退出，退出码 0。
// - 参数里有 --fork-session（后台写交接复制那份）：标准输入是纯文本提示词，关掉后当一条用户消息跑一轮，回完退出。
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

/** 一轮里的一步。 */
export type FakeStep =
  /** usage、messageId：这条 assistant 消息带的 message.usage 和 message.id（同一个 id 发几次，像真 claude 分几个事件推同一条消息）；parentToolUseId：子 agent 的消息。 */
  | { text: string; noUuid?: boolean; usage?: Record<string, number>; messageId?: string; parentToolUseId?: string }
  /** 一个 thinking 块（真实日志里 thinking 单独一个事件，内容常是空的）。 */
  | { thinking: true }
  /** durationMs：工具跑多久（这期间被打断，打断标记是 “for tool use” 那种）。 */
  | { tool: { name: string; input: unknown; result?: string; durationMs?: number } }
  | { rateLimit: Record<string, unknown> }
  | { raw: string }
  | { sleepMs: number }
  /** 等这个文件出现再往下走（测试用它卡住一轮，想放行时自己建文件；比睡固定时间稳，机器忙也不会错过窗口）。 */
  | { waitFile: string }
  | { exit: number }
  /** 发一条 system/api_retry（字段照真 claude；errorStatus 给 null 就是没有状态码，比如断网）。 */
  | { apiRetry: { attempt?: number; maxRetries?: number; retryDelayMs?: number; errorStatus?: number | null; error?: string } }
  /** 起一个脱离的孙进程，继承标准输出和标准错误，活 sleepSec 秒（测孙进程占着 stdio）。进程号记进日志。 */
  | { spawnOrphan: { sleepSec: number } }
  /**
   * 起一个子进程睡 sleepSec 秒，标准输入输出都不接。进程号记进日志（测按进程组强制结束）。
   * 默认和 claude 同一个进程组；detached 时放进它自己的新进程组（像真 claude 的 Bash 工具那样）。
   */
  | { spawnChild: ChildSpec }
  /**
   * 像真 claude 的 Bash 工具那样跑一条命令（M2，端到端测 agent 敲 hub）：用自己拿到的环境变量和工作目录 `sh -c`，
   * 先出一个 name 为 "Bash" 的 tool_use，跑完再出 tool_result（内容是标准输出 + 标准错误；退出码不是 0 时
   * 开头加 “Exit code N”，is_error: true）。
   */
  | { bash: string }
  /** 发一条 system/background_tasks_changed，tasks 是完整名单（见 BackgroundTaskSpec）。 */
  | { backgroundTasks: BackgroundTaskSpec[] }
  /** 从此不再读标准输入（管道写满后对面的写入一直等着，测写回调还没回来进程就退出）。 */
  | { stopReading: true };

/** 字符串就是 task_id，其余字段照真 claude（实测见 docs/m0-report.md）补上；对象原样发（测 ambient、残缺条目）。 */
export type BackgroundTaskSpec = string | Record<string, unknown>;

export interface FakeTurn {
  steps?: FakeStep[];
  /** 不给就是 success。 */
  result?: { subtype?: string; isError?: boolean; result?: string };
  /** result 里的 usage（这一轮的用量）；不给是 { input_tokens: 10, output_tokens: 5 }。 */
  usage?: Record<string, number>;
  /** 默认每轮在 result 前发一条 M0 记录里的 rate_limit_event；false 不发。 */
  rateLimit?: Record<string, unknown> | false;
  /**
   * 这一轮结束 afterMs（默认 50）毫秒后，claude 自己再开一轮（没有用户消息，像后台任务完成通知触发的那种）：
   * 先发 system/task_notification，再 system/init、按它自己的步骤回，result 带 origin task-notification。不占剧本里的轮数。
   * 到点时手上有一轮在跑就等它跑完。标准输入关了也等这一轮开过、跑完再退出。
   */
  selfTurn?: FakeTurn & { afterMs?: number };
  /**
   * result 发出去之后，每隔 afterMs（从 result 起算）发一条 system/background_tasks_changed（不管那时忙不忙，像真 claude 在轮外报任务结束）。
   * tasks 给 "malformed" 就发一条没有 tasks 数组的。
   */
  backgroundTasksAfter?: Array<{ afterMs: number; tasks: BackgroundTaskSpec[] | "malformed" }>;
}

export interface FakeScript {
  model?: string;
  tools?: string[];
  /** 按跨进程的总轮数取（第 0 轮是 turns[0]）；超出就用 defaultTurn。 */
  turns?: FakeTurn[];
  defaultTurn?: FakeTurn;
  /** 永远不发 init，收到消息也不回应（启动卡住）。 */
  noInit?: boolean;
  /** 不理 interrupt 控制消息。 */
  ignoreControl?: boolean;
  /** 控制消息怎么回：ack_only 回 success 但不打断；error 回 error。不给就照常打断。 */
  control?: "ack_only" | "error";
  /** 收到控制消息后过这么久再处理。 */
  controlDelayMs?: number;
  /**
   * initialize 控制消息的回应里带的 commands（形状照真 claude：{name, description, argumentHint, aliases?, builtin?}，
   * 见 docs/composer-commands.md 的 T1）。不给就不带 commands。
   */
  commands?: unknown[];
  /** 标准输入关掉也不退出（测空闲关闭的升级）。 */
  ignoreStdinEnd?: boolean;
  /** 回显推迟到第一个不是 sleepMs、waitFile 的步骤之前。 */
  lateReplay?: boolean;
  /** 收到 SIGINT 只记下来，不退出（测关机时的强制结束）。 */
  ignoreSigint?: boolean;
  /** 不管会话在不在，--session-id 一律报 “already in use”，--resume 一律报 “No conversation found”。 */
  rejectSessionArgs?: boolean;
  /** 一起来就起一个子进程（同 spawnChild 步骤；配合 noInit 测启动超时按进程组强制结束）。 */
  spawnChildOnStart?: number | ChildSpec;
  /** 按会话另选剧本，只在顶层剧本里认（见 FakeSessionScript）。 */
  sessions?: FakeSessionScript[];
  /**
   * init 里的 capabilities（真 claude 2.1.314 有 msg_lifecycle_v1、interrupt_cancel_queued_v1 等）。不给就不带这个字段（老 claude）。
   * 有 msg_lifecycle_v1 才按真 claude 的“一轮中途取走”和 command_lifecycle 走（见文件开头）。
   */
  capabilities?: string[];
  /** mcp_status 控制消息的回应里的 mcpServers（形状照真 claude：[{name, status, tools:[{name, annotations:{readOnly, destructive, openWorld}}]}]，见 docs/readonly-worker-design.md 1.1）。不给回空名单。 */
  mcpServers?: unknown[];
  /** 带 cancel_queued 的 interrupt：回执里不列 cancelled（只有 still_queued），被取消的照样各出 command_lifecycle cancelled。 */
  receiptWithoutCancelled?: boolean;
}

/**
 * 按会话选剧本（M3，端到端测试分别给项目经理和 Worker 写剧本）。写了的条件都要对上；sessions 里从前往后第一条对上的
 * 整个代替顶层剧本（不合并），都对不上用顶层剧本。
 * 选中的剧本按会话 ID 分开数轮数（每个会话从 turns[0] 起，--resume 接着数），几个 Worker 用同一份剧本互不干扰；
 * 顶层剧本照旧跨进程一起数。
 */
export interface FakeSessionScript {
  /** 角色：环境变量里有 Worker 才设的 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1（shared/policy.ts 的 WORKER_ENV）就是 worker，否则 pm。 */
  role?: FakeRole;
  /** 工作目录等于它（两边都 realpath 过再比）。 */
  cwd?: string;
  /** 工作目录是它或在它下面，比如 Worker 的 worktree 都在 <数据目录>/worktrees/ 下。 */
  cwdUnder?: string;
  script: FakeScript;
}

export type FakeRole = "pm" | "worker";

export interface ChildSpec {
  sleepSec: number;
  detached?: boolean;
}

export type FakeLogEntry =
  | { kind: "argv"; pid: number; argv: string[]; cwd: string }
  | { kind: "stdin"; pid: number; line: string }
  | { kind: "signal"; pid: number; signal: string }
  | { kind: "stdin_closed"; pid: number }
  /** 信号处理器装好了（argv 记得早，之后到这里还有一段启动代码；要发信号的测试等这一条）。 */
  | { kind: "ready"; pid: number }
  | { kind: "exit"; pid: number; code: number }
  | { kind: "orphan"; pid: number; orphanPid: number }
  | { kind: "child"; pid: number; childPid: number }
  /** 启动时记下的几个环境变量（只记 LOGGED_ENV 里的，没设的不出现）。 */
  | { kind: "env"; pid: number; env: Record<string, string> }
  /** 用的是哪份剧本：顶层是 null，否则是 sessions 里的下标。role 是认出来的角色。 */
  | { kind: "script"; pid: number; role: FakeRole; session: number | null }
  | { kind: "bash"; pid: number; command: string; exitCode: number; output: string }
  /** FAKE_CLAUDE_PROBE：启动时试着写这个文件，记下写没写成（测 Worker 的可写范围，见 daemon/driver/write-scope.ts）。 */
  | { kind: "probe"; pid: number; ok: boolean; code?: string };

/** M0 实测的 rate_limit_event.rate_limit_info（额度正常时）。 */
export const M0_RATE_LIMIT_INFO = {
  status: "allowed",
  resetsAt: 1793619600,
  rateLimitType: "five_hour",
  overageStatus: "rejected",
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.37, resetsAt: 1793619600, status: "allowed" },
    seven_day: { utilization: 0.59, resetsAt: 1793646000, status: "allowed" },
  },
};

export const INTERRUPT_TEXT = "[Request interrupted by user]";
export const INTERRUPT_TOOL_TEXT = "[Request interrupted by user for tool use]";

const logFile = process.env.FAKE_CLAUDE_LOG;
const stateDir = process.env.FAKE_CLAUDE_STATE || (logFile ? dirname(logFile) : undefined);
/**
 * Linux bwrap（--unshare-pid）内层 CLI 的 process.pid 恒为 2：
 * 为避免多个沙箱内 Worker 在日志里的 pid 撞车或与宿主机 PID 2（kthreadd）混淆，
 * 当 process.pid <= 2 且有 stateDir 时用 O_CREAT|O_EXCL 原子分配 1_000_001+ 的唯一进程标识并保持 fd 打开（退出后内核自动关闭 fd）。
 */
const myPid: number = (() => {
  if (process.pid > 2 || !stateDir) return process.pid;
  mkdirSync(stateDir, { recursive: true });
  for (let n = 1_000_001; ; n++) {
    try {
      const fd = openSync(join(stateDir, `fake-proc-${n}`), "wx");
      (globalThis as Record<string, unknown>).__fakeClaudeHoldFd = fd;
      return n;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      return process.pid;
    }
  }
})();
const topScript: FakeScript = process.env.FAKE_CLAUDE_SCRIPT
  ? (JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, "utf8")) as FakeScript)
  : {};
/** Worker 的会话才有的环境变量（shared/policy.ts 的 WORKER_ENV），假 claude 靠它认角色。 */
const role: FakeRole = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1" ? "worker" : "pm";

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function sessionScriptMatches(entry: FakeSessionScript): boolean {
  const cwd = realOrSelf(process.cwd());
  if (entry.role !== undefined && entry.role !== role) return false;
  if (entry.cwd !== undefined && realOrSelf(entry.cwd) !== cwd) return false;
  if (entry.cwdUnder !== undefined) {
    const root = realOrSelf(entry.cwdUnder);
    if (cwd !== root && !cwd.startsWith(root.endsWith(sep) ? root : root + sep)) return false;
  }
  return true;
}

/** sessions 里选中的下标；没选中是 null（用顶层剧本）。 */
const sessionScriptIndex: number | null = (() => {
  const i = (topScript.sessions ?? []).findIndex(sessionScriptMatches);
  return i === -1 ? null : i;
})();
const script: FakeScript = sessionScriptIndex === null ? topScript : topScript.sessions![sessionScriptIndex]!.script;
const model = script.model ?? "claude-haiku-5-5";
const tools = script.tools ?? ["Bash", "Read", "Edit"];

function log(entry: FakeLogEntry): void {
  if (logFile) appendFileSync(logFile, JSON.stringify(entry) + "\n");
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function exit(code: number): never {
  log({ kind: "exit", pid: myPid, code });
  process.exit(code);
}

// --- 会话存不存在（跨进程） ---

function sessionFile(id: string): string | undefined {
  if (!stateDir) return undefined;
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 16);
  return join(stateDir, `fake-session-${hash}`);
}

/** 没有状态目录时记在内存里。 */
const memorySessions = new Set<string>();
let memoryTurns = 0;

function sessionExists(id: string): boolean {
  const file = sessionFile(id);
  return file === undefined ? memorySessions.has(id) : existsSync(file);
}

function createSession(id: string): void {
  const file = sessionFile(id);
  if (!file) {
    memorySessions.add(id);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, id);
}

function nextTurnIndex(): number {
  if (!stateDir) return memoryTurns++;
  mkdirSync(stateDir, { recursive: true });
  // 顶层剧本跨进程一起数；按会话选中的剧本按会话 ID 分开数（见 FakeSessionScript）
  const file =
    sessionScriptIndex === null
      ? join(stateDir, "fake-turns")
      : join(stateDir, `fake-turns-${sessionScriptIndex}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`);
  const n = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  writeFileSync(file, String(n + 1));
  return n;
}

// --- 参数 ---

const argv = process.argv.slice(2);
log({ kind: "argv", pid: myPid, argv, cwd: process.cwd() });
if (process.env.FAKE_CLAUDE_PROBE) {
  try {
    writeFileSync(process.env.FAKE_CLAUDE_PROBE, "probe");
    log({ kind: "probe", pid: myPid, ok: true });
  } catch (error) {
    log({ kind: "probe", pid: myPid, ok: false, code: (error as NodeJS.ErrnoException).code });
  }
}

/** 测试关心的环境变量：每个会话自己的令牌、socket、PATH，Worker 关自动记忆的那个。 */
const LOGGED_ENV = ["HUB_TOKEN", "HUB_SOCK", "PATH", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"] as const;
log({
  kind: "env",
  pid: myPid,
  env: Object.fromEntries(LOGGED_ENV.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]]))),
});
log({ kind: "script", pid: myPid, role, session: sessionScriptIndex });

function argValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const newSessionId = argValue("--session-id");
const resumeId = argValue("--resume");
const sessionId = newSessionId ?? resumeId ?? randomUUID();

if (newSessionId !== undefined && (script.rejectSessionArgs || sessionExists(newSessionId))) {
  process.stderr.write(`Error: Session ID ${newSessionId} is already in use.\n`);
  exit(1);
}
if (resumeId !== undefined && (script.rejectSessionArgs || !sessionExists(resumeId))) {
  process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
  emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    session_id: resumeId,
    total_cost_usd: 0,
    usage: {},
    permission_denials: [],
    uuid: randomUUID(),
  });
  exit(1);
}

function spawnChild({ sleepSec, detached = false }: ChildSpec): void {
  const child = spawn("sleep", [String(sleepSec)], { stdio: "ignore", detached });
  child.unref();
  log({ kind: "child", pid: myPid, childPid: child.pid ?? -1 });
}

if (script.spawnChildOnStart !== undefined) {
  spawnChild(typeof script.spawnChildOnStart === "number" ? { sleepSec: script.spawnChildOnStart } : script.spawnChildOnStart);
}

// --- 一轮一轮跑 ---

type UserContent = { type: "text"; text: string };

/** 收到还没取走的一条：uuid 是 user 行里带的（command_lifecycle 用）。 */
interface InboxEntry {
  content: UserContent[];
  uuid?: string;
}

const inbox: InboxEntry[] = [];
/** 真 claude 的一轮中途取走和 command_lifecycle（剧本 capabilities 里有 msg_lifecycle_v1）。 */
const lifecycle = (script.capabilities ?? []).includes("msg_lifecycle_v1");
/** 这一轮已经取走（started）的消息 uuid：result 之后出 completed，打断之后出 cancelled。 */
let turnCommands: string[] = [];

function emitLifecycle(uuid: string | undefined, state: "queued" | "started" | "completed" | "cancelled"): void {
  if (!lifecycle || uuid === undefined) return;
  emit({ type: "command_lifecycle", command_uuid: uuid, state, uuid: randomUUID(), session_id: sessionId });
}

/** 当前工具跑完：忙时写进来的几条在同一轮里取走，各自回显、各自 started。 */
function takeMidTurn(): void {
  if (!lifecycle) return;
  for (const entry of inbox.splice(0)) {
    emit({ type: "user", message: { role: "user", content: entry.content }, parent_tool_use_id: null, session_id: sessionId, uuid: entry.uuid ?? randomUUID(), isReplay: true });
    emitLifecycle(entry.uuid, "started");
    if (entry.uuid !== undefined) turnCommands.push(entry.uuid);
  }
}
let busy = false;
let stdinClosed = false;
/** 当前这一轮的编号；打断时加一，旧的那一轮看到编号变了就不再往下做。 */
let turnSeq = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function result(subtype: string, isError: boolean, text: string, startedAt: number, usage?: Record<string, number>, selfStarted = false): void {
  emit({
    ...(selfStarted ? { origin: { kind: "task-notification", producer: "session-task" } } : {}),
    type: "result",
    subtype,
    is_error: isError,
    duration_ms: Date.now() - startedAt,
    duration_api_ms: Date.now() - startedAt,
    num_turns: 1,
    result: text,
    session_id: sessionId,
    total_cost_usd: 0.0011,
    usage: usage ?? { input_tokens: 10, output_tokens: 5 },
    permission_denials: [],
    uuid: randomUUID(),
  });
}

/** 正在跑的工具调用（被打断时用 “for tool use” 的标记）。 */
let inTool = false;

function interruptedMarker(): void {
  emit({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: inTool ? INTERRUPT_TOOL_TEXT : INTERRUPT_TEXT }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  });
}

function assistant(
  content: unknown[],
  withUuid = true,
  extra: { usage?: Record<string, number>; messageId?: string; parentToolUseId?: string } = {},
): void {
  const event: Record<string, unknown> = {
    type: "assistant",
    message: {
      id: extra.messageId ?? `msg_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: null,
      usage: extra.usage ?? { input_tokens: 10, output_tokens: 5 },
    },
    parent_tool_use_id: extra.parentToolUseId ?? null,
    session_id: sessionId,
  };
  if (withUuid) event.uuid = randomUUID();
  emit(event);
}

let currentTurnStartedAt = 0;

/** content 为 null：claude 自己开的一轮（selfTurn），turn 是它的剧本；不回显、不数轮数。uuids：开这一轮的消息（command_lifecycle 用）。 */
async function runTurn(content: UserContent[] | null, selfTurn?: FakeTurn, uuids: string[] = []): Promise<void> {
  busy = true;
  const seq = ++turnSeq;
  turnCommands = [...uuids];
  // 真 claude：消息被取走的 started 在这一轮的 init 之前
  for (const uuid of uuids) emitLifecycle(uuid, "started");
  const aborted = () => seq !== turnSeq;
  const startedAt = (currentTurnStartedAt = Date.now());
  const turn: FakeTurn = selfTurn ?? script.turns?.[nextTurnIndex()] ?? script.defaultTurn ?? { steps: [{ text: "ok" }] };
  if (newSessionId !== undefined) createSession(newSessionId);
  if (content === null) {
    emit({ type: "system", subtype: "task_notification", status: "completed", session_id: sessionId, uuid: randomUUID() });
  }
  emit({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: sessionId,
    tools,
    mcp_servers: [],
    model,
    permissionMode: "default",
    apiKeySource: "none",
    ...(script.capabilities ? { capabilities: script.capabilities } : {}),
    uuid: randomUUID(),
  });
  let replayed = content === null;
  const replay = () => {
    if (replayed || content === null) return;
    replayed = true;
    emit({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: randomUUID(),
      isReplay: true,
    });
  };
  if (!script.lateReplay) replay();
  let lastText = "";
  for (const step of turn.steps ?? []) {
    if (aborted()) break;
    if (!("sleepMs" in step) && !("waitFile" in step)) replay();
    if ("sleepMs" in step) {
      await sleep(step.sleepMs);
    } else if ("waitFile" in step) {
      while (!existsSync(step.waitFile) && !aborted()) await sleep(20);
    } else if ("text" in step) {
      lastText = step.text;
      assistant([{ type: "text", text: step.text }], !step.noUuid, step);
    } else if ("thinking" in step) {
      assistant([{ type: "thinking", thinking: "", signature: "sig" }]);
    } else if ("tool" in step) {
      const id = `toolu_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      assistant([{ type: "tool_use", id, name: step.tool.name, input: step.tool.input }]);
      if (step.tool.durationMs) {
        inTool = true;
        await sleep(step.tool.durationMs);
        inTool = false;
        if (aborted()) break;
      }
      emit({
        type: "user",
        message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: step.tool.result ?? "" }] },
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: randomUUID(),
      });
      takeMidTurn();
    } else if ("rateLimit" in step) {
      emit({ type: "rate_limit_event", rate_limit_info: step.rateLimit, uuid: randomUUID(), session_id: sessionId });
    } else if ("raw" in step) {
      process.stdout.write(step.raw + "\n");
    } else if ("stopReading" in step) {
      rl.pause();
    } else if ("exit" in step) {
      exit(step.exit);
    } else if ("apiRetry" in step) {
      emit({
        type: "system",
        subtype: "api_retry",
        attempt: step.apiRetry.attempt ?? 1,
        max_retries: step.apiRetry.maxRetries ?? 10,
        retry_delay_ms: step.apiRetry.retryDelayMs ?? 500,
        error_status: step.apiRetry.errorStatus === undefined ? 529 : step.apiRetry.errorStatus,
        error: step.apiRetry.error ?? "overloaded",
        session_id: sessionId,
        uuid: randomUUID(),
      });
    } else if ("spawnOrphan" in step) {
      const orphan = spawn("sleep", [String(step.spawnOrphan.sleepSec)], { stdio: ["ignore", "inherit", "inherit"], detached: true });
      orphan.unref();
      log({ kind: "orphan", pid: myPid, orphanPid: orphan.pid ?? -1 });
    } else if ("spawnChild" in step) {
      spawnChild(step.spawnChild);
    } else if ("backgroundTasks" in step) {
      emitBackgroundTasks(step.backgroundTasks);
    } else if ("bash" in step) {
      const id = `toolu_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      assistant([{ type: "tool_use", id, name: "Bash", input: { command: step.bash } }]);
      const { exitCode, output } = await runShell(step.bash);
      log({ kind: "bash", pid: myPid, command: step.bash, exitCode, output });
      if (aborted()) break;
      emit({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              tool_use_id: id,
              type: "tool_result",
              content: exitCode === 0 ? output : `Exit code ${exitCode}\n${output}`,
              is_error: exitCode !== 0,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: randomUUID(),
      });
      takeMidTurn();
    }
  }
  if (aborted()) return; // 打断的那条 result 已经由打断的地方发了
  replay();
  if (turn.rateLimit !== false) {
    emit({
      type: "rate_limit_event",
      rate_limit_info: turn.rateLimit ?? M0_RATE_LIMIT_INFO,
      uuid: randomUUID(),
      session_id: sessionId,
    });
  }
  const r = turn.result ?? {};
  result(r.subtype ?? "success", r.isError ?? false, r.result ?? lastText, startedAt, turn.usage, content === null);
  for (const uuid of turnCommands.splice(0)) emitLifecycle(uuid, "completed");
  for (const ev of turn.backgroundTasksAfter ?? []) setTimeout(() => emitBackgroundTasks(ev.tasks), ev.afterMs);
  const self = turn.selfTurn;
  finishTurn(self !== undefined);
  if (self !== undefined) {
    const fire = () => (busy ? setTimeout(fire, 20) : void runTurn(null, self));
    setTimeout(fire, self.afterMs ?? 50);
  }
}

function emitBackgroundTasks(tasks: BackgroundTaskSpec[] | "malformed"): void {
  const entry = (t: BackgroundTaskSpec) =>
    typeof t === "string" ? { task_id: t, run_id: `run-${t}`, task_type: "local_bash", description: `fake task ${t}` } : t;
  emit({
    type: "system",
    subtype: "background_tasks_changed",
    ...(tasks === "malformed" ? {} : { tasks: tasks.map(entry) }),
    uuid: randomUUID(),
    session_id: sessionId,
  });
}

/** sh -c 跑一条命令：环境变量、工作目录都是自己的；标准输入不接（/dev/null）。 */
function runShell(command: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = execFile("sh", ["-c", command], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ exitCode: code, output: `${stdout}${stderr}`.replace(/\n$/, "") });
    });
    child.stdin?.end();
  });
}

function finishTurn(holdExit = false): void {
  busy = false;
  const next = inbox.splice(0);
  if (next.length > 0) {
    void runTurn(
      next.flatMap((e) => e.content),
      undefined,
      next.flatMap((e) => (e.uuid === undefined ? [] : [e.uuid])),
    );
  } else if (stdinClosed && !holdExit) {
    exit(0);
  }
}

function badInput(message: string): never {
  process.stderr.write(message + "\n");
  exit(1);
}

/**
 * 后台写交接复制那份（daemon/handover/claude.ts）：`claude -p --fork-session …`，没有 --input-format stream-json，
 * 提示词是标准输入的纯文本，关掉标准输入才算说完。收齐后当一条用户消息跑一轮（日志里记成一行 user，stdinTextsOf 能读），回完退出。
 */
const rawPromptMode = argv.includes("--fork-session");
const rawPromptLines: string[] = [];

function onLine(line: string): void {
  if (rawPromptMode) {
    rawPromptLines.push(line);
    return;
  }
  log({ kind: "stdin", pid: myPid, line });
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    badInput(`Error parsing streaming input line (type=unknown, ${line.length} chars): SyntaxError`);
  }
  const msg = obj as {
    type?: unknown;
    uuid?: unknown;
    request_id?: unknown;
    request?: { subtype?: unknown; cancel_queued?: unknown };
    message?: { role?: unknown; content?: unknown };
  };
  // 驱动回我们发的控制请求（can_use_tool 的 allow/deny）：日志里记了就够，不是用户消息
  if (msg.type === "control_response") return;
  if (msg.type === "control_request") {
    if (script.ignoreControl) return;
    const handle = () => {
      if (script.control === "error") {
        emit({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "cannot interrupt now" } });
        return;
      }
      const interrupting = msg.request?.subtype === "interrupt" && script.control !== "ack_only";
      // 带 cancel_queued：还没取走的一并取消（真 claude 的回执 {still_queued:[], cancelled:[…]}），不再排到下一轮
      const cancel = interrupting && msg.request?.cancel_queued === true;
      const queued = inbox.flatMap((e) => (e.uuid === undefined ? [] : [e.uuid]));
      const body =
        msg.request?.subtype === "initialize"
          ? { commands: script.commands, models: [] }
          : msg.request?.subtype === "mcp_status"
            ? { mcpServers: script.mcpServers ?? [] }
            : cancel
              ? script.receiptWithoutCancelled
                ? { still_queued: [] }
                : { still_queued: [], cancelled: queued }
              : { still_queued: lifecycle ? queued : [] };
      emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: body } });
      if (cancel) for (const entry of inbox.splice(0)) emitLifecycle(entry.uuid, "cancelled");
      if (interrupting && busy) {
        turnSeq++;
        interruptedMarker();
        inTool = false;
        result("success", false, "", currentTurnStartedAt);
        // 真 claude：被打断的那一轮里取走过的消息，result 之后标 cancelled
        for (const uuid of turnCommands.splice(0)) emitLifecycle(uuid, "cancelled");
        finishTurn();
      }
    };
    if (script.controlDelayMs) setTimeout(handle, script.controlDelayMs);
    else handle();
    return;
  }
  if (msg.message?.role !== "user") badInput(`Error: Expected message role 'user', got '${String(msg.message?.role)}'`);
  const raw = msg.message.content;
  const content: UserContent[] =
    typeof raw === "string" ? [{ type: "text", text: raw }] : Array.isArray(raw) ? (raw as UserContent[]) : [];
  if (script.noInit) return;
  const uuid = typeof msg.uuid === "string" && msg.uuid !== "" ? msg.uuid : undefined;
  emitLifecycle(uuid, "queued");
  if (busy) inbox.push({ content, ...(uuid === undefined ? {} : { uuid }) });
  else void runTurn(content, undefined, uuid === undefined ? [] : [uuid]);
}

process.on("SIGINT", () => {
  log({ kind: "signal", pid: myPid, signal: "SIGINT" });
  if (script.ignoreSigint) return;
  if (busy) {
    turnSeq++;
    interruptedMarker();
    result("error_during_execution", true, "", currentTurnStartedAt);
  }
  exit(0);
});

log({ kind: "ready", pid: myPid });

const rl = createInterface({ input: process.stdin });
rl.on("line", onLine);
rl.on("close", () => {
  log({ kind: "stdin_closed", pid: myPid });
  if (script.ignoreStdinEnd) {
    setInterval(() => {}, 60_000); // 标准输入关了事件循环也不空，一直活着
    return;
  }
  stdinClosed = true;
  if (rawPromptMode) {
    const content: UserContent[] = [{ type: "text", text: rawPromptLines.join("\n") }];
    log({ kind: "stdin", pid: myPid, line: JSON.stringify({ type: "user", message: { role: "user", content } }) });
    void runTurn(content);
    return;
  }
  if (!busy) exit(0);
});

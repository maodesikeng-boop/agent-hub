// 端到端测试的零件：在临时数据目录里起真的守护进程（node src/daemon/main.ts），claude 换成假 claude；
// 用 HTTP + cookie 登录、发消息、拉状态，用 WebSocket 收推送。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeLogEntry, FakeScript } from "../fake-claude/fake-claude.ts";
import {
  API_PATHS,
  uiCookieName,
  ENV_AGY,
  ENV_CLAUDE,
  ENV_CODEX,
  ENV_HOME,
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  ENV_PORT,
  ENV_TAILSCALE,
  HUB_COMMAND,
  WORKER_ENV,
  type Change,
  type CreatePmRequest,
  type CreatePmResponse,
  type Message,
  type MessagesPage,
  type StateSnapshot,
  type WsServerMessage,
} from "../../src/shared/index.ts";

const MAIN = new URL("../../src/daemon/main.ts", import.meta.url).pathname;
/** 认本机回环网址当设备网址的测试入口（联机端到端，同机两个守护进程互相配对）。 */
export const LOOPBACK_MAIN = new URL("./loopback-daemon.ts", import.meta.url).pathname;
const FAKE_CLAUDE = new URL("../fake-claude/fake-claude.ts", import.meta.url).pathname;

const LOGIN_URL = /http:\/\/127\.0\.0\.1:(\d+)\/auth\?token=([A-Za-z0-9_-]+)/;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 每 50 毫秒查一次，直到 fn 返回非 undefined；超时抛错，带上最后一次的值方便看。 */
export async function waitUntil<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
    await sleep(50);
  }
}

/** Linux bwrap 内层假 claude 用 1_000_001+ 的合成 pid 并持有 fake-proc-<pid> 的打开 fd：在宿主机 /proc/<pid>/fd 里定位其真实宿主机 pid。 */
function hostPidOfFake(fakePid: number): number | null {
  if (process.platform !== "linux") return null;
  const suffix = `/fake-proc-${fakePid}`;
  let procs: string[];
  try {
    procs = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const entry of procs) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${entry}/fd/${fd}`).endsWith(suffix)) return Number(entry);
      } catch {
        // fd 已关闭或无权限
      }
    }
  }
  return null;
}

export function isAlive(pid: number): boolean {
  if (pid >= 1_000_000) return hostPidOfFake(pid) !== null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface RunningDaemon {
  child: ChildProcess;
  port: number;
  token: string;
  stdout(): string;
  stderr(): string;
  /** 等它退出，返回退出码（被信号结束时是 null）和信号。 */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface E2eEnv {
  dir: string;
  home: string;
  /** 假 claude 的记录和状态目录（跨守护进程重启保留，--resume 才认得会话）。 */
  fakeDir: string;
  /** 换剧本：下一次假 claude 起进程时生效。 */
  setScript(script: FakeScript): void;
  /** main：换守护进程入口（默认 MAIN）。 */
  start(options?: { claudePath?: string; env?: Record<string, string>; main?: string }): Promise<RunningDaemon>;
  /** 起一个预期马上退出的守护进程（比如第二个），返回退出码和输出。 */
  runToExit(): Promise<{ code: number | null; stdout: string; stderr: string }>;
  log(): FakeLogEntry[];
  /** 假 claude 收到的用户消息的文字：几个 text 块之间空一行连起来（我们加的字各占一块，原文放最后一块）。 */
  stdinTexts(): string[];
  /** 同上，每条消息的 text 块分开。 */
  stdinBlocks(): string[][];
  argvs(): Array<{ pid: number; argv: string[]; cwd: string }>;
  /** 假 claude 启动时记下的环境变量（HUB_TOKEN、HUB_SOCK、PATH……），按进程。 */
  envs(): Array<{ pid: number; env: Record<string, string> }>;
  /** 假 claude 的 bash 步骤跑过的命令和结果。 */
  bashRuns(): Array<{ pid: number; command: string; exitCode: number; output: string }>;
  /** 某个假 claude 进程收到的用户消息的文字。 */
  stdinTextsOf(pid: number): string[];
  /** 用某个假 claude 进程拿到的 HUB_TOKEN、HUB_SOCK 跑一次 run/bin/hub（就像 agent 自己敲的）。 */
  runHub(pid: number, args: string[], options?: { stdin?: string }): Promise<{ code: number | null; stdout: string; stderr: string }>;
  cleanup(): Promise<void>;
}

export function makeEnv(): E2eEnv {
  const dir = mkdtempSync(join(shortTmp(), "ah-e2e-"));
  const home = join(dir, "home");
  const fakeDir = join(dir, "fake");
  mkdirSync(fakeDir, { recursive: true });
  const logFile = join(fakeDir, "fake-claude.log");
  const scriptFile = join(fakeDir, "script.json");
  writeFileSync(scriptFile, "{}");
  const running = new Set<ChildProcess>();

  // 在 Worker 的会话里跑测试时，Worker 才有的环境变量（WORKER_ENV）会传下去，假 claude 就把项目经理也当成 Worker：去掉
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !(key in WORKER_ENV)));
  const baseEnv = (claudePath: string, extra: Record<string, string> = {}) => ({
    ...inherited,
    [ENV_HOME]: home,
    [ENV_CLAUDE]: claudePath,
    [ENV_AGY]: join(fakeDir, "no-agy"),
    [ENV_CODEX]: join(fakeDir, "no-codex"),
    [ENV_PORT]: "0",
    // 不去问这台机器真的 Tailscale：没有这个命令 = 没装，只认本机
    [ENV_TAILSCALE]: join(fakeDir, "no-tailscale"),
    FAKE_CLAUDE_LOG: logFile,
    FAKE_CLAUDE_SCRIPT: scriptFile,
    FAKE_CLAUDE_STATE: fakeDir,
    ...extra,
  });

  const spawnDaemon = (claudePath: string, extra?: Record<string, string>, main = MAIN) => {
    const child = spawn(process.execPath, [main], { env: baseEnv(claudePath, extra), stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);
    let out = "";
    let err = "";
    child.stdout!.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.stderr!.setEncoding("utf8").on("data", (c: string) => (err += c));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => {
        running.delete(child);
        resolve({ code, signal });
      });
    });
    return { child, exited, out: () => out, err: () => err };
  };

  const log = (): FakeLogEntry[] =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as FakeLogEntry)
      : [];

  return {
    dir,
    home,
    fakeDir,
    setScript: (script) => writeFileSync(scriptFile, JSON.stringify(script)),
    async start(options = {}) {
      const d = spawnDaemon(options.claudePath ?? FAKE_CLAUDE, options.env, options.main);
      const match = await Promise.race([
        waitUntil("login url", () => LOGIN_URL.exec(d.out()) ?? undefined, 15_000),
        d.exited.then(({ code }) => {
          throw new Error(`daemon exited early (code ${code}): ${d.err()}`);
        }),
      ]);
      return { child: d.child, port: Number(match[1]), token: match[2]!, stdout: d.out, stderr: d.err, exited: d.exited };
    },
    async runToExit() {
      const d = spawnDaemon(FAKE_CLAUDE);
      const { code } = await d.exited;
      return { code, stdout: d.out(), stderr: d.err() };
    },
    log,
    stdinTexts: () => userBlocks(log()).map((b) => b.join("\n\n")),
    stdinBlocks: () => userBlocks(log()),
    stdinTextsOf: (pid) => userBlocks(log().filter((e) => e.pid === pid)).map((b) => b.join("\n\n")),
    argvs: () => log().flatMap((e) => (e.kind === "argv" ? [{ pid: e.pid, argv: e.argv, cwd: e.cwd }] : [])),
    envs: () => log().flatMap((e) => (e.kind === "env" ? [{ pid: e.pid, env: e.env }] : [])),
    bashRuns: () => log().flatMap((e) => (e.kind === "bash" ? [{ pid: e.pid, command: e.command, exitCode: e.exitCode, output: e.output }] : [])),
    runHub(pid, args, options = {}) {
      const entry = log().find((e) => e.kind === "env" && e.pid === pid);
      if (entry?.kind !== "env") throw new Error(`no env logged for fake claude ${pid}`);
      const child = spawn(join(home, "run", "bin", HUB_COMMAND), args, {
        env: { PATH: process.env.PATH, [ENV_HUB_TOKEN]: entry.env[ENV_HUB_TOKEN], [ENV_HUB_SOCK]: entry.env[ENV_HUB_SOCK] },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
      child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
      child.stdin.end(options.stdin ?? "");
      return new Promise((resolve) => child.once("close", (code) => resolve({ code, stdout, stderr })));
    },
    async cleanup() {
      for (const child of running) child.kill("SIGKILL");
      await sleep(50);
      // 万一有假 claude 留下（测试失败时），也结束掉
      for (const { pid } of this.argvs()) {
        const realPid = pid >= 1_000_000 ? hostPidOfFake(pid) : isAlive(pid) ? pid : null;
        if (realPid !== null) {
          try {
            process.kill(realPid, "SIGKILL");
          } catch {
            // 已经退出
          }
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function userBlocks(entries: FakeLogEntry[]): string[][] {
  return entries.flatMap((e) => {
    if (e.kind !== "stdin") return [];
    const obj = JSON.parse(e.line) as { type: string; message?: { content: Array<{ text: string }> } };
    return obj.type === "user" ? [obj.message!.content.map((c) => c.text)] : [];
  });
}

/** 登录后的界面客户端：带 cookie 和同源的 Origin，跟浏览器一样。 */
export class Client {
  readonly base: string;
  readonly cookie: string;
  constructor(port: number, cookie: string) {
    this.base = `http://127.0.0.1:${port}`;
    this.cookie = cookie;
  }

  static async login(daemon: RunningDaemon): Promise<Client> {
    const res = await fetch(`http://127.0.0.1:${daemon.port}${API_PATHS.auth}?token=${daemon.token}`, { redirect: "manual" });
    if (res.status !== 302) throw new Error(`login failed: ${res.status}`);
    const setCookie = res.headers.get("set-cookie") ?? "";
    return new Client(daemon.port, setCookie.split(";", 1)[0]!);
  }

  /** 同一个会话换一个端口（守护进程重启后）：会话在库里，重启后还认；cookie 名带端口，所以名字跟着换。 */
  withPort(port: number): Client {
    return new Client(port, `${uiCookieName(`127.0.0.1:${port}`)}=${this.cookie.slice(this.cookie.indexOf("=") + 1)}`);
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return { cookie: this.cookie, origin: this.base, ...extra };
  }

  async get(path: string): Promise<Response> {
    return fetch(this.base + path, { headers: this.headers() });
  }

  /** GET /api/state 原样（初始快照只带每个对话最近一段，见 shared/snapshot.ts）。 */
  async snapshot(): Promise<StateSnapshot> {
    const res = await this.get(API_PATHS.state);
    if (res.status !== 200) throw new Error(`GET /api/state: ${res.status}`);
    return (await res.json()) as StateSnapshot;
  }

  /** 初始快照 + 每个对话更早的消息（像网页往上翻页一样按 before 拉齐）：测试要看对话里的全部消息。 */
  async state(): Promise<StateSnapshot> {
    const snapshot = await this.snapshot();
    const conversations = await Promise.all(
      snapshot.conversations.map(async (c) => {
        let messages = c.messages;
        let hasMore = c.hasMore;
        while (hasMore) {
          const res = await this.get(`${API_PATHS.messages(c.conversation.id)}?before=${messages[0]?.id ?? Number.MAX_SAFE_INTEGER}`);
          if (res.status !== 200) throw new Error(`GET messages: ${res.status}`);
          const page = (await res.json()) as MessagesPage;
          messages = [...page.messages, ...messages];
          hasMore = page.hasMore;
        }
        return { ...c, messages, hasMore: false };
      }),
    );
    return { ...snapshot, conversations };
  }

  async post(conversationId: number, text: string, clientId = crypto.randomUUID()): Promise<number> {
    const res = await fetch(this.base + API_PATHS.messages(conversationId), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ clientId, text }),
    });
    if (res.status !== 200) throw new Error(`POST message: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { messageId: number }).messageId;
  }

  async postJson(path: string, body: unknown): Promise<Response> {
    return fetch(this.base + path, {
      method: "POST",
      headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async putJson(path: string, body: unknown): Promise<Response> {
    return fetch(this.base + path, { method: "PUT", headers: this.headers({ "content-type": "application/json" }), body: JSON.stringify(body) });
  }

  async createPm(input: CreatePmRequest): Promise<CreatePmResponse> {
    const res = await this.postJson(API_PATHS.pms, input);
    if (res.status !== 201) throw new Error(`POST /api/pms: ${res.status} ${await res.text()}`);
    return (await res.json()) as CreatePmResponse;
  }

  async retry(messageId: number): Promise<number> {
    return (await this.postJson(API_PATHS.retryMessage(messageId), undefined)).status;
  }

  async stop(conversationId: number): Promise<number> {
    const res = await fetch(this.base + API_PATHS.stop(conversationId), { method: "POST", headers: this.headers() });
    return res.status;
  }

  /** 连 WebSocket，收到的推送都放进 messages。 */
  async ws(since?: number): Promise<{ messages: WsServerMessage[]; close(): void }> {
    const url = `ws://127.0.0.1:${new URL(this.base).port}${API_PATHS.ws}${since === undefined ? "" : `?since=${since}`}`;
    const socket = new WebSocket(url, { headers: this.headers() });
    const messages: WsServerMessage[] = [];
    socket.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data)) as WsServerMessage));
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("websocket error")));
    });
    return { messages, close: () => socket.close() };
  }
}

export function messagesOf(state: StateSnapshot, conversationId: number): Message[] {
  return state.conversations.find((c) => c.conversation.id === conversationId)?.messages ?? [];
}

export function messageById(state: StateSnapshot, id: number): Message | undefined {
  return state.conversations.flatMap((c) => c.messages).find((m) => m.id === id);
}

/** 等某条消息到某个状态。 */
export function waitForStatus(client: Client, id: number, status: string, timeoutMs = 10_000): Promise<Message> {
  return waitUntil(
    `message ${id} → ${status}`,
    async () => {
      const m = messageById(await client.state(), id);
      return m?.status === status ? m : undefined;
    },
    timeoutMs,
  );
}

export function agentTexts(state: StateSnapshot, conversationId: number): string[] {
  return messagesOf(state, conversationId)
    .filter((m) => m.sender === "agent" && m.kind === "text")
    .map((m) => m.text);
}

/** unix socket 路径有长度上限（macOS 103 字节）：系统临时目录太长时（macOS 的 $TMPDIR 经常很长）改用 /tmp。 */
function shortTmp(): string {
  const base = tmpdir();
  return base.length <= 40 || !existsSync("/tmp") ? base : "/tmp";
}

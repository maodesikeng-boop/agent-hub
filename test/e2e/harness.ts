// 端到端测试的零件：在临时数据目录里起真的守护进程（node src/daemon/main.ts），claude 换成假 claude；
// 用 HTTP + cookie 登录、发消息、拉状态，用 WebSocket 收推送。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeLogEntry, FakeScript } from "../fake-claude/fake-claude.ts";
import {
  API_PATHS,
  ENV_CLAUDE,
  ENV_HOME,
  ENV_PORT,
  type Change,
  type Message,
  type StateSnapshot,
  type WsServerMessage,
} from "../../src/shared/index.ts";

export const MAIN = new URL("../../src/daemon/main.ts", import.meta.url).pathname;
export const FAKE_CLAUDE = new URL("../fake-claude/fake-claude.ts", import.meta.url).pathname;

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

export function isAlive(pid: number): boolean {
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
  start(options?: { claudePath?: string; env?: Record<string, string> }): Promise<RunningDaemon>;
  /** 起一个预期马上退出的守护进程（比如第二个），返回退出码和输出。 */
  runToExit(): Promise<{ code: number | null; stdout: string; stderr: string }>;
  log(): FakeLogEntry[];
  /** 假 claude 收到的用户消息的文字。 */
  stdinTexts(): string[];
  argvs(): Array<{ pid: number; argv: string[]; cwd: string }>;
  cleanup(): Promise<void>;
}

export function makeEnv(): E2eEnv {
  const dir = mkdtempSync(join(tmpdir(), "agent-hub-e2e-"));
  const home = join(dir, "home");
  const fakeDir = join(dir, "fake");
  mkdirSync(fakeDir, { recursive: true });
  const logFile = join(fakeDir, "fake-claude.log");
  const scriptFile = join(fakeDir, "script.json");
  writeFileSync(scriptFile, "{}");
  const running = new Set<ChildProcess>();

  const baseEnv = (claudePath: string, extra: Record<string, string> = {}) => ({
    ...process.env,
    [ENV_HOME]: home,
    [ENV_CLAUDE]: claudePath,
    [ENV_PORT]: "0",
    FAKE_CLAUDE_LOG: logFile,
    FAKE_CLAUDE_SCRIPT: scriptFile,
    FAKE_CLAUDE_STATE: fakeDir,
    ...extra,
  });

  const spawnDaemon = (claudePath: string, extra?: Record<string, string>) => {
    const child = spawn(process.execPath, [MAIN], { env: baseEnv(claudePath, extra), stdio: ["ignore", "pipe", "pipe"] });
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
      const d = spawnDaemon(options.claudePath ?? FAKE_CLAUDE, options.env);
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
    stdinTexts: () =>
      log().flatMap((e) => {
        if (e.kind !== "stdin") return [];
        const obj = JSON.parse(e.line) as { type: string; message?: { content: Array<{ text: string }> } };
        return obj.type === "user" ? [obj.message!.content.map((c) => c.text).join("")] : [];
      }),
    argvs: () => log().flatMap((e) => (e.kind === "argv" ? [{ pid: e.pid, argv: e.argv, cwd: e.cwd }] : [])),
    async cleanup() {
      for (const child of running) child.kill("SIGKILL");
      await sleep(50);
      // 万一有假 claude 留下（测试失败时），也结束掉
      for (const { pid } of this.argvs()) if (isAlive(pid)) process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    },
  };
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

  /** 同一个 cookie 换一个端口（守护进程重启后）。 */
  withPort(port: number): Client {
    return new Client(port, this.cookie);
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return { cookie: this.cookie, origin: this.base, ...extra };
  }

  async get(path: string): Promise<Response> {
    return fetch(this.base + path, { headers: this.headers() });
  }

  async state(): Promise<StateSnapshot> {
    const res = await this.get(API_PATHS.state);
    if (res.status !== 200) throw new Error(`GET /api/state: ${res.status}`);
    return (await res.json()) as StateSnapshot;
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

export type { Change };

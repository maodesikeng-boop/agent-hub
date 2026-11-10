// codex 复制会话去后台写交接的办法（docs/background-handover-design.md 第 2.3、2.6 节）。
// 单独起一个不带 HUB_* 的 `codex app-server`，`thread/fork` 复制项目经理的 thread（带 `ephemeral: true`：不落盘、不进用户的 codex 历史，
// #121 实测上文照样带得过去、能答出原会话里的暗号），在同一个进程里 `turn/start` 写交接。ephemeral 的 thread 只活在这个进程里，
// 所以 fork 起的进程按 forkId 留在 SERVERS 里给 write / remove 用，remove 杀掉进程就等于删了（thread/delete 对它会报“not persisted”，当保险调、忽略报错）。
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { TokenUsage } from "../../shared/domain.ts";
import type { ForkHandle } from "../../shared/handover.ts";
import {
  CODEX_CLIENT_INFO,
  buildCodexArgs,
  readCodexLaunchConfig,
  serializeJsonRpcLine,
} from "../driver/codex-protocol.ts";
import { signalPid, termGroupAfterExit } from "../driver/process.ts";
import { buildChildEnv } from "../driver/protocol.ts";
import { trackChild } from "../process-ledger.ts";
import { ForkUnsupportedError, withoutHubEnv } from "./forker.ts";
import type { ForkSource, ForkWriteResult, SessionForker } from "./forker.ts";

/** 复制那份的权限：只读、从不问（只写交接，用不着工具；codex 本来就不走缓存，收紧不影响）。 */
const CODEX_FORK_SANDBOX = "read-only";
const CODEX_FORK_APPROVAL_POLICY = "never";
const CODEX_FORK_SANDBOX_POLICY = { type: "readOnly", networkAccess: true } as const;
/** fork_ref 里 forker 的 id（发布后不改）。 */
export const CODEX_NATIVE_FORKER_ID = "codex-native";
/** 正在干活的 app-server 进程多久没退出就强杀。 */
const CLOSE_GRACE_MS = 2_000;

/** codex 报“这个 thread 不在 / 没落盘”的几种话：remove 当成已经删了。 */
const GONE_PATTERN = /not persisted|not loaded|not found|no such thread|unknown thread/i;

type Json = Record<string, unknown>;

interface Pending {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
}

/** 一个 app-server 进程上的 JSON-RPC：请求等回执、通知交给 onNotification、服务端反向请求（审批）一律拒绝。 */
class CodexRpc {
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(method: string, params: Json) => void>();
  #nextId = 0;
  #buffer = "";
  #exited: Error | null = null;
  /** 进程退出时 reject（write 等一轮的时候一起等它，进程中途没了就别干等）。 */
  readonly exitedError: Promise<never>;
  #rejectExited!: (error: Error) => void;

  constructor(child: ChildProcess) {
    this.#child = child;
    this.exitedError = new Promise<never>((_, reject) => (this.#rejectExited = reject));
    this.exitedError.catch(() => {});
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#onData(chunk));
    child.once("exit", (code, signal) => {
      // 不管是 close() 关的还是它自己先退的：确认退出这一刻给它原来的进程组（detached 起的，只有它和后代）补信号
      termGroupAfterExit(child);
      this.#onExit(new Error(`codex app-server 退出了（code ${code}, signal ${signal}）`));
    });
    child.once("error", (error) => this.#onExit(error));
    child.stdin?.on("error", () => {});
  }

  get exited(): boolean {
    return this.#exited !== null;
  }

  request(method: string, params: Json): Promise<Json> {
    if (this.#exited) return Promise.reject(this.#exited);
    const id = ++this.#nextId;
    return new Promise<Json>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string): void {
    this.#write({ jsonrpc: "2.0", method });
  }

  listen(fn: (method: string, params: Json) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** 杀进程（先 SIGTERM，宽限后 SIGKILL）；幂等。 */
  async close(): Promise<void> {
    if (this.#exited) return;
    const done = new Promise<void>((resolve) => this.#child.once("exit", () => resolve()));
    this.#child.stdin?.end();
    this.#child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (this.#child.pid !== undefined && this.#child.pid > 1) signalPid(-this.#child.pid, "SIGKILL");
      this.#child.kill("SIGKILL");
    }, CLOSE_GRACE_MS);
    await done;
    clearTimeout(timer);
  }

  #write(payload: Json): void {
    this.#child.stdin?.write(`${serializeJsonRpcLine(payload)}\n`);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index: number;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line === "") continue;
      let message: Json;
      try {
        message = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      this.#onMessage(message);
    }
  }

  #onMessage(message: Json): void {
    const { id, method } = message;
    if (typeof method === "string") {
      if (id !== undefined) {
        // 服务端反向请求（审批等）：复制那份不该碰任何东西，一律拒绝
        this.#write({ jsonrpc: "2.0", id, result: { decision: "decline" } });
        return;
      }
      for (const fn of [...this.#listeners]) fn(method, (message.params as Json | undefined) ?? {});
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve((message.result as Json | undefined) ?? {});
  }

  #onExit(error: Error): void {
    if (this.#exited) return;
    this.#exited = error;
    this.#rejectExited(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export interface CodexForkerOptions {
  /** 起进程，测试用假的。 */
  spawnProcess?: (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => ChildProcess;
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");
const numberOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** 一轮里每次请求的 usage 累加：codex 的 inputTokens 含缓存，转成 claude 口径（input 不含缓存）；context 取最后一次请求的输入量。 */
function addUsage(total: TokenUsage, last: Json): TokenUsage {
  const input = numberOf(last.inputTokens);
  const cached = numberOf(last.cachedInputTokens);
  return {
    input: total.input + Math.max(0, input - cached),
    cacheRead: total.cacheRead + cached,
    cacheWrite: total.cacheWrite + numberOf(last.cacheWriteInputTokens),
    output: total.output + numberOf(last.outputTokens),
    context: input,
  };
}

export function createCodexForker(options: CodexForkerOptions = {}): SessionForker {
  const spawnProcess =
    options.spawnProcess ??
    ((command, args, opts) => {
      const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "ignore"], detached: true });
      trackChild(child, "handover:codex", { detached: true });
      return child;
    });
  /** forkId → 复制那份所在的 app-server 进程（ephemeral 的 thread 只活在里面）。 */
  const servers = new Map<string, CodexRpc>();

  async function startServer(src: ForkSource): Promise<CodexRpc> {
    const launch = withoutHubEnv(src.launch);
    const env = withoutHubEnv({ ...launch, env: buildChildEnv(process.env, launch.env) }).env;
    const child = spawnProcess(src.executablePath, buildCodexArgs(), { cwd: src.cwd, env });
    const rpc = new CodexRpc(child);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
        // 假进程 / 已经起来了的没有 spawn 事件
        if (child.pid !== undefined) resolve();
      });
      await rpc.request("initialize", { clientInfo: { ...CODEX_CLIENT_INFO }, capabilities: { experimentalApi: true } });
      rpc.notify("initialized");
    } catch (error) {
      await rpc.close();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ForkUnsupportedError(`找不到 codex：${src.executablePath}`);
      throw error;
    }
    return rpc;
  }

  return {
    id: CODEX_NATIVE_FORKER_ID,
    kind: "native",

    async fork(src, signal): Promise<ForkHandle> {
      if (signal.aborted) throw new Error("复制被取消");
      const rpc = await startServer(src);
      const onAbort = (): void => void rpc.close();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const launch = readCodexLaunchConfig(withoutHubEnv(src.launch));
        const result = await rpc.request("thread/fork", {
          threadId: src.vendorSessionId,
          cwd: src.cwd,
          model: src.model ?? undefined,
          developerInstructions: launch.developerInstructions,
          sandbox: CODEX_FORK_SANDBOX,
          approvalPolicy: CODEX_FORK_APPROVAL_POLICY,
          config: launch.config,
          ephemeral: true,
          excludeTurns: true,
        });
        const forkId = textOf((result.thread as Json | undefined)?.id);
        if (forkId === "") throw new Error("thread/fork 没有返回 thread id");
        servers.set(forkId, rpc);
        return { forkId };
      } catch (error) {
        await rpc.close();
        if (error instanceof Error && /thread not found|no rollout found|not found/i.test(error.message)) {
          throw new ForkUnsupportedError(`codex 找不到要复制的 thread：${error.message}`);
        }
        throw error;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },

    async write(src, fork, prompt, signal): Promise<ForkWriteResult> {
      const rpc = servers.get(fork.forkId);
      if (!rpc || rpc.exited) throw new Error(`复制那份的 codex 进程不在了：${fork.forkId}`);
      const texts: string[] = [];
      let usage: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 };
      let turnId: string | null = null;
      let unlisten = (): void => {};
      const done = new Promise<void>((resolve, reject) => {
        unlisten = rpc.listen((method, params) => {
          if (method === "turn/started") turnId = textOf((params.turn as Json | undefined)?.id) || turnId;
          else if (method === "thread/tokenUsage/updated") {
            const last = (params.tokenUsage as Json | undefined)?.last;
            if (typeof last === "object" && last !== null) usage = addUsage(usage, last as Json);
          } else if (method === "item/completed") {
            const item = (params.item as Json | undefined) ?? {};
            if (item.type === "agentMessage") texts.push(textOf(item.text));
          } else if (method === "turn/completed") {
            const turn = (params.turn as Json | undefined) ?? {};
            if (turn.status === "completed") resolve();
            else reject(new Error(`写交接那一轮没成（${textOf(turn.status)}）：${JSON.stringify(turn.error ?? null)}`));
          }
        });
      });
      const onAbort = (): void => {
        if (turnId !== null) void rpc.request("turn/interrupt", { threadId: fork.forkId, turnId }).catch(() => {});
        void rpc.close();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await rpc.request("turn/start", {
          threadId: fork.forkId,
          input: [{ type: "text", text: prompt }],
          cwd: src.cwd,
          model: src.model ?? undefined,
          effort: src.effort ?? undefined,
          summary: "detailed",
          sandboxPolicy: CODEX_FORK_SANDBOX_POLICY,
        });
        await Promise.race([done, rpc.exitedError]);
        return { text: texts.join("\n\n"), usage };
      } finally {
        unlisten();
        signal.removeEventListener("abort", onAbort);
      }
    },

    async remove(fork): Promise<void> {
      const rpc = servers.get(fork.forkId);
      servers.delete(fork.forkId);
      if (!rpc) return; // ephemeral 的 thread 随进程没了（重启后也是）
      try {
        // 保险：万一这版 codex 没把它当 ephemeral 落了盘，就按“先删复制那份”的顺序删掉；ephemeral 的会报 not persisted，忽略
        await rpc.request("thread/delete", { threadId: fork.forkId });
      } catch (error) {
        if (!(error instanceof Error) || !GONE_PATTERN.test(error.message)) {
          // 删不掉也要关进程；报给跑腿的记日志，下次启动再试
          await rpc.close();
          throw error;
        }
      }
      await rpc.close();
    },
  };
}

export const CODEX_FORKERS: readonly SessionForker[] = [createCodexForker()];

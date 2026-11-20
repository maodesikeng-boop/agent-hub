// thread/fork with ephemeral: true keeps the copy out of codex history; it lives only in this app-server process.
import type { ChildProcess } from "node:child_process";
import type { TokenUsage } from "../../shared/domain.ts";
import type { ForkHandle } from "../../shared/handover.ts";
import {
  CODEX_CLIENT_INFO,
  buildCodexArgs,
  readCodexLaunchConfig,
  serializeJsonRpcLine,
} from "./protocol.ts";
import { signalPid, termGroupAfterExit } from "../../daemon/driver/process.ts";
import { buildChildEnv } from "../../daemon/driver/protocol.ts";
import { spawnOwnedProcess } from "../../daemon/platform/index.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import { ForkUnsupportedError, withoutHubEnv } from "../../daemon/handover/forker.ts";
import type { ForkSource, ForkWriteResult, SessionForker } from "../../daemon/handover/forker.ts";

const CODEX_FORK_SANDBOX = "read-only";
const CODEX_FORK_APPROVAL_POLICY = "never";
const CODEX_FORK_SANDBOX_POLICY = { type: "readOnly", networkAccess: true } as const;
export const CODEX_NATIVE_FORKER_ID = "codex-native";
const CLOSE_GRACE_MS = 2_000;

const GONE_PATTERN = /not persisted|not loaded|not found|no such thread|unknown thread/i;

type Json = Record<string, unknown>;

interface Pending {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
}

class CodexRpc {
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(method: string, params: Json) => void>();
  #nextId = 0;
  #buffer = "";
  #exited: Error | null = null;
  #processExited = false;
  #closing: Promise<void> | null = null;
  readonly exitedError: Promise<never>;
  #rejectExited!: (error: Error) => void;

  constructor(child: ChildProcess) {
    this.#child = child;
    this.exitedError = new Promise<never>((_, reject) => (this.#rejectExited = reject));
    this.exitedError.catch(() => {});
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#onData(chunk));
    child.once("exit", (code, signal) => {
      this.#processExited = true;
      termGroupAfterExit(child);
      this.#onExit(new Error(`codex app-server 退出了（code ${code}, signal ${signal}）`));
    });
    child.once("error", (error) => {
      if (child.pid === undefined) this.#processExited = true;
      this.#onExit(error);
    });
    child.stdin?.on("error", () => {});
  }

  get exited(): boolean {
    return this.#exited !== null;
  }

  get closing(): boolean {
    return this.#closing !== null;
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

  async close(): Promise<void> {
    if (this.#processExited) return;
    this.#closing ??= (async () => {
      const done = new Promise<void>((resolve) => this.#child.once("exit", () => resolve()));
      this.#child.stdin?.end();
      this.#child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (this.#child.pid !== undefined && this.#child.pid > 1) signalPid(-this.#child.pid, "SIGKILL");
        this.#child.kill("SIGKILL");
      }, CLOSE_GRACE_MS);
      await done;
      clearTimeout(timer);
    })();
    return this.#closing;
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
  spawnProcess?: (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => ChildProcess;
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");
const numberOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

// codex inputTokens include cached tokens.
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
      const spawned = spawnOwnedProcess(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "ignore"] });
      const { child, detached } = spawned;
      trackChild(child, "handover:codex", { detached });
      return child;
    });
  const servers = new Map<string, CodexRpc>();

  async function startServer(src: ForkSource, signal: AbortSignal): Promise<CodexRpc> {
    const env = buildChildEnv(process.env, withoutHubEnv(src.launch).env);
    const child = spawnProcess(src.executablePath, buildCodexArgs(), { cwd: src.cwd, env });
    const rpc = new CodexRpc(child);
    const onAbort = (): void => void rpc.close();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted) throw new Error("复制被取消");
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
        if (child.pid !== undefined) resolve();
      });
      await rpc.request("initialize", { clientInfo: { ...CODEX_CLIENT_INFO }, capabilities: { experimentalApi: true } });
      rpc.notify("initialized");
    } catch (error) {
      await rpc.close();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ForkUnsupportedError(`找不到 codex：${src.executablePath}`);
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    return rpc;
  }

  return {
    id: CODEX_NATIVE_FORKER_ID,
    kind: "native",

    async fork(src, signal): Promise<ForkHandle> {
      if (signal.aborted) throw new Error("复制被取消");
      const rpc = await startServer(src, signal);
      const onAbort = (): void => void rpc.close();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (signal.aborted) throw new Error("复制被取消");
        const launch = readCodexLaunchConfig(withoutHubEnv(src.launch));
        if (launch.skillRoots.length > 0) await rpc.request("skills/extraRoots/set", { extraRoots: launch.skillRoots }).catch(() => undefined);
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
      let prevTotalKey: string | null = null;
      let turnId: string | null = null;
      let unlisten = (): void => {};
      const done = new Promise<void>((resolve, reject) => {
        unlisten = rpc.listen((method, params) => {
          if (method === "turn/started") turnId = textOf((params.turn as Json | undefined)?.id) || turnId;
          else if (method === "thread/tokenUsage/updated") {
            const tu = params.tokenUsage as Json | undefined;
            const rawTotal = typeof tu?.total === "object" && tu.total !== null ? (tu.total as Json) : null;
            const totalKey = rawTotal
              ? `${numberOf(rawTotal.inputTokens)}:${numberOf(rawTotal.cachedInputTokens)}:${numberOf(rawTotal.cacheWriteInputTokens)}:${numberOf(rawTotal.outputTokens)}`
              : null;
            if (totalKey === null || totalKey !== prevTotalKey) {
              prevTotalKey = totalKey;
              const last = tu?.last;
              if (typeof last === "object" && last !== null) usage = addUsage(usage, last as Json);
            }
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
        if (signal.aborted) {
          onAbort();
          throw new Error("写交接被取消");
        }
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
      if (!rpc) return;
      if (rpc.exited || rpc.closing) {
        await rpc.close();
        return;
      }
      try {
        // In case this codex persisted the fork anyway, delete it; ephemeral threads report not persisted.
        await rpc.request("thread/delete", { threadId: fork.forkId });
      } catch (error) {
        if (!rpc.exited && !rpc.closing && (!(error instanceof Error) || !GONE_PATTERN.test(error.message))) {
          await rpc.close();
          throw error;
        }
      }
      await rpc.close();
    },
  };
}

export const CODEX_FORKERS: readonly SessionForker[] = [createCodexForker()];

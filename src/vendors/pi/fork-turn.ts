import type { ChildProcess } from "node:child_process";
import type { TokenUsage } from "../../shared/domain.ts";
import { KILL_WAIT_MS } from "../../shared/limits.ts";
import { forceKill, killFreshGroup } from "../../daemon/driver/process.ts";
import { ForkUnsupportedError } from "../../daemon/handover/forker.ts";
import type { ForkHandle, ForkSource, ForkWriteResult } from "../../daemon/handover/forker.ts";
import { MAX_PI_PROBE_STDOUT_CHARS, PI_SESSION_STATS_TIMEOUT_MS } from "./limits.ts";
import {
  addPiTokenCounts,
  buildBlockingExtensionUiCancelLine,
  buildGetSessionStatsLine,
  buildGetStateLine,
  buildPromptLine,
  extractPiAssistantBlocks,
  parsePiSessionStats,
  parsePiTokenCounts,
  type PiRawTokenCounts,
} from "./protocol.ts";

const STDERR_TAIL_CHARS = 2_000;
const NO_SESSION_RE = /no session found|session file not found|cannot find session/i;

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

class PiForkTurn {
  #buffer = "";
  #stderr = "";
  #settled = false;
  #statsTimer: NodeJS.Timeout | undefined;
  readonly #texts: string[] = [];
  #turnCounts: PiRawTokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  #lastAssistantContext = 0;
  #turnError: string | null = null;
  #waitingStats = false;
  readonly #onAbort = () => this.#finish(new Error("aborted"));

  readonly #child: ChildProcess;
  readonly #src: ForkSource;
  readonly #fork: ForkHandle;
  readonly #signal: AbortSignal;
  readonly #killWaitMs: number;
  readonly #resolve: (result: ForkWriteResult) => void;
  readonly #reject: (err: Error) => void;

  constructor(
    child: ChildProcess,
    src: ForkSource,
    fork: ForkHandle,
    signal: AbortSignal,
    killWaitMs: number,
    resolve: (result: ForkWriteResult) => void,
    reject: (err: Error) => void,
  ) {
    this.#child = child;
    this.#src = src;
    this.#fork = fork;
    this.#signal = signal;
    this.#killWaitMs = killWaitMs;
    this.#resolve = resolve;
    this.#reject = reject;
  }

  start(prompt: string): void {
    const child = this.#child;
    const src = this.#src;
    this.#signal.addEventListener("abort", this.#onAbort, { once: true });

    child.stdin?.on("error", () => {});
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.once("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.#finish(new ForkUnsupportedError(`找不到 pi：${src.executablePath}`));
        return;
      }
      this.#finish(new Error(`${src.executablePath}: ${err.message}`));
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#onStdout(chunk));
    child.once("close", (code, sig) => this.#onClose(code, sig));

    child.stdin?.write(`${buildGetStateLine("1")}\n`);
    child.stdin?.write(`${buildPromptLine("2", prompt)}\n`);
  }

  #exited(): boolean {
    return this.#child.exitCode !== null || this.#child.signalCode !== null;
  }

  #stopChild(): void {
    if (this.#exited()) return;
    if (this.#child.pid === undefined) {
      this.#child.kill("SIGKILL");
      return;
    }
    const killable = this.#child as Parameters<typeof forceKill>[0];
    killFreshGroup(killable);
    void forceKill(killable);
  }

  #finish(err: Error | null, result?: ForkWriteResult): void {
    if (this.#settled) return;
    this.#settled = true;
    clearTimeout(this.#statsTimer);
    this.#signal.removeEventListener("abort", this.#onAbort);
    this.#child.stdin?.end();
    if (err) {
      this.#stopChild();
      this.#reject(err);
      return;
    }
    // Wait for exit so the next session does not start while pi still writes the copy.
    if (this.#exited()) {
      this.#resolve(result!);
      return;
    }
    const killTimer = setTimeout(() => this.#stopChild(), this.#killWaitMs);
    this.#child.once("exit", () => {
      clearTimeout(killTimer);
      this.#resolve(result!);
    });
  }

  #finalizeWithStats(contextOverride: number | null): void {
    if (this.#turnError !== null) {
      this.#finish(new Error(`pi 写交接出错：${this.#turnError}`));
      return;
    }
    const counts = this.#turnCounts;
    const usage: TokenUsage = {
      input: counts.input,
      cacheRead: counts.cacheRead,
      cacheWrite: counts.cacheWrite,
      output: counts.output,
      context: contextOverride ?? this.#lastAssistantContext,
    };
    this.#finish(null, { text: this.#texts.join("\n\n"), usage });
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_PI_PROBE_STDOUT_CHARS && !this.#buffer.includes("\n")) {
      this.#finish(new Error("pi 写交接单行输出超过上限"));
      return;
    }
    let idx: number;
    while ((idx = this.#buffer.indexOf("\n")) >= 0) {
      const rawLine = this.#buffer.slice(0, idx).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(idx + 1);
      if (rawLine.trim() === "") continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(rawLine) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (this.#onLine(obj) === "stop") return;
    }
  }

  #onLine(obj: Record<string, unknown>): "continue" | "stop" {
    const cancelUi = buildBlockingExtensionUiCancelLine(obj);
    if (cancelUi !== null) {
      this.#child.stdin?.write(`${cancelUi}\n`);
      return "continue";
    }
    if (obj.type === "response") return this.#onResponse(obj);
    if (obj.type === "message_end") {
      this.#onMessageEnd(asObject(obj.message));
      return "continue";
    }
    if (obj.type === "agent_settled" && !this.#waitingStats) {
      this.#waitingStats = true;
      if (obj.aborted === true && this.#turnError === null) {
        this.#turnError = "aborted";
      }
      this.#child.stdin?.write(`${buildGetSessionStatsLine("3")}\n`);
      this.#statsTimer = setTimeout(() => this.#finalizeWithStats(null), PI_SESSION_STATS_TIMEOUT_MS);
    }
    return "continue";
  }

  #onResponse(obj: Record<string, unknown>): "continue" | "stop" {
    if (obj.id === "1" && obj.command === "get_state") {
      if (obj.success === false) {
        const msg = typeof obj.error === "string" ? obj.error : "get_state failed";
        this.#finish(
          NO_SESSION_RE.test(msg)
            ? new ForkUnsupportedError(`pi 找不到要复制的原会话：${msg}`)
            : new Error(`pi get_state 失败：${msg}`),
        );
        return "stop";
      }
      const data = asObject(obj.data);
      if (typeof data?.sessionFile === "string" && data.sessionFile !== "" && this.#fork.extra) {
        this.#fork.extra.sessionFile = data.sessionFile;
      }
      return "continue";
    }
    if (obj.id === "2" && obj.command === "prompt" && obj.success === false) {
      const msg = typeof obj.error === "string" ? obj.error : "prompt failed";
      this.#finish(new Error(`pi prompt 失败：${msg}`));
      return "stop";
    }
    if (obj.id === "3" && obj.command === "get_session_stats") {
      const stats = obj.success === false ? { contextTokens: null } : parsePiSessionStats(obj.data);
      this.#finalizeWithStats(stats.contextTokens);
      return "stop";
    }
    return "continue";
  }

  #onMessageEnd(message: Record<string, unknown> | null): void {
    if (message?.role !== "assistant") return;
    const blocks = extractPiAssistantBlocks(message);
    for (const t of blocks.texts) this.#texts.push(t.text);
    const counts = parsePiTokenCounts(message.usage);
    if (counts) {
      this.#turnCounts = addPiTokenCounts(this.#turnCounts, counts);
      this.#lastAssistantContext = counts.input + counts.cacheRead + counts.cacheWrite;
    }
    if (message.stopReason === "error") {
      this.#turnError =
        typeof message.errorMessage === "string" && message.errorMessage !== ""
          ? message.errorMessage
          : "assistant error";
    }
  }

  #onClose(code: number | null, sig: NodeJS.Signals | null): void {
    if (this.#settled) return;
    if (this.#waitingStats) {
      this.#finalizeWithStats(null);
      return;
    }
    const trimmedErr = this.#stderr.trim();
    if (NO_SESSION_RE.test(trimmedErr)) {
      this.#finish(new ForkUnsupportedError(`pi 找不到要复制的原会话：${trimmedErr}`));
      return;
    }
    this.#finish(new Error(`pi 复制会话提前退出（${sig ?? `code ${code}`}）${trimmedErr ? `：${trimmedErr}` : ""}`));
  }
}

export interface PiForkTurnOptions {
  killWaitMs?: number;
}

export function runPiForkTurn(
  child: ChildProcess,
  src: ForkSource,
  fork: ForkHandle,
  prompt: string,
  signal: AbortSignal,
  options?: PiForkTurnOptions,
): Promise<ForkWriteResult> {
  return new Promise<ForkWriteResult>((resolve, reject) => {
    new PiForkTurn(child, src, fork, signal, options?.killWaitMs ?? KILL_WAIT_MS, resolve, reject).start(prompt);
  });
}

import { turnFailureReason, type Driver } from "../../shared/driver.ts";
import type { SessionId, TokenUsage } from "../../shared/domain.ts";
import { describeFailure } from "../../shared/errors.ts";
import type { SessionTokens } from "../../shared/hub.ts";
import { ROUTER_SESSION_CLEANUP_GRACE_MS } from "../../shared/limits.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import { within } from "../driver/base-driver.ts";
import type { SqliteLedger } from "../ledger/index.ts";
import { cleanupRouterLaunchDir, ensureRouterHomeDir } from "./sandbox.ts";

export type RouterTurnPurpose = "dispatch" | "catalog";

export interface RouterTurnRequest {
  purpose: RouterTurnPurpose;
  vendor: AgentVendor;
  model: string;
  effort: string;
  text: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onSession?: (sessionId: SessionId) => () => void;
}

export type RouterTurnResult =
  | { ok: true; text: string; usage: TokenUsage | null; durationMs: number }
  | { ok: false; reason: "timeout" | "aborted" | "error"; error: string; errorRaw?: string; partialText: string; durationMs: number };

export type RouterTurnRunner = (request: RouterTurnRequest) => Promise<RouterTurnResult>;

export interface RouterTurnPurposes {
  set(sessionId: SessionId, purpose: RouterTurnPurpose): void;
  delete(sessionId: SessionId): void;
  of(sessionId: SessionId): RouterTurnPurpose;
}

export function createRouterTurnPurposes(): RouterTurnPurposes {
  const purposes = new Map<SessionId, RouterTurnPurpose>();
  return {
    set: (sessionId, purpose) => void purposes.set(sessionId, purpose),
    delete: (sessionId) => void purposes.delete(sessionId),
    of: (sessionId) => purposes.get(sessionId) ?? "dispatch",
  };
}

export interface RouterTurnRunnerOptions {
  ledger: Pick<SqliteLedger, "createRouterAssistantSession" | "endRouterAssistantSession">;
  purposes: Pick<RouterTurnPurposes, "set" | "delete">;
  driver: Driver;
  tokens: Pick<SessionTokens, "revoke">;
  stateDir: string;
  launchDir: string;
  cleanupGraceMs?: number;
  log?: (line: string) => void;
}

export function createRouterTurnRunner(options: RouterTurnRunnerOptions): RouterTurnRunner {
  const { ledger, driver, tokens, stateDir, launchDir, purposes } = options;
  const graceMs = options.cleanupGraceMs ?? ROUTER_SESSION_CLEANUP_GRACE_MS;

  return async (request) => {
    const startedAt = Date.now();
    const elapsed = () => Math.max(0, Date.now() - startedAt);
    let sessionId: SessionId;
    try {
      sessionId = ledger.createRouterAssistantSession({ vendor: request.vendor, model: request.model, effort: request.effort, cwd: ensureRouterHomeDir(stateDir) }).id;
    } catch (err) {
      const raw = messageOf(err);
      return { ok: false, reason: "error", error: describeFailure(raw, { vendor: request.vendor }).text, errorRaw: raw, partialText: "", durationMs: elapsed() };
    }
    purposes.set(sessionId, request.purpose);
    const release = request.onSession?.(sessionId);

    const texts: string[] = [];
    let turnEnded = false;
    let launching = true;
    let deferredExitReason: string | null = null;
    let settle!: (outcome: Outcome) => void;
    const done = new Promise<Outcome>((resolve) => {
      let settled = false;
      settle = (outcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
    });
    const failRaw = (raw: string) => settle({ kind: "error", error: describeFailure(raw, { vendor: request.vendor }).text, errorRaw: raw });

    const unsub = driver.onEvent((evSessionId, event) => {
      if (evSessionId !== sessionId) return;
      if (event.type === "agent.text" && !event.parentToolUseId) texts.push(event.text);
      else if (event.type === "turn.ended") {
        turnEnded = true;
        if (event.ok && !event.interrupted) settle({ kind: "ok" });
        else if (event.error) failRaw(turnFailureReason(event.error));
        else settle({ kind: "error", error: "这一轮被打断了" });
      } else if (event.type === "session.exited" && !event.hadResult) {
        // Defer startup_failed until start()/send() rejects so its DriverError detail is not masked.
        if (event.reason === "startup_failed" && launching) deferredExitReason = event.reason;
        else settle({ kind: "error", error: `进程提前退出（${event.reason}）` });
      } else if (event.type === "driver.error" && event.code === "invalid_input") failRaw(event.message);
    });
    const timer = setTimeout(() => settle({ kind: "timeout" }), request.timeoutMs);
    timer.unref?.();
    const onAbort = () => settle({ kind: "aborted" });
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    let outcome: Outcome;
    try {
      void (async () => {
        try {
          await driver.start(sessionId);
          const sent = await driver.send(sessionId, { messageIds: [1], source: "user", text: request.text });
          if (sent.kind === "rejected" || sent.kind === "cancelled") settle({ kind: "error", error: `没能写进会话（${sent.kind}）` });
        } finally {
          launching = false;
        }
        if (deferredExitReason !== null) settle({ kind: "error", error: `进程提前退出（${deferredExitReason}）` });
      })().catch((err: unknown) => failRaw(messageOf(err)));
      outcome = await done;
    } finally {
      clearTimeout(timer);
      unsub();
      request.signal?.removeEventListener("abort", onAbort);
      tokens.revoke(sessionId);
      release?.();
      const stopSession = (async () => {
        if (!turnEnded) await driver.interrupt(sessionId).catch(() => {});
        await driver.end(sessionId).catch(() => {});
      })();
      if ((await within(stopSession, graceMs)) === "timeout") options.log?.(`总助单轮会话 ${sessionId} 结束超时，放弃等待`);
      cleanupRouterLaunchDir(launchDir, sessionId);
      purposes.delete(sessionId);
      try {
        ledger.endRouterAssistantSession(sessionId);
      } catch {
        // The database may already be closed during shutdown.
      }
    }

    const text = texts
      .map((t) => t.trim())
      .filter((t) => t !== "")
      .join("\n\n");
    const durationMs = elapsed();
    switch (outcome.kind) {
      case "ok":
        return { ok: true, text, usage: null, durationMs };
      case "timeout":
        return { ok: false, reason: "timeout", error: `超过 ${Math.max(1, Math.round(request.timeoutMs / 1000))} 秒没结束`, partialText: text, durationMs };
      case "aborted":
        return { ok: false, reason: "aborted", error: "被打断了", partialText: text, durationMs };
      case "error":
        return { ok: false, reason: "error", error: outcome.error, ...(outcome.errorRaw === undefined ? {} : { errorRaw: outcome.errorRaw }), partialText: text, durationMs };
    }
  };
}

type Outcome = { kind: "ok" } | { kind: "timeout" } | { kind: "aborted" } | { kind: "error"; error: string; errorRaw?: string };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

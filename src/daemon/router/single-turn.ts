// 总助的单轮会话（docs/router-project-catalog-design.md 第 3.4、3.6 节）：在 router-home 隔离只读目录里起一个 assistant 会话，跑一轮、收文字、关掉。
// 总助分派（dispatcher.ts 的轨道 B）和后台写档（project-catalog/runner.ts）共用这一份，各家厂商都走驱动层，不写单家分支。
// 不变量：
// - 会话的角色永远是 assistant，账本不把它的事件记进任何对话（ledger.ts 的 applyDriverEvent 跳过 assistant）。
// - purpose 决定系统提示词和凭证：dispatch 用总助提示词、发 hub 令牌；catalog 用写档提示词、不发令牌（环境里没有 HUB_TOKEN / HUB_SOCK）。
// - 不管成败、超时还是被打断，返回前都已撤令牌、结束会话、删掉临时启动目录。
import { turnFailureReason, type Driver } from "../../shared/driver.ts";
import type { SessionId, TokenUsage } from "../../shared/domain.ts";
import { describeFailure } from "../../shared/errors.ts";
import type { SessionTokens } from "../../shared/hub.ts";
import { ROUTER_SESSION_CLEANUP_GRACE_MS } from "../../shared/limits.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import { within } from "../driver/base-driver.ts";
import type { SqliteLedger } from "../ledger/index.ts";
import { cleanupRouterLaunchDir, ensureRouterHomeDir } from "./sandbox.ts";

/** dispatch：总助分派一条用户指令；catalog：后台给一个项目写档。 */
export type RouterTurnPurpose = "dispatch" | "catalog";

export interface RouterTurnRequest {
  purpose: RouterTurnPurpose;
  vendor: AgentVendor;
  model: string;
  effort: string;
  /** 这一轮发给会话的全文。 */
  text: string;
  timeoutMs: number;
  /** 外面要提前结束（关机）。 */
  signal?: AbortSignal;
  /** 会话建好、还没起进程时调（分派用它绑定 sandboxGuard）；返回的函数在收尾时调。 */
  onSession?: (sessionId: SessionId) => () => void;
}

export type RouterTurnResult =
  | { ok: true; text: string; usage: TokenUsage | null; durationMs: number }
  | { ok: false; reason: "timeout" | "aborted" | "error"; error: string; errorRaw?: string; partialText: string; durationMs: number };

export type RouterTurnRunner = (request: RouterTurnRequest) => Promise<RouterTurnResult>;

/**
 * 在跑的单轮会话各是什么用途：单轮跑腿的建会话后登记、收尾时删；启动文件（sandbox.ts 的 prepareRouterSandboxLaunch）按它选提示词和凭证。
 * 没登记的 assistant 会话按 dispatch 算。
 */
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
  /** 守护进程里和启动文件共用的那一份。 */
  purposes: Pick<RouterTurnPurposes, "set" | "delete">;
  driver: Driver;
  tokens: Pick<SessionTokens, "revoke">;
  stateDir: string;
  launchDir: string;
  /** 回收会话最多等多久，默认 ROUTER_SESSION_CLEANUP_GRACE_MS。 */
  cleanupGraceMs?: number;
  log?: (line: string) => void;
}

/**
 * 后置：返回的函数每次调用都新建一个 assistant 会话跑一轮。
 * 正常结束时 text 是这一轮顶层 agent 的全部文字（不含子代理）；到 timeoutMs 或 signal 触发时打断这一轮，返回 ok: false。
 * 起进程失败、写不进会话、进程提前退出都返回 ok: false（reason "error"），不抛错。
 */
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
      } else if (event.type === "session.exited" && !event.hadResult) settle({ kind: "error", error: `进程提前退出（${event.reason}）` });
      else if (event.type === "driver.error" && event.code === "invalid_input") failRaw(event.message);
    });
    const timer = setTimeout(() => settle({ kind: "timeout" }), request.timeoutMs);
    timer.unref?.();
    const onAbort = () => settle({ kind: "aborted" });
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    let outcome: Outcome;
    try {
      // start/send 跟计时器赛跑：厂商进程起不来或写不进去卡住时，超时照样结束这一轮
      void (async () => {
        await driver.start(sessionId);
        const sent = await driver.send(sessionId, { messageIds: [1], source: "user", text: request.text });
        if (sent.kind === "rejected" || sent.kind === "cancelled") settle({ kind: "error", error: `没能写进会话（${sent.kind}）` });
      })().catch((err: unknown) => failRaw(messageOf(err)));
      outcome = await done;
    } finally {
      clearTimeout(timer);
      unsub();
      request.signal?.removeEventListener("abort", onAbort);
      // 先撤令牌和绑定：之后到的 hub 调用一律拒绝
      tokens.revoke(sessionId);
      release?.();
      // 没正常结束先打断再结束；driver.end 遇到还在跑的一轮会等它回完，限时等，厂商进程卡住也按时返回
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
        // 关机时库可能已经关了
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

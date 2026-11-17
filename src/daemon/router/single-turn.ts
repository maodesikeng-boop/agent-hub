// 总助的单轮会话（docs/router-project-catalog-design.md 第 3.4、3.6 节）：在 router-home 隔离只读目录里起一个 assistant 会话，跑一轮、收文字、关掉。
// 总助分派（dispatcher.ts 的轨道 B）和后台写档（project-catalog/runner.ts）共用这一份，各家厂商都走驱动层，不写单家分支。
// 不变量：
// - 会话的角色永远是 assistant，账本不把它的事件记进任何对话（ledger.ts 的 applyDriverEvent 跳过 assistant）。
// - purpose 决定系统提示词和凭证：dispatch 用总助提示词、发 hub 令牌；catalog 用写档提示词、不发令牌（环境里没有 HUB_TOKEN / HUB_SOCK）。
// - 不管成败、超时还是被打断，返回前都已撤令牌、结束会话、删掉临时启动目录。
import type { Driver } from "../../shared/driver.ts";
import type { SessionId, TokenUsage } from "../../shared/domain.ts";
import type { SessionTokens } from "../../shared/hub.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import type { SqliteLedger } from "../ledger/index.ts";

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

export interface RouterTurnRunnerOptions {
  ledger: Pick<SqliteLedger, "createRouterAssistantSession" | "endRouterAssistantSession">;
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
  throw new Error("未实现");
}

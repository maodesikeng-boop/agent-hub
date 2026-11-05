// 一个会话的 token 累计：每次请求（assistant 消息）都更新，一轮结束用 result.usage 校正。
import type { TokenUsage } from "../../shared/index.ts";
import { assistantContext, parseUsage } from "./protocol.ts";

type RequestUsage = Omit<TokenUsage, "context">;

/**
 * 一轮里的实时用量。累计 = 这一轮开始时的累计 + 这一轮每条 assistant 消息的 usage（同一个 message.id 会分几个事件推出来，
 * 只取最后一次；子 agent 的消息不算，和 result.usage 的口径一致）。轮结束时直接用“开始时的累计 + result.usage”，
 * 实时累计整个丢掉，所以不会重复计。
 *
 * 实测（logs/sessions）：每条消息最后一次 usage 的 input + 缓存读 + 缓存写加起来和 result.usage 完全一致；
 * assistant 里的 output_tokens 是流式开头的快照（只有几个到几百），所以实时的输出数偏小，result 到了才补到准。
 */
export class TurnUsage {
  #base: TokenUsage | null = null;
  #context: number | null = null;
  readonly #requests = new Map<string, RequestUsage>();

  /** 收到一个 assistant 事件：返回更新后的累计；没有可更新的（子 agent 的、没带 usage 的）返回 null。 */
  observe(obj: Record<string, unknown>, current: TokenUsage): TokenUsage | null {
    const context = assistantContext(obj);
    if (context === null) return null;
    this.#base ??= current;
    this.#context = context;
    const id = (obj.message as { id?: unknown } | undefined)?.id;
    if (typeof id === "string") this.#requests.set(id, parseUsage((obj.message as { usage?: unknown }).usage));
    const live = { ...this.#base, context };
    for (const r of this.#requests.values()) {
      live.input += r.input;
      live.cacheRead += r.cacheRead;
      live.cacheWrite += r.cacheWrite;
      live.output += r.output;
    }
    return live;
  }

  /** 一轮结束：开始时的累计 + result.usage，并清掉这一轮的实时数据。 */
  finish(current: TokenUsage, resultUsage: unknown): TokenUsage {
    const base = this.#base ?? current;
    const turn = parseUsage(resultUsage);
    const context = this.#context;
    this.reset();
    return {
      input: base.input + turn.input,
      cacheRead: base.cacheRead + turn.cacheRead,
      cacheWrite: base.cacheWrite + turn.cacheWrite,
      output: base.output + turn.output,
      context: context ?? current.context,
    };
  }

  /** 进程退出、这一轮没有 result：已经推出去的实时数保留，下一轮从它算起。 */
  reset(): void {
    this.#base = null;
    this.#context = null;
    this.#requests.clear();
  }
}

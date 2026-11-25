import type { TokenUsage } from "../../shared/index.ts";
import { parseUsage } from "./protocol.ts";

export function positiveContextTokens(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
}

export function preservePositiveContext(measured: number | null | undefined, previousContext: number): number {
  return positiveContextTokens(measured) ?? previousContext;
}

type RequestUsage = Omit<TokenUsage, "context">;

function assistantUsage(obj: Record<string, unknown>): { id: string | null; usage: RequestUsage } | null {
  if (obj.parent_tool_use_id != null) return null;
  const message = obj.message;
  if (typeof message !== "object" || message === null || !("usage" in message)) return null;
  return { id: "id" in message && typeof message.id === "string" ? message.id : null, usage: parseUsage(message.usage) };
}

function contextTokensOf(usage: RequestUsage): number | null {
  return positiveContextTokens(usage.input + usage.cacheRead + usage.cacheWrite);
}

export function assistantContext(obj: Record<string, unknown>): number | null {
  const request = assistantUsage(obj);
  return request === null ? null : contextTokensOf(request.usage);
}

export class TurnUsage {
  #base: TokenUsage | null = null;
  #context: number | null = null;
  readonly #requests = new Map<string, RequestUsage>();

  observe(obj: Record<string, unknown>, current: TokenUsage): TokenUsage | null {
    const request = assistantUsage(obj);
    if (request === null) return null;
    const context = contextTokensOf(request.usage);
    if (context === null && request.usage.output === 0) return null;
    this.#base ??= current;
    this.#context = context ?? this.#context;
    if (request.id !== null) this.#requests.set(request.id, request.usage);
    const live = { ...this.#base, context: preservePositiveContext(this.#context, current.context) };
    for (const r of this.#requests.values()) {
      live.input += r.input;
      live.cacheRead += r.cacheRead;
      live.cacheWrite += r.cacheWrite;
      live.output += r.output;
    }
    return live;
  }

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
      context: preservePositiveContext(context, current.context),
    };
  }

  reset(): void {
    this.#base = null;
    this.#context = null;
    this.#requests.clear();
  }
}

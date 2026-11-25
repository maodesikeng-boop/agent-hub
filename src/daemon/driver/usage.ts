import type { TokenUsage } from "../../shared/index.ts";
import { assistantContext, parseUsage } from "./protocol.ts";

// Invariant: once a session has recorded a positive context token count, an error or zero-usage turn never overwrites it with 0.

/**
 * Precondition: value is an unvalidated vendor context token field.
 * Postcondition: returns the floored positive integer when value is a finite number > 0; returns null for 0, negative, or non-numeric values.
 */
export function positiveContextTokens(_value: unknown): number | null {
  throw new Error("Not implemented");
}

/**
 * Precondition: previousContext is a non-negative integer token count from the session before this update.
 * Postcondition: returns positiveContextTokens(measured) when positive, otherwise preserves previousContext unchanged.
 */
export function preservePositiveContext(_measured: number | null | undefined, _previousContext: number): number {
  throw new Error("Not implemented");
}

type RequestUsage = Omit<TokenUsage, "context">;

export class TurnUsage {
  #base: TokenUsage | null = null;
  #context: number | null = null;
  readonly #requests = new Map<string, RequestUsage>();

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

  reset(): void {
    this.#base = null;
    this.#context = null;
    this.#requests.clear();
  }
}

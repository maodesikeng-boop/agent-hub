import type { TokenUsage } from "../../shared/index.ts";
import { buildChildEnv, userContent } from "../../daemon/driver/protocol.ts";

export { buildChildEnv };

// Kept for single-turn copy-fork summarization in handover.ts.
export const AGY_STREAM_ARGS: readonly string[] = ["--input-format", "stream-json", "--output-format", "stream-json"];
export const AGY_PLAN_PERMISSION_ARGS: readonly string[] = ["--mode", "plan"];
// --print "" must come last with an empty value; Go's flag parser would swallow the next flag as the prompt.
export const AGY_PRINT_ARGS: readonly string[] = ["--print", ""];

function escapeLineSeparators(json: string): string {
  return json.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export function buildAgyUserLine(
  text: string,
  prefixes: readonly string[] = [],
  buildContent: (prefixes: readonly string[], text: string) => unknown[] = userContent,
): string {
  return escapeLineSeparators(JSON.stringify({ event: "user", message: { content: buildContent(prefixes, text) } }));
}

export function checkAgyUserLine(line: string): string | null {
  if (line.includes("\n") || line.includes("\r")) return "这一行带换行";
  if (line.includes("\u2028") || line.includes("\u2029")) return "这一行带没转义的 U+2028 / U+2029";
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return "不是 JSON";
  }
  if (typeof obj !== "object" || obj === null) return "不是 JSON 对象";
  const o = obj as { event?: unknown; message?: { role?: unknown; content?: unknown } };
  if (o.event !== "user") return `event 是 ${JSON.stringify(o.event)}，不是 "user"`;
  if (typeof o.message !== "object" || o.message === null) return "没有 message";
  if (o.message.role !== undefined && o.message.role !== "user") {
    return `message.role 是 ${JSON.stringify(o.message.role)}，不是 "user"`;
  }
  const content = o.message.content;
  if (!Array.isArray(content) || content.length === 0) return "content 不是非空数组";
  for (const part of content as Array<{ type?: unknown; text?: unknown }>) {
    if (part?.type !== "text" || typeof part.text !== "string") return "content 里只能有 text";
  }
  if ((content as Array<{ text: string }>).every((p) => p.text.trim() === "")) return "文字是空的";
  return null;
}

export function detectAgyArgsConflict(stderr: string): "no_conversation" | null {
  if (/not found|no conversation/i.test(stderr)) return "no_conversation";
  return null;
}

const tokenCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

// agy output_tokens already include thinking_tokens.
export function parseAgyUsage(usage: unknown): Omit<TokenUsage, "context"> {
  const u = typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : {};
  return {
    input: tokenCount(u.input_tokens),
    cacheRead: tokenCount(u.cache_read_tokens) || tokenCount(u.cache_read_input_tokens),
    cacheWrite: tokenCount(u.cache_write_tokens) || tokenCount(u.cache_creation_input_tokens),
    output: tokenCount(u.output_tokens),
  };
}

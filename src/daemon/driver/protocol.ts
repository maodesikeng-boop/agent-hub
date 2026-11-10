// 几家厂商驱动共用的协议小函数（docs/vendor-plugin-design.md 的 A12：原来和 claude 的 stream-json 协议放在一个文件，P3 拆开）。
// claude 自己的协议在 src/vendors/claude/protocol.ts。
import { createHash } from "node:crypto";
import type { TokenUsage } from "../../shared/index.ts";

/**
 * 一条用户消息的 content（claude、codex 的 composer 的 buildUserContent 就是它，驱动层经厂商接口调）：我们加的字每项一个 text 块在前，用户原文单独放最后一块。
 * claude 只看最后一个 text 块是不是以 / 开头，前面的块模型照样看得到（docs/composer-commands.md 的 T4）。
 * 空白的块不放（API 不收空的 text 块）；全是空白时留一块，写入前的校验会按“文字是空的”拒绝。
 */
export function userContent(prefixes: readonly string[], text: string): Array<{ type: "text"; text: string }> {
  const blocks = prefixes.filter((p) => p.trim() !== "");
  if (text.trim() !== "" || blocks.length === 0) blocks.push(text);
  return blocks.map((t) => ({ type: "text", text: t }));
}

/**
 * 忙时用户连发的几条拼成一条（设计第 7.3 节）：“【用户连发了 N 条】”和每条（带编号）各一个 text 块，最后一条放 text。
 * 以命令开头的不拼（驱动层的 #takeBatch 挑），所以这里不用管命令。只有一条时原样。
 */
export function mergeUserTexts(texts: string[]): { prefixes: string[]; text: string } {
  if (texts.length === 1) return { prefixes: [], text: texts[0]! };
  const items = texts.map((t, i) => `${i + 1}. ${t}`);
  return { prefixes: [`【用户连发了 ${texts.length} 条】`, ...items.slice(0, -1)], text: items.at(-1)! };
}

/** 去重用的 uuid：原始事件有就照抄，没有就 `line:<原始那一行的 sha256 前 32 位>`（driver.ts 的约定）。 */
export function lineUuid(obj: { uuid?: unknown }, rawLine: string): string {
  if (typeof obj.uuid === "string" && obj.uuid !== "") return obj.uuid;
  return `line:${createHash("sha256").update(rawLine).digest("hex").slice(0, 32)}`;
}

const tokenCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** claude 的 usage 对象（result.usage、assistant 的 message.usage）里的四个数，缺了或不是数字当 0。 */
export function parseUsage(usage: unknown): Omit<TokenUsage, "context"> {
  const u = typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : {};
  return {
    input: tokenCount(u.input_tokens),
    cacheRead: tokenCount(u.cache_read_input_tokens),
    cacheWrite: tokenCount(u.cache_creation_input_tokens),
    output: tokenCount(u.output_tokens),
  };
}

/**
 * 一个 assistant 事件的上下文大小：这次请求的 input + 缓存读 + 缓存写。子 agent 的消息（parent_tool_use_id 不是 null）
 * 和没带 usage 的返回 null，不更新。
 */
export function assistantContext(obj: Record<string, unknown>): number | null {
  if (obj.parent_tool_use_id !== undefined && obj.parent_tool_use_id !== null) return null;
  const usage = (obj.message as { usage?: unknown } | undefined)?.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const { input, cacheRead, cacheWrite } = parseUsage(usage);
  return input + cacheRead + cacheWrite;
}

/**
 * 守护进程自己可能是在某个 Claude 会话里起的（开发时）。这些变量会让子 claude 以为自己是子会话，
 * 照 experiments/m0/claude_clean.sh 去掉。
 */
// P4（A12）改成各家 spec 的 cli.parentSessionEnv 的并集
const PARENT_SESSION_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "T3CODE_THREAD_ID",
  "T3CODE_CLI_PATH",
];

export function buildChildEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !PARENT_SESSION_ENV.includes(k)) env[k] = v;
  return { ...env, ...extra };
}

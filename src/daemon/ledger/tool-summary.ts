// tool 消息的一行摘要（Message.text）：工具名 + 最要紧的参数，不超过 200 字符、不含换行。
const MAX_SUMMARY_CHARS = 200;
/** 按顺序找第一个是非空字符串的参数。 */
const KEY_ARGS = ["command", "file_path", "notebook_path", "pattern", "url", "query", "path", "description", "prompt"];

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function summarizeToolCall(name: string, input: unknown): string {
  let summary = oneLine(name);
  if (input !== null && typeof input === "object") {
    const args = input as Record<string, unknown>;
    for (const key of KEY_ARGS) {
      const value = args[key];
      if (typeof value === "string" && oneLine(value) !== "") {
        summary = `${summary}: ${oneLine(value)}`;
        break;
      }
    }
  }
  const chars = [...summary];
  return chars.length > MAX_SUMMARY_CHARS ? `${chars.slice(0, MAX_SUMMARY_CHARS - 1).join("")}…` : summary;
}

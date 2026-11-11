import type { AgentStep, AgentStepInput } from "../../shared/domain.ts";
import { STEP_INPUT_KEYS } from "../../shared/step-labels.ts";

// tool 消息的一行摘要（Message.text）：工具名 + 最要紧的参数，不超过 200 字符、不含换行。
const MAX_SUMMARY_CHARS = 200;
/** 按顺序找第一个是非空字符串的参数。 */
const KEY_ARGS = [
  "command",
  "CommandLine",
  "file_path",
  "notebook_path",
  "AbsolutePath",
  "TargetFile",
  "Path",
  "pattern",
  "url",
  "query",
  "path",
  "SearchPath",
  "description",
  "prompt",
];

export function oneLine(text: string): string {
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

/** 推给网页的参数每个最多这么长（文件名、skill 名用不了更多）。 */
const MAX_STEP_ARG_CHARS = 300;

/** 当前这一步是这个工具调用：名字照抄，input 只留 STEP_INPUT_KEYS 里的非空字符串。 */
export function stepOfTool(name: string, input: unknown): AgentStep {
  const kept: AgentStepInput = {};
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const args = input as Record<string, unknown>;
    for (const key of STEP_INPUT_KEYS) {
      const value = args[key];
      if (typeof value === "string" && value.trim() !== "") kept[key] = [...value].slice(0, MAX_STEP_ARG_CHARS).join("");
    }
  }
  return { type: "tool_use", name, input: kept };
}

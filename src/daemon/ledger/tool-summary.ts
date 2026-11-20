import type { AgentStep } from "../../shared/domain.ts";
import { pickStepInput } from "../../shared/step-labels.ts";

const MAX_SUMMARY_CHARS = 200;
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

export function stepOfTool(name: string, input: unknown): AgentStep {
  return { type: "tool_use", name, input: pickStepInput(input) };
}

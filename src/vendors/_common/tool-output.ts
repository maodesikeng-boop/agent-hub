import { SKILL_LOAD_SCAN_MAX_CHARS } from "../../shared/limits.ts";
import { isAgentVendor, vendorSpec } from "../../shared/vendors.ts";

export function toolOutputText(value: unknown): string {
  const parts: string[] = [];
  let size = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0 && size < SKILL_LOAD_SCAN_MAX_CHARS) {
    const item = stack.pop();
    if (typeof item === "string") {
      parts.push(item);
      size += item.length + 1;
    } else if (Array.isArray(item)) {
      for (let i = item.length - 1; i >= 0; i--) stack.push(item[i]);
    } else if (item !== null && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const next = typeof o.text === "string" ? o.text : (o.content ?? o.stdout);
      if (next !== undefined) stack.push(next);
    }
  }
  return parts.join("\n").slice(0, SKILL_LOAD_SCAN_MAX_CHARS);
}

export function toolResultOutputs(vendor: string, results: readonly (readonly [string, unknown])[]): { outputs?: Record<string, string> } {
  if (!isAgentVendor(vendor)) return {};
  const field = vendorSpec(vendor).skillSignals.outputField;
  const outputs: Record<string, string> = {};
  for (const [toolUseId, result] of results) {
    const text = result !== null && typeof result === "object" ? toolOutputText((result as Record<string, unknown>)[field]) : "";
    if (text !== "") outputs[toolUseId] = text;
  }
  return Object.keys(outputs).length === 0 ? {} : { outputs };
}

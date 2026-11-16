// 工具的返回原文（AgentToolResultEvent.outputs）：各家驱动把工具结果交给这里，按 spec 的 skillSignals.outputField 取出那个字段、摊平成文字。
// 只给账本认技能加载用（shared/skill-loads.ts），到 SKILL_LOAD_SCAN_MAX_CHARS 就停：后面的不认，事件也不背着几兆的输出走。
import { SKILL_LOAD_SCAN_MAX_CHARS } from "../../shared/limits.ts";
import { isAgentVendor, vendorSpec } from "../../shared/vendors.ts";

/**
 * 摊平成文字：字符串原样；数组逐项用换行接起来；对象取 text，没有就取 content，再没有取 stdout。
 * claude 的文字块数组、pi 的 {content:[…]}、ACP 的 [{type:"content", content:{text}}]、cursor 的 {content}、{stdout} 都走这一个。
 * 用显式的栈不递归：套娃再深也不爆栈。
 */
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

/**
 * 一批工具结果的返回原文，直接展开进 agent.tool_result：results 是 [toolUseId, 这家的工具结果对象]，按 outputField 取字段。
 * 没有文字的不带；一个都没有就不带 outputs。
 */
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

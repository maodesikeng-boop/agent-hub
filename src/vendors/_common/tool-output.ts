// 工具的返回原文（AgentToolResultEvent.outputs）：各家驱动按 spec 的 skillSignals.outputField 取出那个字段，交给这里摊平成文字。
// 只给账本认技能加载用（shared/skill-loads.ts），到 SKILL_LOAD_SCAN_MAX_CHARS 就停：后面的不认，事件也不背着几兆的输出走。

/**
 * 摊平成文字：字符串原样；数组逐项用换行接起来；对象取 text，没有就取 content，再没有取 stdout。
 * claude 的文字块数组、pi 的 {content:[…]}、ACP 的 [{type:"content", content:{text}}]、cursor 的 {content}、{stdout} 都走这一个。
 */
export function toolOutputText(value: unknown): string {
  throw new Error(`未实现 ${typeof value}`);
}

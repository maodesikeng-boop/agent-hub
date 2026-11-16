// 认出“加载了一个技能”（docs/skill-carryover-design.md 的识别规则）：六家共用这一份，各家差异只在 spec 的 tools.actions 和 skillSignals。
// 账本收到 agent.tool、message.processing 时按它记（daemon/ledger/loaded-skills.ts），换代时把记下的技能正文带进新会话。
// 纯函数，不碰磁盘：名字找 SKILL.md、相对路径解析由守护进程做（daemon/skill-files.ts）。
import type { AgentVendor } from "./vendors.ts";

/**
 * 认到的一次加载：
 * - name：只给了名字（原生技能工具、用户手打的命令），要按名字去技能目录找 SKILL.md；
 * - file：读了 `…/skills/<名字>/SKILL.md`。path 可能是相对的，按会话工作目录、cwd 里依次的目录（工具参数的 cwd、脚本里的 cd）解析。
 */
export type SkillLoad = { by: "name"; name: string } | { by: "file"; name: string; path: string; cwd: readonly string[] };

/** 一次工具调用里加载的技能（读文件工具、shell 命令、原生技能工具），没有是空数组。 */
export function toolSkillLoads(_vendor: AgentVendor, _toolName: string, _input: unknown): SkillLoad[] {
  return [];
}

/** 用户手打的这句是不是调用技能，是的话给规整后的技能名（还要去技能目录找得到才算）。 */
export function userSkillCommandOf(_vendor: AgentVendor, _text: string): string | null {
  return null;
}

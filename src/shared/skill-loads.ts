// 认出“加载了一个技能”（docs/skill-carryover-design.md 的识别规则）：六家共用这一份，各家差异只在 spec 的 tools.actions 和 skillSignals。
// 账本收到 agent.tool、agent.tool_result、message.processing 时按它记（daemon/ledger/loaded-skills.ts），换代时把记下的技能正文带进新会话。
// 不解析 shell、不从模型写的文本里拼路径：只认“返回原文里出现了已知技能的开头”，返回里没有正文的读文件工具按它的路径参数和名单比真实路径。
// 纯函数，不碰磁盘：名单由守护进程枚举技能目录建（daemon/skill-files.ts）。
/** 名单里的一个技能。 */
export interface KnownSkill {
  /** 技能名（目录名）。 */
  readonly name: string;
  /** 枚举技能目录时得到的路径。 */
  readonly path: string;
  /** 真实路径（realpath）：软链和原文件算同一个技能。 */
  readonly key: string;
  /** “开头”：frontmatter 头两个非空行、正文头两个非空行，各一行接一行。 */
  readonly heads: readonly string[];
}

/** 一个会话的已知技能名单。 */
export interface SkillCatalog {
  readonly skills: readonly KnownSkill[];
  /** 按名字找（用户手打、原生技能工具）：枚举顺序里第一个。 */
  named(name: string): KnownSkill | null;
  /** 按真实路径找。 */
  byKey(key: string): KnownSkill | null;
  /** 工具参数里的路径：规整成真实路径后和名单里的比，相等才算。 */
  atPath(path: string): KnownSkill | null;
}

/** 一次工具调用：厂商原工具名和完整参数。 */
export interface ToolCall {
  name: string;
  input: unknown;
}

/** SKILL.md 全文（或开头）算出的“开头”。 */
export function skillHeads(text: string): string[] {
  throw new Error(`未实现 ${text.length}`);
}

/** 建名单：realPathOf 把工具参数里的路径规整成真实路径（守护进程给，碰磁盘），拿不到是 null。 */
export function createSkillCatalog(skills: readonly KnownSkill[], realPathOf: (path: string) => string | null): SkillCatalog {
  throw new Error(`未实现 ${skills.length} ${typeof realPathOf}`);
}

/** 这次调用要等返回到了再认（读文件、跑命令）。 */
export function awaitsToolResult(vendor: string, toolName: string): boolean {
  throw new Error(`未实现 ${vendor} ${toolName}`);
}

/** 调用那一刻就能认的：原生技能工具（claude 的 Skill、deepseek 的 skill）给的技能名，还要在名单里找得到才算。 */
export function skillNameOfToolCall(vendor: string, call: ToolCall): string | null {
  throw new Error(`未实现 ${vendor} ${call.name}`);
}

/** 返回到了之后认的：返回原文里出现已知技能的开头；返回里没有正文的读文件工具按路径参数认。没有是空数组。 */
export function skillsOfToolResult(vendor: string, call: ToolCall, output: string | undefined, catalog: SkillCatalog): KnownSkill[] {
  throw new Error(`未实现 ${vendor} ${call.name} ${output?.length} ${catalog.skills.length}`);
}

/** 用户手打的这句是不是调用技能，是的话给规整后的技能名（还要在名单里找得到才算）。 */
export function userSkillCommandOf(vendor: string, text: string): string | null {
  throw new Error(`未实现 ${vendor} ${text}`);
}

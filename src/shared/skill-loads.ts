// 认出“加载了一个技能”（docs/skill-carryover-design.md 的识别规则）：六家共用这一份，各家差异只在 spec 的 tools.actions 和 skillSignals。
// 账本收到 agent.tool、agent.tool_result、message.processing 时按它记（daemon/ledger/loaded-skills.ts），换代时把记下的技能正文带进新会话。
// 不解析 shell、不从模型写的文本里拼路径：只认“返回原文里出现了已知技能的开头”，返回里没有正文的读文件工具按它的路径参数和名单比是不是同一个文件。
// 纯函数，不碰磁盘：名单由守护进程枚举技能目录建（daemon/skill-files.ts）。
import { commandNameOf } from "../vendors/types.ts";
import type { AgentStepInput } from "./domain.ts";
import { SKILL_LOAD_SCAN_MAX_CHARS } from "./limits.ts";
import { skillNameOf } from "./skill-names.ts";
import { filePathOf, STEP_INPUT_KEYS } from "./step-labels.ts";
import { isAgentVendor, vendorSpec } from "./vendors.ts";
/** 名单里的一个技能。 */
export interface KnownSkill {
  /** 技能名（目录名）。 */
  readonly name: string;
  /** 枚举技能目录时得到的路径。 */
  readonly path: string;
  /** 真实路径（realpath）：软链和原文件算同一个技能。 */
  readonly key: string;
  /** 文件身份（设备号:inode）：工具参数里的路径按它比，软链、硬链都认（agy 的任务图手册是硬链进 agy-rules 目录的）。 */
  readonly fileId: string;
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
  /** 工具参数里的路径：和名单里的是同一个文件才算。 */
  atPath(path: string): KnownSkill | null;
  /** 开头是这两行（一行接一行）的技能：名单顺序里第一个。 */
  byHead(head: string): KnownSkill | null;
}

/** 一次工具调用：厂商原工具名和完整参数。 */
export interface ToolCall {
  name: string;
  input: unknown;
}

/** 非空行：去掉这家的行号前缀、行尾空白（\r\n、\n 都算换行）。 */
const contentLines = (text: string, prefix?: RegExp): string[] =>
  text
    .split(/\r?\n/u)
    .map((line) => (prefix === undefined ? line : line.replace(prefix, "")).trimEnd())
    .filter((line) => line.trim() !== "");

/** SKILL.md 全文（或开头）算出的“开头”：frontmatter 头两个非空行，正文（frontmatter 之后）头两个非空行。 */
export function skillHeads(text: string): string[] {
  const lines = contentLines(text.replace(/^\uFEFF/u, ""));
  const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  const body = close === -1 ? lines : lines.slice(close + 1);
  const heads: string[] = [];
  if (close !== -1) heads.push(lines.slice(0, 2).join("\n"));
  if (body.length >= 2) heads.push(body.slice(0, 2).join("\n"));
  return heads;
}

/** 建名单：fileIdOf 给工具参数里的路径是哪个文件（守护进程给，碰磁盘），拿不到是 null。重名、重开头的按名单顺序第一个算。 */
export function createSkillCatalog(skills: readonly KnownSkill[], fileIdOf: (path: string) => string | null): SkillCatalog {
  const byName = new Map<string, KnownSkill>();
  const byKey = new Map<string, KnownSkill>();
  const byFile = new Map<string, KnownSkill>();
  const byHead = new Map<string, KnownSkill>();
  for (const skill of skills) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
    if (!byKey.has(skill.key)) byKey.set(skill.key, skill);
    if (!byFile.has(skill.fileId)) byFile.set(skill.fileId, skill);
    for (const head of skill.heads) if (!byHead.has(head)) byHead.set(head, skill);
  }
  return {
    skills,
    named: (name) => byName.get(name) ?? null,
    byKey: (key) => byKey.get(key) ?? null,
    byHead: (head) => byHead.get(head) ?? null,
    atPath: (path) => {
      if (path === "") return null;
      const id = fileIdOf(path);
      return id === null ? null : (byFile.get(id) ?? null);
    },
  };
}

const actionOf = (vendor: string, toolName: string) => {
  if (!isAgentVendor(vendor)) return undefined;
  const actions = vendorSpec(vendor).tools?.actions ?? {};
  return Object.hasOwn(actions, toolName) ? actions[toolName] : undefined;
};

const stringArg = (input: unknown, key: string): string | undefined => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

/** 参数里放路径的那几个键（不截断，pickStepInput 是给状态行用的、会截）。 */
const stepArgs = (input: unknown): AgentStepInput =>
  Object.fromEntries(
    STEP_INPUT_KEYS.flatMap((key) => {
      const value = stringArg(input, key);
      return value === undefined ? [] : [[key, value]];
    }),
  );

/** 从头读的：fromStart 里的参数要么没给，要么是不大于上限的数。 */
function readsFromStart(input: unknown, fromStart: Readonly<Record<string, number>> | undefined): boolean {
  if (fromStart === undefined) return true;
  const args = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return Object.entries(fromStart).every(([key, max]) => {
    const value = args[key];
    if (value === undefined || value === null) return true;
    const n = Number(value);
    return Number.isFinite(n) && n <= max;
  });
}

/** 这次调用要等返回到了再认（读文件、跑命令）。 */
export function awaitsToolResult(vendor: string, toolName: string): boolean {
  const action = actionOf(vendor, toolName);
  return action === "read" || action === "command";
}

/** 调用那一刻就能认的：原生技能工具（claude 的 Skill、deepseek 的 skill）给的技能名，还要在名单里找得到才算。 */
export function skillNameOfToolCall(vendor: string, call: ToolCall): string | null {
  if (actionOf(vendor, call.name) !== "skill" || !isAgentVendor(vendor)) return null;
  const raw = (vendorSpec(vendor).skillSignals.toolNameKeys ?? []).map((key) => stringArg(call.input, key)).find((v) => v !== undefined);
  return skillNameOf(raw);
}

/**
 * 返回到了之后认的。返回里没有正文、声明在 readByPath 里的读文件工具：读成功、从头读，路径参数指的是名单里的文件；
 * 别的读文件、跑命令：返回原文前 SKILL_LOAD_SCAN_MAX_CHARS 字里相邻两行是某个技能的开头。按出现的先后，同一个文件只算一次。
 */
export function skillsOfToolResult(vendor: string, call: ToolCall, output: string | undefined, catalog: SkillCatalog): KnownSkill[] {
  if (output === undefined || !awaitsToolResult(vendor, call.name) || !isAgentVendor(vendor)) return [];
  const signals = vendorSpec(vendor).skillSignals;
  const byPath = signals.readByPath !== undefined && Object.hasOwn(signals.readByPath, call.name) ? signals.readByPath[call.name] : undefined;
  if (byPath !== undefined) {
    if (!byPath.ok.test(output.trim()) || !readsFromStart(call.input, byPath.fromStart)) return [];
    const path = filePathOf(stepArgs(call.input));
    const skill = path === undefined ? null : catalog.atPath(path);
    return skill === null ? [] : [skill];
  }
  const lines = contentLines(output.slice(0, SKILL_LOAD_SCAN_MAX_CHARS), signals.outputLinePrefix);
  const found = new Map<string, KnownSkill>();
  for (let i = 0; i + 1 < lines.length; i++) {
    const skill = catalog.byHead(`${lines[i]}\n${lines[i + 1]}`);
    if (skill !== null && !found.has(skill.key)) found.set(skill.key, skill);
  }
  return [...found.values()];
}

/** 用户手打的这句是不是调用技能，是的话给规整后的技能名（还要在名单里找得到才算）。 */
export function userSkillCommandOf(vendor: string, text: string): string | null {
  if (!isAgentVendor(vendor)) return null;
  const spec = vendorSpec(vendor);
  for (const prefix of spec.skillSignals.userTriggers ?? [spec.composer.commandPrefix]) {
    const name = skillNameOf(commandNameOf(text, prefix) ?? undefined);
    if (name !== null) return name;
  }
  return null;
}

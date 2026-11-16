// 认出“加载了一个技能”（docs/skill-carryover-design.md 的识别规则）：六家共用这一份，各家差异只在 spec 的 tools.actions 和 skillSignals。
// 账本收到 agent.tool、message.processing 时按它记（daemon/ledger/loaded-skills.ts），换代时把记下的技能正文带进新会话。
// 纯函数，不碰磁盘：名字找 SKILL.md、相对路径解析由守护进程做（daemon/skill-files.ts）。
import { parse, type ParseEntry } from "shell-quote";
import { commandNameOf } from "../vendors/types.ts";
import { skillNameOf, skillNameOfFile } from "./skill-names.ts";
import type { AgentStepInput } from "./domain.ts";
import { filePathOf, STEP_INPUT_KEYS } from "./step-labels.ts";
import { isAgentVendor, vendorSpec } from "./vendors.ts";

/**
 * 认到的一次加载：
 * - name：只给了名字（原生技能工具、用户手打的命令），要按名字去技能目录找 SKILL.md；
 * - file：读了 `…/skills/<名字>/SKILL.md`。path 可能是相对的，按会话工作目录、cwd 里依次的目录（工具参数的 cwd、脚本里的 cd）解析。
 */
export type SkillLoad = { by: "name"; name: string } | { by: "file"; name: string; path: string; cwd: readonly string[] };

/** 把正文读进上下文的命令。ls、wc、grep、find、stat、cp 不读正文，不算。 */
const READ_COMMANDS: ReadonlySet<string> = new Set(["cat", "head", "tail", "sed", "nl", "less", "more", "bat", "get-content", "gc", "type"]);
/** 包一层 shell 跑脚本的：`sh|bash|zsh -c/-lc '<脚本>'`、PowerShell `-Command`。 */
const POSIX_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash"]);
const POWERSHELLS: ReadonlySet<string> = new Set(["powershell", "pwsh"]);
/** 一段命令到这里为止。 */
const SEPARATORS: ReadonlySet<string> = new Set([";", ";;", "&&", "||", "|", "|&", "&", "(", ")"]);
/** 包装套娃最多拆几层。 */
const MAX_SHELL_DEPTH = 3;
/** shell-quote 遇到 `$变量` 时换成它：带着它的参数认不出路径。 */
const UNEXPANDED = "\u0000var\u0000";

const commandBase = (token: string) =>
  (token.split(/[\\/]/u).at(-1) ?? token).toLowerCase().replace(/\.exe$/u, "");

/**
 * shell-quote 不把换行当分隔：没被反斜杠续行的换行先改成 `;` 再分词。引号里的换行（`zsh -lc '多行脚本'`）也会改，
 * 那是要再拆一层的脚本，换行和 `;` 在里面意思一样。
 */
const tokens = (script: string): ParseEntry[] => parse(script.replace(/\\\r?\n/gu, " ").replace(/\r?\n/gu, ";\n"), () => UNEXPANDED);

/** 一段命令（分隔符之间）读了哪些技能文件；cwd 是这一段之前 cd 过的目录。 */
function segmentLoads(words: ParseEntry[], cwd: string[], depth: number, out: SkillLoad[]): void {
  const args: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (typeof word === "string") {
      args.push(word);
      continue;
    }
    if (!("op" in word)) continue;
    if (word.op === ">" || word.op === ">>" || word.op === ">&") {
      // 2>/dev/null 只丢错误输出，正文照样进上下文；标准输出重定向走了就没进
      if (args.at(-1) !== "2") return;
      args.pop();
      i++;
    }
  }
  while (args.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(args[0]!)) args.shift();
  if (args.length === 0) return;
  const command = commandBase(args[0]!);
  if (command === "cd") {
    const target = args[1];
    if (target !== undefined && !target.includes(UNEXPANDED)) cwd.push(target);
    return;
  }
  if (depth < MAX_SHELL_DEPTH && POSIX_SHELLS.has(command)) {
    const flag = args.findIndex((a, i) => i > 0 && /^-[a-z]*c[a-z]*$/u.test(a));
    const script = flag === -1 ? undefined : args[flag + 1];
    if (script !== undefined) scriptLoads(script, [...cwd], depth + 1, out);
    return;
  }
  if (depth < MAX_SHELL_DEPTH && POWERSHELLS.has(command)) {
    const flag = args.findIndex((a, i) => i > 0 && /^-(c|command)$/iu.test(a));
    if (flag !== -1) scriptLoads(args.slice(flag + 1).join(" "), [...cwd], depth + 1, out);
    return;
  }
  if (!READ_COMMANDS.has(command)) return;
  if (command === "sed" && args.some((a) => /^-[a-z]*i/u.test(a) || a.startsWith("--in-place"))) return;
  for (const arg of args.slice(1)) {
    if (arg.includes(UNEXPANDED)) continue;
    const name = skillNameOfFile(arg);
    if (name !== null) out.push({ by: "file", name, path: arg, cwd: [...cwd] });
  }
}

function scriptLoads(script: string, cwd: string[], depth: number, out: SkillLoad[]): void {
  let segment: ParseEntry[] = [];
  for (const word of [...tokens(script), { op: ";" } as ParseEntry]) {
    if (typeof word === "object" && "op" in word && SEPARATORS.has(word.op)) {
      segmentLoads(segment, cwd, depth, out);
      segment = [];
    } else segment.push(word);
  }
}

const stringArg = (input: unknown, key: string): string | undefined => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

/** 参数里放路径、名字的那几个键（不截断，pickStepInput 是给状态行用的、会截）。 */
const stepArgs = (input: unknown): AgentStepInput =>
  Object.fromEntries(STEP_INPUT_KEYS.flatMap((key) => {
    const value = stringArg(input, key);
    return value === undefined ? [] : [[key, value]];
  }));

/** 一次工具调用里加载的技能（读文件工具、shell 命令、原生技能工具），没有是空数组。 */
export function toolSkillLoads(vendor: string, toolName: string, input: unknown): SkillLoad[] {
  if (!isAgentVendor(vendor)) return [];
  const spec = vendorSpec(vendor);
  const actions = spec.tools?.actions ?? {};
  const action = Object.hasOwn(actions, toolName) ? actions[toolName] : undefined;
  switch (action) {
    case "skill": {
      const raw = (spec.skillSignals?.toolNameKeys ?? []).map((key) => stringArg(input, key)).find((v) => v !== undefined);
      const name = skillNameOf(raw);
      return name === null ? [] : [{ by: "name", name }];
    }
    case "read": {
      const path = filePathOf(stepArgs(input));
      const name = path === undefined ? null : skillNameOfFile(path);
      return path === undefined || name === null ? [] : [{ by: "file", name, path, cwd: [] }];
    }
    case "command": {
      const script = stringArg(input, "command") ?? stringArg(input, "CommandLine");
      if (script === undefined) return [];
      const out: SkillLoad[] = [];
      const cwd = stringArg(input, "cwd");
      scriptLoads(script, cwd === undefined ? [] : [cwd], 0, out);
      return out;
    }
    default:
      return [];
  }
}

/** 用户手打的这句是不是调用技能，是的话给规整后的技能名（还要去技能目录找得到才算）。 */
export function userSkillCommandOf(vendor: string, text: string): string | null {
  if (!isAgentVendor(vendor)) return null;
  const spec = vendorSpec(vendor);
  for (const prefix of spec.skillSignals?.userTriggers ?? [spec.composer.commandPrefix]) {
    const name = skillNameOf(commandNameOf(text, prefix) ?? undefined);
    if (name !== null) return name;
  }
  return null;
}

// 认出“加载了一个技能”（docs/skill-carryover-design.md 的识别规则）：六家共用这一份，各家差异只在 spec 的 tools.actions 和 skillSignals。
// 账本收到 agent.tool、message.processing 时按它记（daemon/ledger/loaded-skills.ts），换代时把记下的技能正文带进新会话。
// 纯函数，不碰磁盘：名字找 SKILL.md、相对路径解析由守护进程做（daemon/skill-files.ts）。
import { commandNameOf } from "../vendors/types.ts";
import { skillNameOf, skillNameOfFile } from "./skill-names.ts";
import type { AgentStepInput } from "./domain.ts";
import { withShellTree, type ShellNode } from "./shell-syntax.ts";
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
/** 包装套娃最多拆几层。 */
const MAX_SHELL_DEPTH = 3;
/** 把标准输出写进文件或关掉的重定向：正文没进上下文。`>&2` 这种换到另一个输出的照样进。 */
const STDOUT_AWAY: ReadonlySet<string> = new Set([">", ">>", ">|", "&>", "&>>", ">&-"]);
/**
 * 不往里认的节点：命令替换、进程替换的输出给了别的命令；heredoc 正文是给别的程序的输入；函数定义体这时没跑；
 * ERROR 是解析不了的部分，认不准就不认。
 */
const OPAQUE: ReadonlySet<string> = new Set(["command_substitution", "process_substitution", "heredoc_redirect", "herestring_redirect", "function_definition", "ERROR"]);

const commandBase = (token: string) =>
  (token.split(/[\\/]/u).at(-1) ?? token).toLowerCase().replace(/\.exe$/u, "");

interface Walk {
  /** 这一处之前 cd 过的目录。 */
  cwd: string[];
  depth: number;
  /** 哪种 shell 的脚本：PowerShell 里反斜杠是路径分隔，不是转义。 */
  dialect: "posix" | "powershell";
  out: SkillLoad[];
}

/** 写死的一个词（没有变量、命令替换、通配符）的值；不是写死的给 null。 */
function literal(node: ShellNode | null, walk: Walk): string | null {
  if (node === null) return null;
  switch (node.type) {
    case "command_name":
      return node.namedChildCount === 1 ? literal(node.namedChild(0), walk) : null;
    case "word":
      if (/[*?[]/u.test(node.text)) return null;
      return walk.dialect === "powershell" ? node.text : node.text.replace(/\\(.)/gsu, "$1");
    case "number":
      return node.text;
    case "raw_string":
      return node.text.slice(1, -1);
    case "string":
      return node.namedChildren.every((c) => c.type === "string_content") ? node.text.slice(1, -1).replace(/\\([$`"\\\n])/gu, "$1") : null;
    case "concatenation": {
      const parts = node.namedChildren.map((c) => literal(c, walk));
      return parts.every((p) => p !== null) ? parts.join("") : null;
    }
    default:
      return null;
  }
}

/** 这个重定向把标准输出送走了（没进上下文）。`2>`、`2>&1` 只动错误输出，不算。 */
function sendsStdoutAway(redirect: ShellNode, walk: Walk): boolean {
  if (redirect.type !== "file_redirect") return false;
  const descriptor = redirect.childForFieldName("descriptor")?.text;
  if (descriptor !== undefined && descriptor !== "1") return false;
  const op = redirect.children.find((c) => !c.isNamed)?.type;
  if (op === ">&") return !/^\d+$/u.test(literal(redirect.childForFieldName("destination"), walk) ?? "");
  return op !== undefined && STDOUT_AWAY.has(op);
}

const isSedInPlace = (args: readonly (string | null)[]) => args.some((a) => a !== null && (/^-[a-z]*i/u.test(a) || a.startsWith("--in-place")));

/** 一条简单命令：cd 记目录，sh -c、PowerShell -Command 拆开再认，读文件的命令认参数里的技能路径。away：输出没进上下文。 */
function visitCommand(node: ShellNode, walk: Walk, away: boolean): void {
  const name = literal(node.childForFieldName("name"), walk);
  if (name === null) return;
  const args = node.childrenForFieldName("argument").map((a) => literal(a, walk));
  const command = commandBase(name);
  if (command === "cd") {
    const target = args[0];
    if (typeof target === "string" && !target.startsWith("-")) walk.cwd.push(target);
    return;
  }
  if (walk.depth < MAX_SHELL_DEPTH && POSIX_SHELLS.has(command)) {
    const flag = args.findIndex((a) => a !== null && /^-[a-z]*c[a-z]*$/u.test(a));
    const script = flag === -1 ? undefined : args[flag + 1];
    if (typeof script === "string") visitScript(script, { ...walk, cwd: [...walk.cwd], depth: walk.depth + 1, dialect: "posix" }, away);
    return;
  }
  if (walk.depth < MAX_SHELL_DEPTH && POWERSHELLS.has(command)) {
    const flag = args.findIndex((a) => a !== null && /^-(c|command)$/iu.test(a));
    const rest = flag === -1 ? [] : args.slice(flag + 1);
    if (rest.length > 0 && rest.every((a) => a !== null)) visitScript(rest.join(" "), { ...walk, cwd: [...walk.cwd], depth: walk.depth + 1, dialect: "powershell" }, away);
    return;
  }
  if (away || !READ_COMMANDS.has(command)) return;
  if (command === "sed" && isSedInPlace(args)) return;
  for (const arg of args) {
    const skill = arg === null ? null : skillNameOfFile(arg);
    if (arg !== null && skill !== null) walk.out.push({ by: "file", name: skill, path: arg, cwd: [...walk.cwd] });
  }
}

const redirectsAway = (node: ShellNode, walk: Walk) => node.childrenForFieldName("redirect").some((r) => sendsStdoutAway(r, walk));

/** 按脚本里的先后顺序走一遍语法树。用显式的栈不递归：嵌套再深也不会爆栈。 */
function visitScript(script: string, walk: Walk, away: boolean): void {
  withShellTree(script, (root) => {
    const stack: [ShellNode, boolean][] = [[root, away]];
    for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
      const [node, nodeAway] = item;
      if (OPAQUE.has(node.type)) continue;
      if (node.type === "command") {
        visitCommand(node, walk, nodeAway || redirectsAway(node, walk));
        continue;
      }
      if (node.type === "redirected_statement") {
        const body = node.childForFieldName("body");
        if (body !== null) stack.push([body, nodeAway || redirectsAway(node, walk)]);
        continue;
      }
      const children = node.namedChildren;
      for (let i = children.length - 1; i >= 0; i--) stack.push([children[i]!, nodeAway]);
    }
  });
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
      const cwd = stringArg(input, "cwd");
      const walk: Walk = { cwd: cwd === undefined ? [] : [cwd], depth: 0, dialect: "posix", out: [] };
      visitScript(script, walk, false);
      return walk.out;
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

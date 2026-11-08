// Claude Code 的输入框实现（接口见 types.ts，实测见 docs/composer-commands.md）：
// - 命令列表：initialize 控制请求回应里的 commands（{name, description, argumentHint, aliases?, builtin?}）；builtin 留着：
//   隐藏名单只藏 builtin 的，用户自己的命令、skill 叫 debug、new 这类名字也要留着、手打也要发得出去；
// - 会话没在跑时另起的 claude 在项目目录里起（项目的命令、skill 才查得到），但不跑钩子、不连 MCP（driver/protocol.ts 的 INITIALIZE_QUERY_ARGS）；
// - 这个文件不引入起进程的代码（账本只要这里的纯数据）：起进程的函数由 index.ts 登记时传进来（ClaudeComposerOptions.queryInitialize）；
// - 隐藏名单、拦下的原因：shared/vendors.ts 的 VENDOR_SPECS.claude.composer；
// - `@path` 会被 claude 自动读进文件内容（T5），带空格的只认 `@"a b.md"`（T6）；
// - 只有最后一个 text 块以 / 开头才当命令展开（T4）：我们加的字各放一块在前面，原文单独放最后一块。
import {
  COMMANDS_QUERY_TIMEOUT_MS,
  MAX_COMMANDS,
  MAX_COMMAND_DESCRIPTION_CHARS,
  MAX_COMMAND_HINT_CHARS,
  VENDOR_SPECS,
  truncateChars,
  type AgentVendor,
  type ComposerCommand,
} from "../../shared/index.ts";
import type { ClaudeModelQueryOptions } from "../driver/model-catalog.ts";
import { userContent } from "../driver/protocol.ts";
import type { CommandsTarget, VendorComposer, VendorComposerBase } from "./types.ts";

/** 缓存的命令列表里这个名字是不是用户自己的（有这个名字、而且不是 builtin；名字不分大小写）。没缓存、列表里没有这个名字都是 false。 */
function isUserOwned(name: string, known: readonly ComposerCommand[] | null): boolean {
  const key = name.toLowerCase();
  const same = (known ?? []).filter((c) => c.name.toLowerCase() === key);
  return same.length > 0 && same.every((c) => c.builtin !== true);
}

/** 按 VENDOR_SPECS[vendor].composer 生成不需要起进程的基础实现。 */
export function createSpecComposerBase(vendor: AgentVendor): VendorComposerBase {
  const spec = VENDOR_SPECS[vendor].composer;
  const commandNameOf = (text: string): string | null => {
    if (!text.startsWith(spec.commandPrefix)) return null;
    const name = text.slice(spec.commandPrefix.length).split(/\s/u, 1)[0] ?? "";
    return name === "" || name.includes("/") ? null : name;
  };
  const blockedReasonOf = (name: string): string | null => {
    const key = name.toLowerCase();
    return Object.hasOwn(spec.blockedCommands, key) ? spec.blockedCommands[key]! : null;
  };
  return {
    vendor,
    parseCommands: parseClaudeCommands,
    isHiddenCommand: (command) => command.builtin === true && blockedReasonOf(command.name) !== null,
    isCommand: (text) => commandNameOf(text) !== null,
    isCompactCommand: (text) => commandNameOf(text) === spec.compactCommand,
    blockReason(text, known) {
      const name = commandNameOf(text);
      const reason = name === null ? null : blockedReasonOf(name);
      if (name === null || reason === null || isUserOwned(name, known)) return null;
      return `/${name}：${reason}`;
    },
    mention: (path) => (/[\s"]/u.test(path) ? `@"${path}"` : `@${path}`),
    buildUserContent: userContent,
  };
}

/** initialize 回应、commands_changed 里的 commands → 通用形状。name 不是非空字符串的、重复的跳过；说明、参数提示截断；builtin: true 的留着。 */
export function parseClaudeCommands(raw: unknown): ComposerCommand[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ComposerCommand[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim().replace(/^\//u, "") : "";
    if (name === "" || /\s/u.test(name) || seen.has(name)) continue;
    seen.add(name);
    const description = typeof entry.description === "string" ? truncateChars(entry.description.trim(), MAX_COMMAND_DESCRIPTION_CHARS) : "";
    const hint = typeof entry.argumentHint === "string" ? entry.argumentHint.trim() : "";
    out.push({
      name,
      description,
      ...(hint === "" ? {} : { argumentHint: truncateChars(hint, MAX_COMMAND_HINT_CHARS) }),
      ...(entry.builtin === true ? { builtin: true as const } : {}),
    });
    if (out.length === MAX_COMMANDS) break;
  }
  return out;
}

/** 不用起进程的那部分（驱动层拼消息、账本拦命令，经 vendors/index.ts 的 composerBaseOf 拿）。 */
export const claudeComposerBase: VendorComposerBase = createSpecComposerBase("claude");

export interface ClaudeComposerOptions {
  claudePath: string;
  /** 起一个 claude 发 initialize 控制请求、返回回应（driver/model-catalog.ts 的 queryClaudeInitialize；这里不直接引它，见文件开头）。 */
  queryInitialize: (options: ClaudeModelQueryOptions) => Promise<Record<string, unknown>>;
  /** 起 claude 的环境变量，默认守护进程自己的。 */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function createClaudeComposer(options: ClaudeComposerOptions): VendorComposer {
  return {
    ...claudeComposerBase,
    async queryCommands(target: CommandsTarget, signal: AbortSignal) {
      const response = await options.queryInitialize({
        claudePath: options.claudePath,
        cwd: target.cwd,
        addDirs: target.addDirs,
        timeoutMs: options.timeoutMs ?? COMMANDS_QUERY_TIMEOUT_MS,
        signal,
        ...(options.env ? { env: options.env } : {}),
      });
      const commands = parseClaudeCommands(response.commands);
      if (commands === null) throw new Error("initialize 回应里没有 commands");
      return commands;
    },
  };
}


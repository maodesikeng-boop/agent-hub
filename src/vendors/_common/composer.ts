// 输入框的通用实现（docs/vendor-plugin-design.md 3.1 节的 _common/composer.ts）：只看 spec.composer 的命令开头、隐藏名单、压缩命令。
// 各家的 composer 在它上面改；daemon.ts 没写 composer 的厂商直接用 createSpecComposer（命令列表只有压缩命令）。
// `@path` 带空格写 `@"a b"`；我们加的字各放一个 text 块在前面，用户原文单独放最后一块（daemon/driver/protocol.ts 的 userContent）。
import {
  isInternalSkillCommand,
  MAX_COMMANDS,
  MAX_COMMAND_DESCRIPTION_CHARS,
  MAX_COMMAND_HINT_CHARS,
  truncateChars,
  vendorSpec,
  type AgentVendor,
  type ComposerCommand,
} from "../../shared/index.ts";
import { userContent } from "../../daemon/driver/protocol.ts";
import type { VendorComposer, VendorComposerBase } from "../../daemon/vendors/types.ts";

/** 缓存的命令列表里这个名字是不是用户自己的（有这个名字、而且不是 builtin；名字不分大小写）。没缓存、列表里没有这个名字都是 false。 */
function isUserOwned(name: string, known: readonly ComposerCommand[] | null): boolean {
  const key = name.toLowerCase();
  const same = (known ?? []).filter((c) => c.name.toLowerCase() === key);
  return same.length > 0 && same.every((c) => c.builtin !== true);
}

/** 按 vendorSpec(vendor).composer 生成不需要起进程的基础实现（各家在它上面改 parseCommands、mention、buildUserContent）。 */
export function createSpecComposerBase(vendor: AgentVendor): VendorComposerBase {
  const spec = vendorSpec(vendor).composer;
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
    parseCommands: parseComposerCommands,
    isHiddenCommand: (command) =>
      isInternalSkillCommand(command.name) || (command.builtin === true && blockedReasonOf(command.name) !== null),
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

/** 通用形状的命令列表（claude 的 initialize 回应、commands_changed 里的 commands 就是这个形状）→ ComposerCommand[]。name 不是非空字符串的、重复的跳过；说明、参数提示截断；builtin: true 的留着。 */
export function parseComposerCommands(raw: unknown): ComposerCommand[] | null {
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

/** daemon.ts 没写 composer 的厂商：不起进程，命令列表只有压缩命令（手打的命令照样发给 agent，隐藏名单里的照样拦）。 */
export function createSpecComposer(vendor: AgentVendor): VendorComposer {
  const base = createSpecComposerBase(vendor);
  const compact: ComposerCommand = { name: vendorSpec(vendor).composer.compactCommand, description: "压缩当前对话上下文", builtin: true };
  return { ...base, queryCommands: async () => [compact] };
}

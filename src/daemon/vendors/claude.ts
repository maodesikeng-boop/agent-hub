// Claude Code 的输入框实现（接口见 types.ts，实测见 docs/composer-commands.md）：
// - 命令列表：initialize 控制请求回应里的 commands（{name, description, argumentHint, aliases?, builtin?}）；
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
  type ComposerCommand,
} from "../../shared/index.ts";
import { queryClaudeInitialize } from "../driver/model-catalog.ts";
import { userContent } from "../driver/protocol.ts";
import type { CommandsTarget, VendorComposer } from "./types.ts";

const SPEC = VENDOR_SPECS.claude.composer;

/** 原文是命令就返回命令名（不带 /，原样大小写），否则 null。只认最开头的 /，前面有空格不算（T4 的 F）。 */
function commandNameOf(text: string): string | null {
  if (!text.startsWith(SPEC.commandPrefix)) return null;
  const name = text.slice(SPEC.commandPrefix.length).split(/\s/u, 1)[0] ?? "";
  return name === "" ? null : name;
}

function blockedReasonOf(name: string): string | null {
  const key = name.toLowerCase();
  return Object.hasOwn(SPEC.blockedCommands, key) ? SPEC.blockedCommands[key]! : null;
}

/** initialize 回应、commands_changed 里的 commands → 通用形状。name 不是非空字符串的、重复的跳过；说明、参数提示截断。 */
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
    out.push(hint === "" ? { name, description } : { name, description, argumentHint: truncateChars(hint, MAX_COMMAND_HINT_CHARS) });
    if (out.length === MAX_COMMANDS) break;
  }
  return out;
}

/** 不用起进程的那部分（驱动层拼消息、账本拦命令直接用）。 */
export const claudeComposerBase: Omit<VendorComposer, "queryCommands"> = {
  vendor: "claude",
  parseCommands: parseClaudeCommands,
  isHiddenCommand: (name) => blockedReasonOf(name) !== null,
  isCommand: (text) => commandNameOf(text) !== null,
  blockReason(text) {
    const name = commandNameOf(text);
    const reason = name === null ? null : blockedReasonOf(name);
    return reason === null ? null : `/${name}：${reason}`;
  },
  mention: (path) => (/[\s"]/u.test(path) ? `@"${path}"` : `@${path}`),
  // 写进 stream-json 的格式在驱动层的协议文件里（driver/protocol.ts），这里就是它
  buildUserContent: userContent,
};

export interface ClaudeComposerOptions {
  claudePath: string;
  /** 起 claude 的环境变量，默认守护进程自己的。 */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function createClaudeComposer(options: ClaudeComposerOptions): VendorComposer {
  return {
    ...claudeComposerBase,
    async queryCommands(target: CommandsTarget, signal: AbortSignal) {
      const response = await queryClaudeInitialize({
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

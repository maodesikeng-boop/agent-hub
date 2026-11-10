// Antigravity (agy) 的输入框实现：
// - 命令列表：`agy -p "/skills" --output-format json` 返回的 skills（{ command: { name: "skills", data: { skills: [...] } } }），
//   再加上内置可用斜杠命令（如 /compact）；
// - `@path` 原生支持，带空格或引号的路径用 `@"a b.md"`；
// - 隐藏名单与拦截原因在 spec.ts 的 composer；模型名单和登录状态在 catalog.ts。
import {
  COMMANDS_QUERY_TIMEOUT_MS,
  MAX_COMMANDS,
  MAX_COMMAND_DESCRIPTION_CHARS,
  MAX_COMMAND_HINT_CHARS,
  truncateChars,
  type ComposerCommand,
} from "../../shared/index.ts";
import type { CommandsTarget, VendorComposer, VendorComposerBase } from "../../daemon/vendors/types.ts";
import { createSpecComposerBase } from "../_common/composer.ts";
import { queryAgySkills, type AgyModelQueryOptions } from "./catalog.ts";

/** agy 常用内置可用斜杠命令（非隐藏命令）。 */
const AGY_BUILTIN_COMMANDS: readonly ComposerCommand[] = [
  { name: "compact", description: "压缩当前对话上下文", builtin: true },
];

function extractAgySkills(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as {
    skills?: unknown;
    commands?: unknown;
    data?: { skills?: unknown; commands?: unknown };
    command?: { data?: { skills?: unknown; commands?: unknown } };
  };
  if (Array.isArray(r.command?.data?.skills)) return r.command.data.skills;
  if (Array.isArray(r.command?.data?.commands)) return r.command.data.commands;
  if (Array.isArray(r.data?.skills)) return r.data.skills;
  if (Array.isArray(r.data?.commands)) return r.data.commands;
  if (Array.isArray(r.skills)) return r.skills;
  if (Array.isArray(r.commands)) return r.commands;
  return null;
}

/**
 * `agy -p "/skills" --output-format json` 的输出 → 通用 ComposerCommand[]。
 * 兼容外层 `{ command: { data: { skills: [...] } } }` 或直接传数组；合并内置可用斜杠命令并去重。
 */
export function parseAgyCommands(raw: unknown): ComposerCommand[] | null {
  const list = extractAgySkills(raw);
  if (list === null) return null;
  const out: ComposerCommand[] = [];
  const seen = new Set<string>();
  const append = (item: unknown) => {
    if (out.length >= MAX_COMMANDS) return;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return;
    const entry = item as Record<string, unknown>;
    if (entry.enabled === false) return;
    const name = typeof entry.name === "string" ? entry.name.trim().replace(/^\//u, "") : "";
    if (name === "" || /\s/u.test(name) || seen.has(name)) return;
    seen.add(name);
    const description =
      typeof entry.description === "string" ? truncateChars(entry.description.trim(), MAX_COMMAND_DESCRIPTION_CHARS) : "";
    const hint = typeof entry.argumentHint === "string" ? entry.argumentHint.trim() : "";
    out.push({
      name,
      description,
      ...(hint === "" ? {} : { argumentHint: truncateChars(hint, MAX_COMMAND_HINT_CHARS) }),
      ...(entry.builtin === true ? { builtin: true as const } : {}),
    });
  };
  for (const item of list) append(item);
  for (const builtin of AGY_BUILTIN_COMMANDS) append(builtin);
  return out;
}

const specBase = createSpecComposerBase("agy");

/** 不用起进程的基础部分。 */
export const agyComposerBase: VendorComposerBase = {
  ...specBase,
  parseCommands: parseAgyCommands,
  mention: (path) => (/[\s"]/u.test(path) ? `@"${path}"` : `@${path}`),
};

export interface AgyComposerOptions {
  executablePath?: string;
  querySkills?: (options: AgyModelQueryOptions) => Promise<unknown>;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function createAgyComposer(options?: AgyComposerOptions): VendorComposer {
  return {
    ...agyComposerBase,
    async queryCommands(target: CommandsTarget, signal: AbortSignal) {
      if (!options?.querySkills && !options?.executablePath) {
        return [...AGY_BUILTIN_COMMANDS];
      }
      const query = options.querySkills ?? queryAgySkills;
      const raw = await query({
        agyPath: options.executablePath ?? "agy",
        cwd: target.cwd,
        timeoutMs: options.timeoutMs ?? COMMANDS_QUERY_TIMEOUT_MS,
        signal,
        ...(options.env ? { env: options.env } : {}),
      });
      const commands = parseAgyCommands(raw);
      if (commands === null) throw new Error("agy skills 回应里没有可识别的列表");
      return commands;
    },
  };
}

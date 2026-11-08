// OpenAI Codex 的输入框实现：
// - 命令列表：`codex app-server` 的 `skills/list` RPC 返回的 skills（过滤 enabled === false），加上内置 /compact；
// - Codex 的 skill 触发语法是 `$<skill>`：用户在输入框输 `/<skill>`（除 `/compact` 外）时，buildUserContent 把开头的 `/<skill>` 改写为 `$<skill>`；
// - 隐藏名单与拦截原因在 shared/vendors.ts 的 VENDOR_SPECS.codex.composer；
// - 模型名单和登录状态：同一个 app-server 里问 model/list 和 account/read（文件末尾）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  COMMANDS_QUERY_TIMEOUT_MS,
  MAX_COMMANDS,
  MAX_COMMAND_DESCRIPTION_CHARS,
  MAX_COMMAND_HINT_CHARS,
  VENDOR_SPECS,
  truncateChars,
  type ComposerCommand,
  type VendorAvailability,
} from "../../shared/index.ts";
import {
  parseCodexModels,
  queryCodexCatalog,
  queryCodexSkills,
  type CodexModelQueryOptions,
  type VendorCatalogSource,
} from "../driver/model-catalog.ts";
import { userContent } from "../driver/protocol.ts";
import { createSpecComposerBase } from "./claude.ts";
import type { CommandsTarget, VendorCatalogProbe, VendorCatalogSourceOptions, VendorComposer, VendorComposerBase } from "./types.ts";

export { queryCodexSkills, type CodexModelQueryOptions as CodexSkillsQueryOptions };

/** codex 常用内置可用斜杠命令（非隐藏命令）。 */
export const CODEX_BUILTIN_COMMANDS: readonly ComposerCommand[] = [
  { name: "compact", description: "压缩当前对话上下文", builtin: true },
];

function extractCodexSkills(raw: unknown): unknown[] | null {
  const unwrap = (val: unknown): unknown[] | null => {
    if (Array.isArray(val)) {
      const flattened: unknown[] = [];
      for (const item of val) {
        if (
          typeof item === "object" &&
          item !== null &&
          !Array.isArray(item) &&
          Array.isArray((item as { skills?: unknown }).skills)
        ) {
          flattened.push(...(item as { skills: unknown[] }).skills);
        } else {
          flattened.push(item);
        }
      }
      return flattened;
    }
    if (typeof val !== "object" || val === null) return null;
    const obj = val as {
      data?: unknown;
      skills?: unknown;
      commands?: unknown;
      result?: unknown;
    };
    if (obj.data !== undefined) return unwrap(obj.data);
    if (Array.isArray(obj.skills)) return obj.skills;
    if (Array.isArray(obj.commands)) return obj.commands;
    if (obj.result !== undefined) return unwrap(obj.result);
    return null;
  };
  return unwrap(raw);
}

/**
 * `codex app-server` 的 `skills/list` 回应 → 通用 ComposerCommand[]。
 * 兼容 `{ data: [{ cwd, skills: [...] }] }` 或直接传 skills 数组；过滤 `enabled === false`，加上内置 `/compact`。
 */
export function parseCodexCommands(raw: unknown): ComposerCommand[] | null {
  const list = extractCodexSkills(raw);
  if (list === null) return null;
  const out: ComposerCommand[] = [];
  const seen = new Set<string>();
  const append = (item: unknown) => {
    if (out.length >= MAX_COMMANDS) return;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return;
    const entry = item as Record<string, unknown>;
    if (entry.enabled === false) return;
    const name = typeof entry.name === "string" ? entry.name.trim().replace(/^[/\$]/u, "") : "";
    if (name === "" || /\s/u.test(name) || seen.has(name)) return;
    seen.add(name);
    const rawDesc =
      typeof entry.description === "string" && entry.description.trim() !== ""
        ? entry.description.trim()
        : typeof entry.shortDescription === "string"
          ? entry.shortDescription.trim()
          : "";
    const description = rawDesc === "" ? "" : truncateChars(rawDesc, MAX_COMMAND_DESCRIPTION_CHARS);
    const hint = typeof entry.argumentHint === "string" ? entry.argumentHint.trim() : "";
    out.push({
      name,
      description,
      ...(hint === "" ? {} : { argumentHint: truncateChars(hint, MAX_COMMAND_HINT_CHARS) }),
      ...(entry.builtin === true ? { builtin: true as const } : {}),
    });
  };
  for (const item of list) append(item);
  for (const builtin of CODEX_BUILTIN_COMMANDS) append(builtin);
  return out;
}

/**
 * 如果 `text` 以 `/<skill>` 开头且 `<skill>` 不是内置 `compact`（也不是含 `/` 的文件路径），
 * 把开头的 `/<skill>` 改写为 Codex 的 `$<skill>` 触发语法。
 */
export function rewriteCodexSkillCommand(text: string): string {
  const spec = VENDOR_SPECS.codex.composer;
  if (!text.startsWith(spec.commandPrefix)) return text;
  const rest = text.slice(spec.commandPrefix.length);
  const name = rest.split(/\s/u, 1)[0] ?? "";
  if (name === "" || name.includes("/") || name === spec.compactCommand) return text;
  return `$${rest}`;
}

const specBase = createSpecComposerBase("codex");

/** 不用起进程的基础部分。 */
export const codexComposerBase: VendorComposerBase = {
  ...specBase,
  parseCommands: parseCodexCommands,
  mention: (path) => (/[\s"]/u.test(path) ? `@"${path}"` : `@${path}`),
  buildUserContent: (prefixes, text) => userContent(prefixes, rewriteCodexSkillCommand(text)),
};

export interface CodexComposerOptions {
  codexPath?: string;
  querySkills?: (options: CodexModelQueryOptions) => Promise<unknown>;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function createCodexComposer(options?: CodexComposerOptions): VendorComposer {
  return {
    ...codexComposerBase,
    async queryCommands(target: CommandsTarget, signal: AbortSignal) {
      if (!options?.querySkills && !options?.codexPath) {
        return [...CODEX_BUILTIN_COMMANDS];
      }
      const query = options.querySkills ?? queryCodexSkills;
      const raw = await query({
        codexPath: options.codexPath ?? "codex",
        cwd: target.cwd,
        addDirs: target.addDirs,
        timeoutMs: options.timeoutMs ?? COMMANDS_QUERY_TIMEOUT_MS,
        signal,
        ...(options.env ? { env: options.env } : {}),
      });
      const commands = parseCodexCommands(raw);
      if (commands === null) throw new Error("codex skills/list 回应里没有可识别的列表");
      return commands;
    },
  };
}

// ---- 模型名单和登录状态（docs/vendor-availability-design.md 第 3 节）----

/** 同一个 app-server 里 account/read 的回应：有账号能用；account 为 null 且要 OpenAI 登录是没登录；没问到说不清。 */
export const codexCatalogProbe: VendorCatalogProbe = {
  parse: (raw) => parseCodexModels((raw as { models?: unknown } | null)?.models),
  availabilityOf(raw) {
    const read = (raw as { account?: unknown } | null)?.account;
    if (typeof read !== "object" || read === null || !("account" in read)) return "unknown";
    const { account, requiresOpenaiAuth } = read as { account: unknown; requiresOpenaiAuth?: unknown };
    if (typeof account === "object" && account !== null) return "available";
    return requiresOpenaiAuth === false ? "available" : "signed_out";
  },
};

/** 补充判断（老版本没有 account/read 时）：codex 登录后写 $CODEX_HOME/auth.json（默认 ~/.codex/auth.json），只看文件在不在，不起进程。 */
export function codexAuthFileAvailability(env: NodeJS.ProcessEnv, homeDir: string): VendorAvailability {
  const codexHome = env.CODEX_HOME?.trim() || join(homeDir, ".codex");
  return existsSync(join(codexHome, "auth.json")) ? "available" : "signed_out";
}

export function createCodexCatalogSource(options: VendorCatalogSourceOptions): VendorCatalogSource {
  return {
    ...codexCatalogProbe,
    query: (signal) => queryCodexCatalog({ codexPath: options.path, cwd: options.cwd, ...(options.env ? { env: options.env } : {}), signal }),
    confirm: async () => codexAuthFileAvailability(options.env ?? process.env, options.cwd),
    installed: options.installed,
  };
}

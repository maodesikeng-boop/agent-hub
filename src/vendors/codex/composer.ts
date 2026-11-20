import {
  COMMANDS_QUERY_TIMEOUT_MS,
  MAX_COMMANDS,
  MAX_COMMAND_DESCRIPTION_CHARS,
  MAX_COMMAND_HINT_CHARS,
  truncateChars,
  type ComposerCommand,
} from "../../shared/index.ts";
import { userContent } from "../../daemon/driver/protocol.ts";
import type { CommandsTarget, VendorComposer, VendorComposerBase } from "../../daemon/vendors/types.ts";
import { createSpecComposerBase } from "../_common/composer.ts";
import { commandNameOf } from "../types.ts";
import codexSpec from "./spec.ts";
import { queryCodexSkills, type CodexModelQueryOptions } from "./catalog.ts";

const CODEX_BUILTIN_COMMANDS: readonly ComposerCommand[] = [
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

// Codex triggers skills with $<skill>, so a leading /<skill> is rewritten.
export function rewriteCodexSkillCommand(text: string): string {
  const spec = codexSpec.composer;
  const name = commandNameOf(text, spec.commandPrefix);
  if (name === null || name === spec.compactCommand) return text;
  return `$${text.slice(spec.commandPrefix.length)}`;
}

const specBase = createSpecComposerBase("codex");

export const codexComposerBase: VendorComposerBase = {
  ...specBase,
  parseCommands: parseCodexCommands,
  mention: (path) => (/[\s"]/u.test(path) ? `@"${path}"` : `@${path}`),
  buildUserContent: (prefixes, text) => userContent(prefixes, rewriteCodexSkillCommand(text)),
};

export interface CodexComposerOptions {
  executablePath?: string | (() => string);
  querySkills?: (options: CodexModelQueryOptions) => Promise<unknown>;
  env?: Record<string, string | undefined> | (() => Record<string, string | undefined>);
  timeoutMs?: number;
}

export function createCodexComposer(options?: CodexComposerOptions): VendorComposer {
  return {
    ...codexComposerBase,
    async queryCommands(target: CommandsTarget, signal: AbortSignal) {
      if (!options?.querySkills && !options?.executablePath) {
        return [...CODEX_BUILTIN_COMMANDS];
      }
      const query = options.querySkills ?? queryCodexSkills;
      const codexPath =
        typeof options.executablePath === "function"
          ? options.executablePath()
          : (options.executablePath ?? "codex");
      const env = typeof options.env === "function" ? options.env() : options.env;
      const raw = await query({
        codexPath,
        cwd: target.cwd,
        addDirs: target.addDirs,
        timeoutMs: options.timeoutMs ?? COMMANDS_QUERY_TIMEOUT_MS,
        signal,
        ...(env ? { env } : {}),
      });
      const commands = parseCodexCommands(raw);
      if (commands === null) throw new Error("codex skills/list 回应里没有可识别的列表");
      return commands;
    },
  };
}

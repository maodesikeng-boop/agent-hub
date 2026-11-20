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
import { commandNameOf } from "../types.ts";

function isUserOwned(name: string, known: readonly ComposerCommand[] | null): boolean {
  const key = name.toLowerCase();
  const same = (known ?? []).filter((c) => c.name.toLowerCase() === key);
  return same.length > 0 && same.every((c) => c.builtin !== true);
}

export function createSpecComposerBase(vendor: AgentVendor): VendorComposerBase {
  const spec = vendorSpec(vendor).composer;
  const commandName = (text: string): string | null => commandNameOf(text, spec.commandPrefix);
  const blockedReasonOf = (name: string): string | null => {
    const key = name.toLowerCase();
    return Object.hasOwn(spec.blockedCommands, key) ? spec.blockedCommands[key]! : null;
  };
  return {
    vendor,
    parseCommands: parseComposerCommands,
    isHiddenCommand: (command) =>
      isInternalSkillCommand(command.name) || (command.builtin === true && blockedReasonOf(command.name) !== null),
    isCommand: (text) => commandName(text) !== null,
    isCompactCommand: (text) => commandName(text) === spec.compactCommand,
    blockReason(text, known) {
      const name = commandName(text);
      const reason = name === null ? null : blockedReasonOf(name);
      if (name === null || reason === null || isUserOwned(name, known)) return null;
      return `/${name}：${reason}`;
    },
    mention: (path) => (/[\s"]/u.test(path) ? `@"${path}"` : `@${path}`),
    buildUserContent: userContent,
  };
}

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

export function createSpecComposer(vendor: AgentVendor): VendorComposer {
  const base = createSpecComposerBase(vendor);
  const compact: ComposerCommand = { name: vendorSpec(vendor).composer.compactCommand, description: "压缩当前对话上下文", builtin: true };
  return { ...base, queryCommands: async () => [compact] };
}

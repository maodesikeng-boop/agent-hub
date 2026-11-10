// Cursor 输入框 "/" 命令与 "@" 引用实现：
// - 会话运行中：对接 ACP `available_commands_update` 实时命令列表，并始终兜底内置 `/compact`；
// - 会话未运行：轻量扫描项目与用户目录的 `.cursor/commands/*.md`、`.cursor/skills/*/SKILL.md`、`.agents/skills/*/SKILL.md` 并合并 `/compact`，
//   避免为空闲补全拉起耗时约 8s 的重型 ACP 进程。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import {
  MAX_COMMANDS,
  MAX_COMMAND_DESCRIPTION_CHARS,
  truncateChars,
  vendorSpec,
  type ComposerCommand,
} from "../../shared/index.ts";
import type { CommandsTarget, VendorComposer, VendorComposerBase } from "../../daemon/vendors/types.ts";
import { createSpecComposerBase, parseComposerCommands } from "../_common/composer.ts";
import type { VendorComposerDeps } from "../daemon-types.ts";
import { CURSOR_MAX_SCANNED_COMMAND_ENTRIES } from "./limits.ts";

function compactFallbackCommand(): ComposerCommand {
  return {
    name: vendorSpec("cursor").composer.compactCommand,
    description: "压缩当前对话上下文",
    builtin: true,
  };
}

/** 确保命令列表中包含内置压缩命令 `/compact`，并遵守 MAX_COMMANDS 上限。 */
export function ensureCursorCompactCommand(commands: readonly ComposerCommand[]): ComposerCommand[] {
  const compact = compactFallbackCommand();
  const hasCompact = commands.some((c) => c.name.toLowerCase() === compact.name.toLowerCase());
  if (hasCompact) return commands.slice(0, MAX_COMMANDS);
  if (commands.length < MAX_COMMANDS) return [...commands, compact];
  return [...commands.slice(0, MAX_COMMANDS - 1), compact];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 解析 Cursor 命令列表：兼容通用 ComposerCommand 数组与 ACP AvailableCommand 数组（带 input.hint），
 * 非数组（且不含 availableCommands 数组）时返回 null。
 */
export function parseCursorCommands(raw: unknown): ComposerCommand[] | null {
  const list = Array.isArray(raw)
    ? raw
    : (() => {
        const obj = asRecord(raw);
        return Array.isArray(obj?.availableCommands) ? obj.availableCommands : null;
      })();
  if (list === null) return null;

  const normalized = list.map((item) => {
    const entry = asRecord(item);
    if (!entry) return item;
    const inputObj = asRecord(entry.input);
    const hint =
      typeof entry.argumentHint === "string"
        ? entry.argumentHint
        : typeof inputObj?.hint === "string"
          ? inputObj.hint
          : undefined;
    return {
      ...entry,
      ...(hint !== undefined ? { argumentHint: hint } : {}),
      ...(entry.builtin === undefined && inputObj !== null ? { builtin: true } : {}),
    };
  });

  const parsed = parseComposerCommands(normalized);
  if (parsed === null) return null;
  return ensureCursorCompactCommand(parsed);
}

/** 从 Markdown / SKILL.md 头部提取简短说明与 disable-model-invocation 标记。 */
function readMarkdownMeta(filePath: string): { description: string; disabled: boolean } {
  let content = "";
  try {
    content = readFileSync(filePath, "utf8").slice(0, 4096);
  } catch {
    return { description: "", disabled: false };
  }

  let body = content;
  let description = "";
  let disabled = false;

  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx > 0) {
      const frontmatter = content.slice(4, endIdx);
      body = content.slice(endIdx + 4);
      for (const rawLine of frontmatter.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (/^disable-model-invocation\s*:\s*true\b/iu.test(line)) {
          disabled = true;
        }
        const descMatch = /^description\s*:\s*(.+)$/iu.exec(line);
        if (descMatch && description === "") {
          description = descMatch[1]!.trim().replace(/^["']|["']$/gu, "");
        }
      }
    }
  }

  if (description === "") {
    for (const rawLine of body.split(/\r?\n/u)) {
      const line = rawLine.trim().replace(/^#+\s*/u, "");
      if (line !== "" && !line.startsWith("```")) {
        description = line;
        break;
      }
    }
  }

  return {
    description: truncateChars(description, MAX_COMMAND_DESCRIPTION_CHARS),
    disabled,
  };
}

function scanCommandsDir(dir: string, out: ComposerCommand[], seen: Set<string>): void {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).slice(0, CURSOR_MAX_SCANNED_COMMAND_ENTRIES);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_COMMANDS - 1) return;
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") continue;
    const rawName = basename(entry.name, extname(entry.name)).trim();
    if (rawName === "" || /\s|\//u.test(rawName)) continue;
    const key = rawName.toLowerCase();
    if (seen.has(key)) continue;
    const meta = readMarkdownMeta(join(dir, entry.name));
    seen.add(key);
    out.push({ name: rawName, description: meta.description });
  }
}

function scanSkillsDir(dir: string, out: ComposerCommand[], seen: Set<string>): void {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).slice(0, CURSOR_MAX_SCANNED_COMMAND_ENTRIES);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_COMMANDS - 1) return;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const rawName = entry.name.trim();
    if (rawName === "" || rawName.startsWith(".") || /\s|\//u.test(rawName)) continue;
    const key = rawName.toLowerCase();
    if (seen.has(key)) continue;
    const skillFile = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const meta = readMarkdownMeta(skillFile);
    seen.add(key);
    out.push({ name: rawName, description: meta.description });
  }
}

function collectLocalCursorCommands(target: CommandsTarget, userHome: string): ComposerCommand[] {
  const out: ComposerCommand[] = [];
  const seen = new Set<string>();
  const roots = [...new Set([target.cwd, ...target.addDirs].filter((p) => p.trim() !== ""))];

  for (const root of roots) {
    scanCommandsDir(join(root, ".cursor", "commands"), out, seen);
    scanSkillsDir(join(root, ".cursor", "skills"), out, seen);
    scanSkillsDir(join(root, ".agents", "skills"), out, seen);
  }

  if (userHome.trim() !== "") {
    scanCommandsDir(join(userHome, ".cursor", "commands"), out, seen);
    scanSkillsDir(join(userHome, ".cursor", "skills"), out, seen);
    scanSkillsDir(join(userHome, ".agents", "skills"), out, seen);
  }

  return ensureCursorCompactCommand(out);
}

const baseSpecComposer = createSpecComposerBase("cursor");

export const cursorComposerBase: VendorComposerBase = {
  ...baseSpecComposer,
  parseCommands: parseCursorCommands,
};

export function createCursorComposer(deps: VendorComposerDeps): VendorComposer {
  const userHome = deps.env?.HOME?.trim() || homedir();
  return {
    ...cursorComposerBase,
    async queryCommands(target: CommandsTarget, signal: AbortSignal): Promise<ComposerCommand[]> {
      if (signal.aborted) throw new Error("cursor commands query aborted");
      return collectLocalCursorCommands(target, userHome);
    },
  };
}

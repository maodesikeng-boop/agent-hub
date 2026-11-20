// Scan command files while idle instead of booting the opencode acp server.
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { MAX_COMMANDS, MAX_COMMAND_DESCRIPTION_CHARS, truncateChars, type ComposerCommand } from "../../shared/index.ts";
import type { CommandsTarget, VendorComposer, VendorComposerBase } from "../../daemon/vendors/types.ts";
import { createSpecComposerBase } from "../_common/composer.ts";
import type { VendorComposerDeps } from "../daemon-types.ts";
import { OPENCODE_MAX_SCANNED_COMMAND_ENTRIES } from "./limits.ts";
import opencodeSpec from "./spec.ts";

const HEAD_BYTES = 2048;

const COMPACT_COMMAND: ComposerCommand = {
  name: opencodeSpec.composer.compactCommand,
  description: "压缩当前对话上下文",
  builtin: true,
};

function readDescription(filePath: string): string {
  let fd: number | null = null;
  try {
    // Non-blocking open: a command file could be a FIFO.
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return "";
    const buf = Buffer.alloc(HEAD_BYTES);
    const head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
    const match = /^---\r?\n[\s\S]*?^description\s*:\s*(.+)$/imu.exec(head);
    return truncateChars((match?.[1] ?? "").trim().replace(/^["']|["']$/gu, ""), MAX_COMMAND_DESCRIPTION_CHARS);
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function scanCommandDir(dir: string, out: ComposerCommand[], seen: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).slice(0, OPENCODE_MAX_SCANNED_COMMAND_ENTRIES);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_COMMANDS - 1) return;
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") continue;
    const name = basename(entry.name, extname(entry.name)).trim();
    if (name === "" || /\s|\//u.test(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, description: readDescription(join(dir, entry.name)) });
  }
}

export function collectOpenCodeCommands(target: CommandsTarget, userHome: string): ComposerCommand[] {
  const out: ComposerCommand[] = [];
  const seen = new Set<string>([COMPACT_COMMAND.name]);
  for (const root of new Set([target.cwd, ...target.addDirs].filter((p) => p.trim() !== ""))) {
    scanCommandDir(join(root, ".opencode", "commands"), out, seen);
    scanCommandDir(join(root, ".opencode", "command"), out, seen);
  }
  if (userHome.trim() !== "") scanCommandDir(join(userHome, ".config", "opencode", "commands"), out, seen);
  return [...out, COMPACT_COMMAND];
}

export const opencodeComposerBase: VendorComposerBase = createSpecComposerBase("opencode");

export function createOpenCodeComposer(deps: VendorComposerDeps): VendorComposer {
  return {
    ...opencodeComposerBase,
    async queryCommands(target, signal) {
      if (signal.aborted) throw new Error("opencode commands query aborted");
      const env = typeof deps.env === "function" ? deps.env() : deps.env;
      return collectOpenCodeCommands(target, env?.HOME?.trim() || env?.USERPROFILE?.trim() || homedir());
    },
  };
}

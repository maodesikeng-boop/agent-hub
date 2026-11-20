import { execFileSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  hashDirectoryContents,
  isPathStrictlyInside,
  normalizePathForComparison,
  readManagedSkillCopyMeta,
} from "../../../daemon/platform/index.ts";
import { MAX_VENDOR_SYNC_SKILL_ITEMS, PM_CAPABILITY_DESCRIPTION_MAX_CHARS, truncateChars } from "../../../shared/index.ts";

export function safeRealpath(targetPath: string): string {
  try {
    return realpathSync.native(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

export function listCanonicalSkillNames(canonicalSkillsDir: string): { names: string[]; truncated: boolean } {
  if (!existsSync(canonicalSkillsDir)) return { names: [], truncated: false };
  let entries: string[];
  try {
    entries = readdirSync(canonicalSkillsDir).sort();
  } catch {
    return { names: [], truncated: false };
  }
  const names: string[] = [];
  let truncated = false;
  for (const name of entries) {
    if (name.startsWith(".") || name.includes("/") || name.includes("\\")) continue;
    const entryPath = join(canonicalSkillsDir, name);
    try {
      if (!statSync(entryPath).isDirectory()) continue;
      if (!existsSync(join(entryPath, "SKILL.md"))) continue;
    } catch {
      continue;
    }
    if (names.length >= MAX_VENDOR_SYNC_SKILL_ITEMS) {
      truncated = true;
      break;
    }
    names.push(name);
  }
  return { names, truncated };
}

export type SkillTargetEntryState =
  | "whole_dir_symlink"
  | "linked"
  | "managed_copy"
  | "missing_or_stale_managed"
  | "user_private_conflict";

function isGitTrackedSymlinkBlob(filePath: string): boolean {
  try {
    const out = execFileSync(
      "git",
      ["-C", dirname(filePath), "ls-files", "-s", "--", basename(filePath)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000, windowsHide: true },
    ).trim();
    return out.startsWith("120000 ");
  } catch {
    return false;
  }
}

export function isWholeDirLinkedToCanonical(targetSkillsDir: string, canonicalSkillsDir: string): boolean {
  try {
    const st = lstatSync(targetSkillsDir);
    const canonicalRealKey = normalizePathForComparison(safeRealpath(canonicalSkillsDir));
    if (st.isSymbolicLink()) {
      const rawTarget = readlinkSync(targetSkillsDir);
      const resolvedLink = resolve(dirname(targetSkillsDir), rawTarget);
      return normalizePathForComparison(safeRealpath(resolvedLink)) === canonicalRealKey;
    }
    // Git for Windows with core.symlinks=false checks out symlinks as one-line text files holding the target path.
    if (st.isFile() && st.size > 0 && st.size <= 1024) {
      const rawText = readFileSync(targetSkillsDir, "utf8").trim();
      if (rawText !== "" && !rawText.includes("\n") && !rawText.includes("\r")) {
        const candidateTarget = resolve(dirname(targetSkillsDir), rawText);
        if (
          normalizePathForComparison(safeRealpath(candidateTarget)) === canonicalRealKey &&
          isGitTrackedSymlinkBlob(targetSkillsDir)
        ) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function isManagedAgentsSkillSymlink(linkPath: string, canonicalSkillsDir: string): boolean {
  try {
    const st = lstatSync(linkPath);
    if (st.isDirectory()) {
      const meta = readManagedSkillCopyMeta(linkPath);
      if (meta === null) return false;
      if (isPathStrictlyInside(resolve(canonicalSkillsDir), resolve(meta.canonicalPath))) return true;
      return isPathStrictlyInside(safeRealpath(canonicalSkillsDir), safeRealpath(meta.canonicalPath));
    }
    if (!st.isSymbolicLink()) return false;
    const resolvedTarget = resolve(dirname(linkPath), readlinkSync(linkPath));
    if (isPathStrictlyInside(resolve(canonicalSkillsDir), resolvedTarget)) return true;
    return isPathStrictlyInside(safeRealpath(canonicalSkillsDir), safeRealpath(resolvedTarget));
  } catch {
    return false;
  }
}

export function inspectSkillTargetEntry(
  targetSkillsDir: string,
  canonicalSkillsDir: string,
  skillName: string,
): SkillTargetEntryState {
  if (isWholeDirLinkedToCanonical(targetSkillsDir, canonicalSkillsDir)) {
    return "whole_dir_symlink";
  }
  const entryPath = join(targetSkillsDir, skillName);
  const canonicalEntryPath = join(canonicalSkillsDir, skillName);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(entryPath);
  } catch {
    return "missing_or_stale_managed";
  }

  if (st.isSymbolicLink()) {
    const rawTarget = readlinkSync(entryPath);
    const resolvedTarget = resolve(dirname(entryPath), rawTarget);
    if (
      normalizePathForComparison(safeRealpath(resolvedTarget)) ===
      normalizePathForComparison(safeRealpath(canonicalEntryPath))
    ) {
      return "linked";
    }
    if (isManagedAgentsSkillSymlink(entryPath, canonicalSkillsDir)) {
      return "missing_or_stale_managed";
    }
    return "user_private_conflict";
  }

  if (st.isDirectory()) {
    const meta = readManagedSkillCopyMeta(entryPath);
    if (meta !== null && isManagedAgentsSkillSymlink(entryPath, canonicalSkillsDir)) {
      const sameCanonical =
        normalizePathForComparison(safeRealpath(meta.canonicalPath)) ===
        normalizePathForComparison(safeRealpath(canonicalEntryPath));
      if (sameCanonical && existsSync(canonicalEntryPath) && meta.contentHash === hashDirectoryContents(canonicalEntryPath)) {
        return "managed_copy";
      }
      return "missing_or_stale_managed";
    }
  }

  // Real directories and files are user-owned skills; never delete or overwrite them.
  return "user_private_conflict";
}

const SKILL_DESCRIPTION_READ_BYTES = 8 * 1024;

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).replace(/\\(["\\nrt])/g, (_m, ch: string) => {
        if (ch === "n") return " ";
        if (ch === "r" || ch === "t") return " ";
        return ch;
      });
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1).replace(/''/g, "'");
    }
  }
  return trimmed;
}

function readSkillFrontmatterLines(skillDir: string): string[] | null {
  const skillFile = join(skillDir, "SKILL.md");
  let head = "";
  try {
    const st = statSync(skillFile);
    if (!st.isFile()) return null;
    const fd = openSync(skillFile, "r");
    try {
      const buf = Buffer.allocUnsafe(SKILL_DESCRIPTION_READ_BYTES);
      const bytesRead = readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = head.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const closeIdx = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
  if (closeIdx <= 0) return null;
  return lines.slice(1, closeIdx);
}

export function readSkillName(skillDir: string): string | null {
  const fmLines = readSkillFrontmatterLines(skillDir);
  if (fmLines === null) return null;
  for (const line of fmLines) {
    const match = /^name\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = unquoteYamlScalar(match[1]!).trim();
    return name === "" ? null : name;
  }
  return null;
}

export function readSkillDescription(skillDir: string): string | null {
  const fmLines = readSkillFrontmatterLines(skillDir);
  if (fmLines === null) return null;

  for (let i = 0; i < fmLines.length; i++) {
    const match = /^description\s*:\s*(.*)$/.exec(fmLines[i]!);
    if (!match) continue;
    const rest = match[1]!.trim();
    if (rest === ">" || rest === "|-" || rest === ">-" || rest === "|") {
      const parts: string[] = [];
      for (let j = i + 1; j < fmLines.length; j++) {
        const cont = fmLines[j]!;
        if (cont.trim() === "") continue;
        if (!/^\s+/.test(cont)) break;
        parts.push(cont.trim());
      }
      const joined = parts.join(" ").replace(/\s+/g, " ").trim();
      return joined === "" ? null : truncateChars(joined, PM_CAPABILITY_DESCRIPTION_MAX_CHARS);
    }
    const cleaned = unquoteYamlScalar(rest).replace(/\s+/g, " ").trim();
    return cleaned === "" ? null : truncateChars(cleaned, PM_CAPABILITY_DESCRIPTION_MAX_CHARS);
  }
  return null;
}

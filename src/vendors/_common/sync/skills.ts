// 基准 `.agents/skills` 目录扫描与目标厂商技能目录逐项软链对账（绝不整目录替换，绝不覆盖用户私有技能）。
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

/** 安全的 `realpath`：目标存在时返回真实路径，悬空软链或不存在时回退 `resolve`。 */
export function safeRealpath(targetPath: string): string {
  try {
    return realpathSync.native(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

/**
 * 扫描基准 `.agents/skills` 目录下的有效技能包：
 * - 跳过以 `.` 开头的隐藏项；
 * - 必须是包含 `SKILL.md` 的目录（跳过如 `PSTACK-LICENSE` 这类普通文件）。
 */
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
  /** 目标技能目录本身就是指向基准 `.agents/skills` 目录的整目录软链（如仓库 `.claude/skills -> ../.agents/skills`）。 */
  | "whole_dir_symlink"
  /** 目标下 `<name>` 已是指向该基准技能的逐项软链。 */
  | "linked"
  /** 目标下 `<name>` 是 UNC / 网络盘回退生成的受控副本（带 `.fusa-managed` 且内容哈希一致）。 */
  | "managed_copy"
  /** 目标下 `<name>` 不存在，或是指向 `.agents/skills` 下旧路径的软链（可安全建/更软链）。 */
  | "missing_or_stale_managed"
  /** 目标下 `<name>` 是用户自己的真实目录/文件或外部私有软链（必须原样保留，绝不覆盖）。 */
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

/** 检查目标技能目录是否为指向基准 `.agents/skills` 的整目录软链。 */
export function isWholeDirLinkedToCanonical(targetSkillsDir: string, canonicalSkillsDir: string): boolean {
  try {
    const st = lstatSync(targetSkillsDir);
    const canonicalRealKey = normalizePathForComparison(safeRealpath(canonicalSkillsDir));
    if (st.isSymbolicLink()) {
      const rawTarget = readlinkSync(targetSkillsDir);
      const resolvedLink = resolve(dirname(targetSkillsDir), rawTarget);
      return normalizePathForComparison(safeRealpath(resolvedLink)) === canonicalRealKey;
    }
    // Git for Windows 默认 core.symlinks=false 时会把仓库内 120000 软链检出成单行路径文本文件
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

/**
 * 判断软链是否是指向 **这一个** 基准 `canonicalSkillsDir` 里某项的受管软链（只有它允许更新或移除）。
 * 按路径包含关系判断（字面解析、真实路径各比一次，悬空软链也认得），不按字符串里有没有 `.agents/skills/`：
 * 用户自己指向别的项目 `.agents/skills/x` 的私有软链不能被当成受管的覆盖或删掉。
 */
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

/** 诊断单个技能 `<skillName>` 在某厂商 `targetSkillsDir` 中的现状。 */
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

  // 真实目录或真实文件 = 用户私有技能，绝不删除或覆盖
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

/** 只读提取 `<skillDir>/SKILL.md` 的 frontmatter description，截断到 PM_CAPABILITY_DESCRIPTION_MAX_CHARS。 */
export function readSkillDescription(skillDir: string): string | null {
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
  const fmLines = lines.slice(1, closeIdx);

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

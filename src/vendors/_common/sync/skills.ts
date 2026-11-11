// 基准 `.agents/skills` 目录扫描与目标厂商技能目录逐项软链对账（绝不整目录替换，绝不覆盖用户私有技能）。
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MAX_VENDOR_SYNC_SKILL_ITEMS } from "../../../shared/index.ts";

/** 安全的 `realpath`：目标存在时返回真实路径，悬空软链或不存在时回退 `resolve`。 */
export function safeRealpath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
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
  /** 目标下 `<name>` 不存在，或是指向 `.agents/skills` 下旧路径的软链（可安全建/更软链）。 */
  | "missing_or_stale_managed"
  /** 目标下 `<name>` 是用户自己的真实目录/文件或外部私有软链（必须原样保留，绝不覆盖）。 */
  | "user_private_conflict";

/** 检查目标技能目录是否为指向基准 `.agents/skills` 的整目录软链。 */
export function isWholeDirLinkedToCanonical(targetSkillsDir: string, canonicalSkillsDir: string): boolean {
  try {
    const st = lstatSync(targetSkillsDir);
    if (!st.isSymbolicLink()) return false;
    const rawTarget = readlinkSync(targetSkillsDir);
    const resolvedLink = resolve(dirname(targetSkillsDir), rawTarget);
    return safeRealpath(resolvedLink) === safeRealpath(canonicalSkillsDir);
  } catch {
    return false;
  }
}

/** 判断软链目标是否属于 `.agents/skills/` 体系（仅受管软链允许更新或移除）。 */
export function isManagedAgentsSkillSymlink(linkPath: string, canonicalSkillsDir: string): boolean {
  try {
    const st = lstatSync(linkPath);
    if (!st.isSymbolicLink()) return false;
    const rawTarget = readlinkSync(linkPath);
    const resolvedTarget = resolve(dirname(linkPath), rawTarget);
    const realCanonical = safeRealpath(canonicalSkillsDir);
    const realResolved = safeRealpath(resolvedTarget);
    if (realResolved === realCanonical || realResolved.startsWith(`${realCanonical}/`)) return true;
    const normalizedRaw = rawTarget.replace(/\\/g, "/");
    return normalizedRaw.includes(".agents/skills/");
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
    if (safeRealpath(resolvedTarget) === safeRealpath(canonicalEntryPath)) {
      return "linked";
    }
    if (isManagedAgentsSkillSymlink(entryPath, canonicalSkillsDir)) {
      return "missing_or_stale_managed";
    }
    return "user_private_conflict";
  }

  // 真实目录或真实文件 = 用户私有技能，绝不删除或覆盖
  return "user_private_conflict";
}

// 技能文件在磁盘上的那一半（docs/skill-carryover-design.md）：认到的加载落到哪个 SKILL.md、按名字去哪些技能目录找、换代时读正文。
// 账本（ledger/loaded-skills.ts）只认 shared/skill-loads.ts 给的信号，碰磁盘的都在这里。
// 技能目录不另起一张表：会话启动目录里的产品技能（task-graph-skill.ts），加上各家 vendor-sync 已经声明的项目、全局技能目录（VendorSyncAdapter.skillTarget）。
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentSessionRow } from "../shared/domain.ts";
import { SKILL_CARRYOVER_SKILL_MAX_CHARS } from "../shared/limits.ts";
import { sessionLaunchDir } from "../shared/paths.ts";
import type { SkillLoad } from "../shared/skill-loads.ts";
import { isAgentVendor } from "../shared/vendors.ts";
import { VENDOR_DAEMONS } from "../vendors/daemon-registry.ts";
import type { VendorSyncContext } from "../vendors/daemon-types.ts";
import { productSkillsDir } from "./task-graph-skill.ts";

/** 认技能用到的会话信息。 */
export type SkillSession = Pick<AgentSessionRow, "id" | "vendor" | "cwd" | "addDirs">;

export interface SkillFiles {
  /** 认到的一次加载落到哪个 SKILL.md：path 是认到的路径（绝对路径），key 是真实路径（软链和原文件算一个）。文件不在是 null。 */
  locate(load: SkillLoad, session: SkillSession): { path: string; key: string } | null;
  /** 换代时读正文；读不到（删了、不是文件）是 null。 */
  read(path: string): string | null;
}

/** 各家都认的标准技能目录（vendor-sync 的 native）。 */
const AGENTS_SKILLS = join(".agents", "skills");

/** 一个 SKILL.md 最多读这么多字节：误认到大文件时不整个读进来。 */
const SKILL_READ_MAX_BYTES = SKILL_CARRYOVER_SKILL_MAX_CHARS * 4;

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export function createSkillFiles(options: { launchDir?: string; userHome: string; env?: VendorSyncContext["env"] }): SkillFiles {
  const ctx: VendorSyncContext = { userHome: options.userHome, env: options.env ?? {} };

  /** 按名字找技能时的目录，先到先得：启动目录里的产品技能、工作目录和附加目录下这家的项目技能目录、这家的全局技能目录。 */
  const skillDirs = (session: SkillSession): string[] => {
    const dirs: string[] = [];
    if (options.launchDir !== undefined) dirs.push(productSkillsDir(sessionLaunchDir(options.launchDir, session.id)));
    const adapter = isAgentVendor(session.vendor) ? VENDOR_DAEMONS[session.vendor].sync : undefined;
    for (const projectDir of [session.cwd, ...session.addDirs]) {
      const target = adapter?.skillTarget(ctx, { kind: "project", projectDir });
      if (target?.mode === "symlink") dirs.push(target.targetDir);
      dirs.push(join(projectDir, AGENTS_SKILLS));
    }
    const global = adapter?.skillTarget(ctx, { kind: "global" });
    if (global?.mode === "symlink") dirs.push(global.targetDir);
    dirs.push(join(options.userHome, AGENTS_SKILLS));
    return dirs;
  };

  const expandHome = (part: string) => (part === "~" ? options.userHome : part.startsWith("~/") ? join(options.userHome, part.slice(2)) : part);

  const pathOf = (load: SkillLoad, session: SkillSession): string | null => {
    if (load.by === "file") return resolve(session.cwd, ...load.cwd.map(expandHome), expandHome(load.path));
    return skillDirs(session).map((dir) => join(dir, load.name, "SKILL.md")).find(isFile) ?? null;
  };

  return {
    locate(load, session) {
      const path = pathOf(load, session);
      if (path === null || !isAbsolute(path) || !isFile(path)) return null;
      try {
        return { path, key: realpathSync(path) };
      } catch {
        return null;
      }
    },
    read(path) {
      if (!isFile(path)) return null;
      let fd: number | null = null;
      try {
        fd = openSync(path, "r");
        const buffer = Buffer.alloc(SKILL_READ_MAX_BYTES);
        const size = readSync(fd, buffer, 0, buffer.length, 0);
        return buffer.subarray(0, size).toString("utf8");
      } catch {
        return null;
      } finally {
        if (fd !== null) closeSync(fd);
      }
    },
  };
}

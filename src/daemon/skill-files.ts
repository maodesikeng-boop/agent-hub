// 技能文件在磁盘上的那一半（docs/skill-carryover-design.md）：枚举技能目录建已知技能名单、看工具参数里的路径是哪个文件、换代时读正文。
// 账本（ledger/loaded-skills.ts）只认 shared/skill-loads.ts 给的信号，碰磁盘的都在这里。只读名单里的文件，从模型写的文本里拼出来的路径一律不打开。
// 技能目录不另起一张表：会话启动目录里的产品技能（task-graph-skill.ts），加上各家 vendor-sync 已经声明的项目、全局技能目录（VendorSyncAdapter.skillTarget）。
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { LRUCache } from "lru-cache";
import type { AgentSessionRow } from "../shared/domain.ts";
import {
  SKILL_CARRYOVER_SKILL_MAX_CHARS,
  SKILL_CATALOG_CACHE_MAX,
  SKILL_CATALOG_MAX_SKILLS,
  SKILL_CATALOG_TTL_MS,
  SKILL_HEAD_READ_BYTES,
} from "../shared/limits.ts";
import { sessionLaunchDir } from "../shared/paths.ts";
import { createSkillCatalog, skillHeads, type KnownSkill, type SkillCatalog } from "../shared/skill-loads.ts";
import { isSkillName } from "../shared/skill-names.ts";
import { AGENT_VENDORS, isAgentVendor } from "../shared/vendors.ts";
import { VENDOR_DAEMONS } from "../vendors/daemon-registry.ts";
import type { VendorSyncContext } from "../vendors/daemon-types.ts";
import { productSkillsDir } from "./task-graph-skill.ts";

/** 认技能用到的会话信息。 */
export type SkillSession = Pick<AgentSessionRow, "id" | "vendor" | "cwd" | "addDirs">;

export interface SkillFiles {
  /** 这个会话的已知技能名单。技能目录没变时复用缓存（最多 SKILL_CATALOG_TTL_MS）；fresh 不用缓存、现枚举（换代时）。 */
  catalog(session: SkillSession, options?: { fresh?: boolean }): SkillCatalog;
  /** 换代时读正文：只读名单里的文件，读之前再核一次真实路径没变；读不到是 null。 */
  read(skill: KnownSkill): string | null;
}

/** 各家都认的标准技能目录（vendor-sync 的 native）。 */
const AGENTS_SKILLS = join(".agents", "skills");

/** 一个 SKILL.md 最多读这么多字节。 */
const SKILL_READ_MAX_BYTES = SKILL_CARRYOVER_SKILL_MAX_CHARS * 4;

/** 文件开头最多 bytes 字节；读不了是 null。 */
function readStart(path: string, bytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(bytes);
    const size = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, size).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** path 的真实路径，要求它是个叫 SKILL.md 的普通文件；不是是 null。 */
function realSkillFile(path: string): string | null {
  try {
    const real = realpathSync(path);
    return basename(real) === "SKILL.md" && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** 文件身份（设备号:inode）：软链、硬链指到同一个文件都一样。不是普通文件是 null。 */
function fileIdOf(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return stat.isFile() ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

/** 目录的修改时间（纳秒）：里面加了、删了技能就会变。不在是 -1。 */
function dirStamp(dir: string): string {
  try {
    return String(statSync(dir, { bigint: true }).mtimeNs);
  } catch {
    return "-1";
  }
}

export function createSkillFiles(options: { launchDir?: string; userHome: string; env?: VendorSyncContext["env"] }): SkillFiles {
  const ctx: VendorSyncContext = { userHome: options.userHome, env: options.env ?? {} };
  const cache = new LRUCache<string, { stamp: string; catalog: SkillCatalog }>({ max: SKILL_CATALOG_CACHE_MAX, ttl: SKILL_CATALOG_TTL_MS });

  /**
   * 技能目录，先到先得：启动目录里的产品技能；这家在工作目录、附加目录下的项目技能目录和 .agents/skills；这家的全局目录和 ~/.agents/skills；
   * 最后是别家声明的项目、全局目录（切换厂商后上一家目录里的技能还要能读，模型也会去读别家目录里的技能）。
   */
  const rootsOf = (session: SkillSession): string[] => {
    const roots: string[] = [];
    const add = (dir: string | undefined) => {
      if (dir !== undefined && !roots.includes(dir)) roots.push(dir);
    };
    if (options.launchDir !== undefined) add(productSkillsDir(sessionLaunchDir(options.launchDir, session.id)));
    const projectDirs = [session.cwd, ...session.addDirs];
    const declared = (vendor: string, scope: { kind: "global" } | { kind: "project"; projectDir: string }) => {
      const target = isAgentVendor(vendor) ? VENDOR_DAEMONS[vendor].sync?.skillTarget(ctx, scope) : undefined;
      return target?.mode === "symlink" ? target.targetDir : undefined;
    };
    for (const projectDir of projectDirs) {
      add(declared(session.vendor, { kind: "project", projectDir }));
      add(join(projectDir, AGENTS_SKILLS));
    }
    add(declared(session.vendor, { kind: "global" }));
    add(join(options.userHome, AGENTS_SKILLS));
    for (const vendor of AGENT_VENDORS) {
      for (const projectDir of projectDirs) add(declared(vendor, { kind: "project", projectDir }));
      add(declared(vendor, { kind: "global" }));
    }
    return roots;
  };

  const expandHome = (path: string) => (path === "~" ? options.userHome : path.startsWith("~/") ? join(options.userHome, path.slice(2)) : path);

  /** 枚举：每个技能目录下的 <名字>/SKILL.md，真实路径落在某个技能目录的真实路径里面才收；同一个真实路径只收第一次见到的。 */
  const build = (roots: readonly string[], cwd: string): SkillCatalog => {
    const realRoots = roots.flatMap((root) => {
      try {
        return [realpathSync(root) + sep];
      } catch {
        return [];
      }
    });
    const skills: KnownSkill[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      let names: string[];
      try {
        names = readdirSync(root).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        if (skills.length >= SKILL_CATALOG_MAX_SKILLS) break;
        if (!isSkillName(name)) continue;
        const path = join(root, name, "SKILL.md");
        const key = realSkillFile(path);
        if (key === null || seen.has(key) || !realRoots.some((r) => key.startsWith(r))) continue;
        const fileId = fileIdOf(key);
        const head = readStart(key, SKILL_HEAD_READ_BYTES);
        if (fileId === null || head === null) continue;
        seen.add(key);
        skills.push({ name, path, key, fileId, heads: skillHeads(head) });
      }
    }
    return createSkillCatalog(skills, (path) => fileIdOf(resolve(cwd, expandHome(path))));
  };

  return {
    catalog(session, { fresh = false } = {}) {
      const roots = rootsOf(session);
      const key = JSON.stringify([session.cwd, roots]);
      const stamp = roots.map(dirStamp).join(",");
      const cached = fresh ? undefined : cache.get(key);
      if (cached !== undefined && cached.stamp === stamp) return cached.catalog;
      const catalog = build(roots, session.cwd);
      cache.set(key, { stamp, catalog });
      return catalog;
    },
    read(skill) {
      return realSkillFile(skill.path) === skill.key ? readStart(skill.key, SKILL_READ_MAX_BYTES) : null;
    },
  };
}

// 技能文件在磁盘上的那一半（docs/skill-carryover-design.md）：枚举技能目录建已知技能名单、看工具参数里的路径是哪个文件、换代时读正文。
// 账本（ledger/loaded-skills.ts）只认 shared/skill-loads.ts 给的信号，碰磁盘的都在这里。只读名单里的文件，从模型写的文本里拼出来的路径一律不打开。
// 技能目录不另起一张表：会话启动目录里的产品技能（task-graph-skill.ts），加上各家 vendor-sync 已经声明的项目、全局技能目录（VendorSyncAdapter.skillTarget）。
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  /** 换代时读正文：只读名单里过了边界的真实路径，读之前再核一次枚举到的路径现在还指到它；读不到是 null。 */
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

/** 一个技能目录：锚点（启动目录、用户主目录、项目目录）加上从锚点往下的技能子路径。 */
interface SkillRoot {
  anchor: string;
  dir: string;
}

/** dir 在 anchor 下面时以 anchor 为锚点；不在（环境变量把厂商配置目录指到了主目录外面）时它自己就是锚点。 */
function rootUnder(anchor: string, dir: string): SkillRoot {
  const sub = relative(anchor, dir);
  return sub === ".." || sub.startsWith(`..${sep}`) || isAbsolute(sub) ? { anchor: dir, dir } : { anchor, dir };
}

/** 可信根：锚点的真实路径按字面拼上技能子路径，拼的这一段不跟随软链。锚点不在是 null。 */
function trustedRootOf(root: SkillRoot): string | null {
  try {
    return join(realpathSync(root.anchor), relative(root.anchor, root.dir));
  } catch {
    return null;
  }
}

/**
 * 技能文件的边界，只在这里判断：真实路径恰好是 <可信根>/<合法技能名>/SKILL.md 的普通文件才是技能文件，返回这个真实路径，不是是 null。
 * 软链指到另一个可信根里面照常收（.claude/skills → ../.agents/skills、vendor-sync 的逐项软链）；指到技能目录外面、仓库里别的目录的不收。
 * 不防在检查和读取之间换文件的本机进程。
 */
function skillFileIn(path: string, trustedRoots: ReadonlySet<string>): string | null {
  try {
    const real = realpathSync(path);
    const dir = dirname(real);
    if (basename(real) !== "SKILL.md" || !isSkillName(basename(dir)) || !trustedRoots.has(dirname(dir))) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** path 现在的真实路径；不在是 null。 */
function realpathOf(path: string): string | null {
  try {
    return realpathSync(path);
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
  const rootsOf = (session: SkillSession): SkillRoot[] => {
    const roots: SkillRoot[] = [];
    const add = (anchor: string, dir: string | undefined) => {
      if (dir !== undefined && !roots.some((r) => r.dir === dir)) roots.push(rootUnder(anchor, dir));
    };
    if (options.launchDir !== undefined) add(options.launchDir, productSkillsDir(sessionLaunchDir(options.launchDir, session.id)));
    const projectDirs = [session.cwd, ...session.addDirs];
    const declared = (vendor: string, scope: { kind: "global" } | { kind: "project"; projectDir: string }) => {
      const target = isAgentVendor(vendor) ? VENDOR_DAEMONS[vendor].sync?.skillTarget(ctx, scope) : undefined;
      return target?.mode === "symlink" ? target.targetDir : undefined;
    };
    for (const projectDir of projectDirs) {
      add(projectDir, declared(session.vendor, { kind: "project", projectDir }));
      add(projectDir, join(projectDir, AGENTS_SKILLS));
    }
    add(options.userHome, declared(session.vendor, { kind: "global" }));
    add(options.userHome, join(options.userHome, AGENTS_SKILLS));
    for (const vendor of AGENT_VENDORS) {
      for (const projectDir of projectDirs) add(projectDir, declared(vendor, { kind: "project", projectDir }));
      add(options.userHome, declared(vendor, { kind: "global" }));
    }
    return roots;
  };

  const expandHome = (path: string) => (path === "~" ? options.userHome : path.startsWith("~/") ? join(options.userHome, path.slice(2)) : path);

  /**
   * 枚举：每个技能目录下的 <名字>/SKILL.md，过了 skillFileIn 的边界才收。名字是目录项（厂商按它列技能），身份是真实路径，
   * 同一个名字指同一个文件只收一条：整目录软链、逐项软链不重复；跨名软链按两个名字各收一条，别名不遮蔽原名。
   */
  const build = (roots: readonly SkillRoot[], cwd: string): SkillCatalog => {
    const trustedRoots = new Set(roots.flatMap((root) => trustedRootOf(root) ?? []));
    const skills: KnownSkill[] = [];
    const seen = new Set<string>();
    for (const { dir } of roots) {
      let names: string[];
      try {
        names = readdirSync(dir).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        if (skills.length >= SKILL_CATALOG_MAX_SKILLS) break;
        if (!isSkillName(name)) continue;
        const path = join(dir, name, "SKILL.md");
        const key = skillFileIn(path, trustedRoots);
        if (key === null || seen.has(`${name}\0${key}`)) continue;
        const fileId = fileIdOf(key);
        const head = readStart(key, SKILL_HEAD_READ_BYTES);
        if (fileId === null || head === null) continue;
        seen.add(`${name}\0${key}`);
        skills.push({ name, path, key, fileId, heads: skillHeads(head) });
      }
    }
    return createSkillCatalog(skills, (path) => fileIdOf(resolve(cwd, expandHome(path))));
  };

  return {
    catalog(session, { fresh = false } = {}) {
      const roots = rootsOf(session);
      const key = JSON.stringify([session.cwd, roots]);
      const stamp = roots.map((r) => dirStamp(r.dir)).join(",");
      const cached = fresh ? undefined : cache.get(key);
      if (cached !== undefined && cached.stamp === stamp) return cached.catalog;
      const catalog = build(roots, session.cwd);
      cache.set(key, { stamp, catalog });
      return catalog;
    },
    read(skill) {
      return realpathOf(skill.path) === skill.key ? readStart(skill.key, SKILL_READ_MAX_BYTES) : null;
    },
  };
}

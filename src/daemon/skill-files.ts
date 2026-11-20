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

export type SkillSession = Pick<AgentSessionRow, "id" | "vendor" | "cwd" | "addDirs">;

export interface SkillFiles {
  catalog(session: SkillSession, options?: { fresh?: boolean }): SkillCatalog;
  read(skill: KnownSkill): string | null;
}

const AGENTS_SKILLS = join(".agents", "skills");

const SKILL_READ_MAX_BYTES = SKILL_CARRYOVER_SKILL_MAX_CHARS * 4;

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

interface SkillRoot {
  anchor: string;
  dir: string;
}

function rootUnder(anchor: string, dir: string): SkillRoot {
  const sub = relative(anchor, dir);
  return sub === ".." || sub.startsWith(`..${sep}`) || isAbsolute(sub) ? { anchor: dir, dir } : { anchor, dir };
}

function trustedRootOf(root: SkillRoot): string | null {
  try {
    return join(realpathSync(root.anchor), relative(root.anchor, root.dir));
  } catch {
    return null;
  }
}

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

function realpathOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function fileIdOf(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return stat.isFile() ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

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

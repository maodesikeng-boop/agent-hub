// 全厂商连接器 / MCP / Skill 并集同步核心引擎：
// 纯插件化调度（遍历 `AGENT_VENDORS` 与 `DAEMON_VENDORS[vendor].sync`），零硬编码单家厂商判断。
import { basename, dirname, join, relative } from "node:path";
import {
  AGENT_VENDORS,
  MAX_VENDOR_SYNC_CLOUD_ITEMS,
  MAX_VENDOR_SYNC_MCP_ITEMS,
  MAX_VENDOR_SYNC_PROJECT_FOLDERS,
  MAX_VENDOR_SYNC_SKILL_ITEMS,
  vendorSpec,
  type AgentVendor,
  type VendorSyncApplyRequest,
  type VendorSyncApplyResponse,
  type VendorSyncItemVendorStatus,
  type VendorSyncMcpPreviewItem,
  type VendorSyncNonSyncableItem,
  type VendorSyncPreviewResponse,
  type VendorSyncSkillPreviewItem,
  type VendorSyncVendorBadge,
} from "../../shared/index.ts";
import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import type { CanonicalMcpServer, VendorMcpScanResult, VendorSyncAdapter, VendorSyncContext } from "../../vendors/daemon-types.ts";
import { isVendorMcpUpToDate } from "../../vendors/_common/sync/mcp.ts";
import {
  inspectSkillTargetEntry,
  isManagedAgentsSkillSymlink,
  isWholeDirLinkedToCanonical,
  listCanonicalSkillNames,
  safeRealpath,
} from "../../vendors/_common/sync/skills.ts";
import {
  executeAtomicSyncTransaction,
  type PlannedFileWrite,
  type PlannedSymlinkOp,
  type WriteFileAtomicFn,
} from "./backup.ts";
import { buildMaskedMcpSummary } from "./mask.ts";

export interface SyncProjectFolderRef {
  path: string;
  projectName?: string;
}

export interface VendorSyncServiceOptions {
  userHome: string;
  env?: Readonly<Record<string, string | undefined>>;
  backupsDir: string;
  listProjectFolders?: () => readonly SyncProjectFolderRef[];
  now?: () => number;
  /** 仅供异常回滚单元测试注入的原子写钩子。 */
  writeFileAtomicHook?: WriteFileAtomicFn;
}

export interface VendorSyncService {
  preview(): VendorSyncPreviewResponse;
  apply(request: VendorSyncApplyRequest): VendorSyncApplyResponse;
}

interface ActiveVendorEntry {
  vendor: AgentVendor;
  label: string;
  adapter: VendorSyncAdapter;
}

interface CanonicalSkillLocation {
  key: string;
  name: string;
  scope: "global" | "project";
  projectDir?: string;
  projectLabel?: string;
  canonicalDir: string;
  sourcePath: string;
}

function getActiveSyncVendors(): ActiveVendorEntry[] {
  const out: ActiveVendorEntry[] = [];
  for (const vendor of AGENT_VENDORS) {
    const adapter = VENDOR_DAEMONS[vendor].sync;
    if (!adapter) continue;
    out.push({
      vendor,
      label: vendorSpec(vendor).label,
      adapter,
    });
  }
  return out;
}

/**
 * 合并各家同名 MCP 的可移植规格：
 * 若某家持有原生 `sse` URL，而另一家持有同一 URL 的 `npx -y mcp-remote <url>` 桥接，优先采用原生 `sse` 作为基准规格，
 * 使支持原生 SSE 的厂商保持原生配置，不支持的厂商自动走 `mcp-remote`。
 */
function pickCanonicalUnionMcp(candidates: readonly CanonicalMcpServer[]): CanonicalMcpServer {
  const nativeSse = candidates.find((c): c is Extract<CanonicalMcpServer, { transport: "sse" }> => c.transport === "sse");
  if (nativeSse) {
    const first = candidates[0]!;
    if (first.transport === "stdio" && first.bridgedSseUrl === nativeSse.url) {
      return nativeSse;
    }
    if (first.transport === "sse") {
      return first;
    }
  }
  return candidates[0]!;
}

function collectCanonicalSkills(
  userHome: string,
  projectFolders: readonly SyncProjectFolderRef[],
): { skills: CanonicalSkillLocation[]; truncated: boolean } {
  const skills: CanonicalSkillLocation[] = [];
  let truncated = false;

  const globalCanonicalDir = join(userHome, ".agents", "skills");
  const globalScan = listCanonicalSkillNames(globalCanonicalDir);
  if (globalScan.truncated) truncated = true;
  for (const name of globalScan.names) {
    if (skills.length >= MAX_VENDOR_SYNC_SKILL_ITEMS) {
      truncated = true;
      break;
    }
    skills.push({
      key: `global:${name}`,
      name,
      scope: "global",
      canonicalDir: globalCanonicalDir,
      sourcePath: join(globalCanonicalDir, name),
    });
  }

  const seenProjectRealpaths = new Set<string>();
  const globalHomeReal = safeRealpath(userHome);
  for (const folder of projectFolders.slice(0, MAX_VENDOR_SYNC_PROJECT_FOLDERS)) {
    const folderPath = folder.path.trim();
    if (!folderPath) continue;
    const realFolder = safeRealpath(folderPath);
    if (realFolder === globalHomeReal || seenProjectRealpaths.has(realFolder)) continue;
    seenProjectRealpaths.add(realFolder);

    const projectCanonicalDir = join(folderPath, ".agents", "skills");
    const projectScan = listCanonicalSkillNames(projectCanonicalDir);
    if (projectScan.truncated) truncated = true;
    const label = folder.projectName?.trim() || basename(folderPath);

    for (const name of projectScan.names) {
      if (skills.length >= MAX_VENDOR_SYNC_SKILL_ITEMS) {
        truncated = true;
        break;
      }
      skills.push({
        key: `project:${folderPath}:${name}`,
        name,
        scope: "project",
        projectDir: folderPath,
        projectLabel: label,
        canonicalDir: projectCanonicalDir,
        sourcePath: join(projectCanonicalDir, name),
      });
    }
  }

  return { skills, truncated };
}

export function createVendorSyncService(options: VendorSyncServiceOptions): VendorSyncService {
  const ctx: VendorSyncContext = {
    userHome: options.userHome,
    env: options.env ?? process.env,
  };
  const now = options.now ?? Date.now;
  const listFolders = options.listProjectFolders ?? (() => []);

  function scanAll() {
    const vendors = getActiveSyncVendors();
    const scans = new Map<AgentVendor, VendorMcpScanResult>();
    const allServerNames = new Set<string>();
    const nonSyncable: VendorSyncNonSyncableItem[] = [];
    let truncated = false;

    for (const { vendor, label, adapter } of vendors) {
      const scan = adapter.scanMcp(ctx);
      scans.set(vendor, scan);
      for (const name of Object.keys(scan.servers)) {
        allServerNames.add(name);
      }
      for (const cloud of scan.nonSyncable) {
        if (nonSyncable.length >= MAX_VENDOR_SYNC_CLOUD_ITEMS) {
          truncated = true;
          break;
        }
        nonSyncable.push({
          key: `${vendor}:${cloud.name}`,
          name: cloud.name,
          vendor,
          vendorLabel: label,
          kind: cloud.kind,
          reason: cloud.reason,
        });
      }
    }

    const sortedNames = [...allServerNames].sort();
    const unionMcpMap = new Map<string, CanonicalMcpServer>();
    for (const name of sortedNames) {
      if (unionMcpMap.size >= MAX_VENDOR_SYNC_MCP_ITEMS) {
        truncated = true;
        break;
      }
      const candidates: CanonicalMcpServer[] = [];
      for (const { vendor } of vendors) {
        const found = scans.get(vendor)?.servers[name];
        if (found) candidates.push(found);
      }
      if (candidates.length > 0) {
        unionMcpMap.set(name, pickCanonicalUnionMcp(candidates));
      }
    }

    const skillScan = collectCanonicalSkills(ctx.userHome, listFolders());
    if (skillScan.truncated) truncated = true;

    return {
      vendors,
      scans,
      unionMcpMap,
      nonSyncable,
      skills: skillScan.skills,
      truncated,
    };
  }

  return {
    preview(): VendorSyncPreviewResponse {
      const { vendors, scans, unionMcpMap, nonSyncable, skills, truncated } = scanAll();

      const mcpServers: VendorSyncMcpPreviewItem[] = [];
      for (const [name, canonical] of unionMcpMap.entries()) {
        const { maskedTarget, maskedAuth } = buildMaskedMcpSummary(canonical);
        let usesMcpRemoteBridge = false;
        const badges: VendorSyncVendorBadge[] = [];

        for (const { vendor, label, adapter } of vendors) {
          const scan = scans.get(vendor);
          const existing = scan?.servers[name];
          const occupiedByPrivate = scan?.nonSyncable.some((item) => item.name === name) ?? false;
          const needsBridge = canonical.transport === "sse" && !adapter.supportsSseMcp;
          if (needsBridge) usesMcpRemoteBridge = true;

          // 并集只增补：这家已有同名配置（内容不同、或是本家私有 OAuth 项）一律保留原样，不覆盖
          let status: VendorSyncItemVendorStatus;
          if (existing) {
            status = isVendorMcpUpToDate(existing, canonical, adapter.supportsSseMcp)
              ? needsBridge
                ? "mcp_remote"
                : "present"
              : "kept";
          } else if (occupiedByPrivate) {
            status = "kept";
          } else {
            status = needsBridge ? "mcp_remote" : "will_add";
          }
          badges.push({ vendor, label, status });
        }

        mcpServers.push({
          key: name,
          name,
          transport: canonical.transport,
          maskedTarget,
          maskedAuth,
          usesMcpRemoteBridge,
          vendors: badges,
        });
      }

      const skillItems: VendorSyncSkillPreviewItem[] = skills.map((loc) => {
        const badges: VendorSyncVendorBadge[] = vendors.map(({ vendor, label, adapter }) => {
          const scopeArg =
            loc.scope === "global"
              ? ({ kind: "global" } as const)
              : ({ kind: "project", projectDir: loc.projectDir! } as const);
          const target = adapter.skillTarget(ctx, scopeArg);
          if (target.mode === "native") {
            return { vendor, label, status: "native" };
          }
          const entryState = inspectSkillTargetEntry(target.targetDir, loc.canonicalDir, loc.name);
          const status: VendorSyncItemVendorStatus =
            entryState === "whole_dir_symlink" || entryState === "linked" || entryState === "managed_copy"
              ? "symlink"
              : entryState === "user_private_conflict"
                ? "conflict"
                : "will_link";
          return { vendor, label, status };
        });

        return {
          key: loc.key,
          name: loc.name,
          scope: loc.scope,
          ...(loc.projectLabel ? { projectLabel: loc.projectLabel } : {}),
          sourcePath: loc.sourcePath,
          vendors: badges,
        };
      });

      return {
        scannedAt: now(),
        mcpServers,
        skills: skillItems,
        nonSyncable,
        truncated,
      };
    },

    apply(request: VendorSyncApplyRequest): VendorSyncApplyResponse {
      const { vendors, scans, unionMcpMap, skills } = scanAll();

      const selectedMcpSet = new Set(request.selectedMcpKeys);
      // 只认这次扫描里真有的键：请求里伪造的名字不能借“移除”删掉各家别的配置
      const removeMcpSet = new Set(request.removeMcpKeys.filter((k) => !selectedMcpSet.has(k) && unionMcpMap.has(k)));

      const upsertMcp: Record<string, CanonicalMcpServer> = {};
      for (const key of selectedMcpSet) {
        const spec = unionMcpMap.get(key);
        if (spec) upsertMcp[key] = spec;
      }

      let removedMcpCount = 0;
      for (const name of removeMcpSet) {
        const existedAnywhere = vendors.some(({ vendor }) => Boolean(scans.get(vendor)?.servers[name]));
        if (existedAnywhere) removedMcpCount += 1;
      }

      const fileWrites: PlannedFileWrite[] = [];
      for (const { adapter } of vendors) {
        const plan = adapter.planMcpPatch(ctx, {
          upsert: upsertMcp,
          removeNames: removeMcpSet,
        });
        if (plan.nextContent !== null) {
          fileWrites.push({
            configPath: plan.configPath,
            nextContent: plan.nextContent,
            ...(plan.mode !== undefined ? { mode: plan.mode } : {}),
          });
        }
      }

      const skillByKey = new Map(skills.map((s) => [s.key, s]));
      const selectedSkillSet = new Set(request.selectedSkillKeys);
      const removeSkillSet = new Set(request.removeSkillKeys.filter((k) => !selectedSkillSet.has(k)));

      const symlinkOps: PlannedSymlinkOp[] = [];
      let linkedSkillCount = 0;
      let unlinkedSkillCount = 0;
      let preservedPrivateSkillCount = 0;

      for (const key of selectedSkillSet) {
        const loc = skillByKey.get(key);
        if (!loc) continue;
        for (const { adapter } of vendors) {
          const scopeArg =
            loc.scope === "global"
              ? ({ kind: "global" } as const)
              : ({ kind: "project", projectDir: loc.projectDir! } as const);
          const target = adapter.skillTarget(ctx, scopeArg);
          if (target.mode === "native") continue;

          const state = inspectSkillTargetEntry(target.targetDir, loc.canonicalDir, loc.name);
          if (state === "whole_dir_symlink" || state === "linked" || state === "managed_copy") continue;
          if (state === "user_private_conflict") {
            preservedPrivateSkillCount += 1;
            continue;
          }

          const linkPath = join(target.targetDir, loc.name);
          const targetValue =
            loc.scope === "project" ? relative(dirname(linkPath), loc.sourcePath) : loc.sourcePath;
          symlinkOps.push({ kind: "link", linkPath, targetValue });
          linkedSkillCount += 1;
        }
      }

      for (const key of removeSkillSet) {
        // 只认这次扫描里真有的技能键：请求里伪造的 `project:<任意目录>:<名字>` 不能借“移除”去动别处的软链
        const loc = skillByKey.get(key);
        if (!loc) continue;
        for (const { adapter } of vendors) {
          const scopeArg =
            loc.scope === "global"
              ? ({ kind: "global" } as const)
              : ({ kind: "project", projectDir: loc.projectDir! } as const);
          const target = adapter.skillTarget(ctx, scopeArg);
          if (target.mode === "native") continue;
          if (isWholeDirLinkedToCanonical(target.targetDir, loc.canonicalDir)) continue;

          const linkPath = join(target.targetDir, loc.name);
          if (isManagedAgentsSkillSymlink(linkPath, loc.canonicalDir)) {
            symlinkOps.push({ kind: "unlink", linkPath });
            unlinkedSkillCount += 1;
          }
        }
      }

      const tx = executeAtomicSyncTransaction({
        backupsDir: options.backupsDir,
        fileWrites,
        symlinkOps,
        nowMs: now(),
        ...(options.writeFileAtomicHook ? { writeFileAtomic: options.writeFileAtomicHook } : {}),
      });

      return {
        backupId: tx.backupId,
        syncedMcpCount: Object.keys(upsertMcp).length,
        removedMcpCount,
        linkedSkillCount,
        unlinkedSkillCount,
        preservedPrivateSkillCount,
        updatedFiles: tx.updatedFiles,
      };
    },
  };
}

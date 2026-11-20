import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { LRUCache } from "lru-cache";
import {
  PM_CAPABILITY_INVENTORY_MAX_ITEMS,
  PM_CAPABILITY_INVENTORY_RETRY_MS,
  PM_CAPABILITY_INVENTORY_TTL_MS,
} from "../../shared/limits.ts";
import {
  capabilityKey,
  type CapabilityGroup,
  type CapabilityInventory,
  type CapabilityItem,
  type CapabilityKind,
  type CapabilityKey,
  type CapabilitySource,
} from "../../shared/pm-capabilities.ts";
import { AGENT_VENDORS, vendorSpec, type AgentVendor } from "../../shared/vendors.ts";
import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import type { VendorCapabilityScan, VendorSyncAdapter, VendorSyncContext } from "../../vendors/daemon-types.ts";
import {
  inspectSkillTargetEntry,
  listCanonicalSkillNames,
  readSkillDescription,
  safeRealpath,
} from "../../vendors/_common/sync/skills.ts";

export interface CapabilityInventoryOptions {
  ctx: VendorSyncContext;
  now?: () => number;
  adapters?: Partial<Record<AgentVendor, VendorSyncAdapter>>;
}

export interface CapabilityInventoryService {
  get(scope: { projectDir: string | null }): Promise<CapabilityInventory>;
  invalidate(): void;
}

const INVENTORY_SCOPE_CACHE_MAX = 32;

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface CachedInventoryEntry {
  inventory: CapabilityInventory;
  cachedAt: number;
  ttlMs: number;
  stamp: string;
  watchPaths: readonly string[];
}

function singlePathStamp(target: string): string {
  try {
    const st = statSync(target);
    if (st.isDirectory()) {
      let count = 0;
      try {
        count = readdirSync(target).length;
      } catch {
        count = -1;
      }
      return `d:${st.mtimeMs}:${count}`;
    }
    return `f:${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

function computeStamp(paths: readonly string[]): string {
  return paths.map((p) => `${p}=${singlePathStamp(p)}`).join("|");
}

function groupIdFor(kind: CapabilityKind, source: CapabilitySource): string {
  switch (source.kind) {
    case "global":
      return `${kind}:global`;
    case "project":
      return `${kind}:project:${source.projectLabel}`;
    case "plugin":
      return `${kind}:plugin:${source.vendor}:${source.plugin}`;
    case "vendor_bundled":
      return `${kind}:bundled:${source.vendor}`;
    case "account":
      return `${kind}:account:${source.vendor}`;
  }
}

function groupLabelFor(source: CapabilitySource, pluginLabels: ReadonlyMap<string, string>): string {
  switch (source.kind) {
    case "global":
      return "Global";
    case "project":
      return source.projectLabel;
    case "plugin":
      return pluginLabels.get(`${source.vendor}:${source.plugin}`) ?? source.plugin;
    case "vendor_bundled":
      return `${vendorSpec(source.vendor).label} bundled`;
    case "account":
      return vendorSpec(source.vendor).label;
  }
}

interface MutableItem {
  key: CapabilityKey;
  kind: CapabilityKind;
  name: string;
  description: string | null;
  groupId: string;
  source: CapabilitySource;
  vendors: Set<AgentVendor>;
  dir?: string;
  skillDirs: Partial<Record<AgentVendor, string>>;
  plugins: Partial<Record<AgentVendor, string>>;
}

export function createCapabilityInventory(options: CapabilityInventoryOptions): CapabilityInventoryService {
  const { ctx } = options;
  const now = options.now ?? Date.now;
  const cache = new LRUCache<string, CachedInventoryEntry>({ max: INVENTORY_SCOPE_CACHE_MAX });
  const inflight = new Map<string, Promise<CapabilityInventory>>();
  let generation = 0;

  function resolveAdapters(): Array<{ vendor: AgentVendor; adapter: VendorSyncAdapter }> {
    const list: Array<{ vendor: AgentVendor; adapter: VendorSyncAdapter }> = [];
    for (const vendor of AGENT_VENDORS) {
      const adapter = options.adapters?.[vendor] ?? VENDOR_DAEMONS[vendor].sync;
      if (adapter) list.push({ vendor, adapter });
    }
    return list;
  }

  function collectWatchPaths(
    adapters: ReadonlyArray<{ vendor: AgentVendor; adapter: VendorSyncAdapter }>,
    projectDir: string | null,
  ): string[] {
    const set = new Set<string>();
    set.add(join(ctx.userHome, ".agents", "skills"));
    set.add(join(ctx.userHome, ".claude", "settings.json"));
    set.add(join(ctx.userHome, ".claude", "plugins", "installed_plugins.json"));
    set.add(join(ctx.userHome, ".claude", "plugins", "synced"));
    set.add(join(ctx.userHome, ".codex", "skills", ".system"));
    set.add(join(ctx.userHome, ".codex", "plugins", "cache"));
    const codexAppsToolsDir = join(ctx.userHome, ".codex", "cache", "codex_apps_tools");
    set.add(codexAppsToolsDir);
    try {
      for (const f of readdirSync(codexAppsToolsDir).filter((n) => n.endsWith(".json")).slice(0, 4)) {
        set.add(join(codexAppsToolsDir, f));
      }
    } catch {}

    for (const { adapter } of adapters) {
      try {
        const mcpRes = adapter.scanMcp(ctx);
        if (mcpRes.configPath) set.add(mcpRes.configPath);
      } catch {}
      const globalTarget = adapter.skillTarget(ctx, { kind: "global" });
      if (globalTarget.mode === "symlink") set.add(globalTarget.targetDir);
      if (projectDir !== null) {
        const projTarget = adapter.skillTarget(ctx, { kind: "project", projectDir });
        if (projTarget.mode === "symlink") set.add(projTarget.targetDir);
      }
    }
    if (projectDir !== null) {
      set.add(join(projectDir, ".agents", "skills"));
    }
    return [...set].sort(cmpStr);
  }

  async function buildInventory(projectDir: string | null): Promise<{
    inventory: CapabilityInventory;
    hadError: boolean;
    watchPaths: string[];
  }> {
    const adapters = resolveAdapters();
    const scannedAt = now();
    let hadError = false;
    let truncated = false;

    const itemsMap = new Map<CapabilityKey, MutableItem>();
    const pluginLabels = new Map<string, string>();

    const upsertItem = (input: {
      key: CapabilityKey;
      kind: CapabilityKind;
      name: string;
      description: string | null;
      source: CapabilitySource;
      vendor: AgentVendor;
      dir?: string;
    }) => {
      const pluginId =
        input.source.kind === "plugin" && input.source.vendor === input.vendor ? input.source.plugin : undefined;
      let existing = itemsMap.get(input.key);
      if (!existing) {
        const groupId = groupIdFor(input.kind, input.source);
        existing = {
          key: input.key,
          kind: input.kind,
          name: input.name,
          description: input.description,
          groupId,
          source: input.source,
          vendors: new Set([input.vendor]),
          ...(input.dir !== undefined ? { dir: input.dir } : {}),
          skillDirs: input.dir !== undefined ? { [input.vendor]: input.dir } : {},
          plugins: pluginId !== undefined ? { [input.vendor]: pluginId } : {},
        };
        itemsMap.set(input.key, existing);
      } else {
        existing.vendors.add(input.vendor);
        if (existing.description === null && input.description !== null) {
          existing.description = input.description;
        }
        if (input.dir !== undefined) {
          existing.dir ??= input.dir;
          existing.skillDirs[input.vendor] ??= input.dir;
        }
        if (pluginId !== undefined) existing.plugins[input.vendor] ??= pluginId;
      }
    };

    const scanSkillsScope = (
      canonicalDir: string,
      scopeArg: { kind: "global" } | { kind: "project"; projectDir: string },
      source: CapabilitySource,
    ) => {
      const canonicalScan = listCanonicalSkillNames(canonicalDir);
      if (canonicalScan.truncated) truncated = true;
      for (const name of canonicalScan.names) {
        const skillDir = join(canonicalDir, name);
        const desc = readSkillDescription(skillDir);
        const key = capabilityKey("skill", name);
        for (const { vendor, adapter } of adapters) {
          const target = adapter.skillTarget(ctx, scopeArg);
          if (target.mode === "native") {
            upsertItem({ key, kind: "skill", name, description: desc, source, vendor, dir: skillDir });
          } else {
            const state = inspectSkillTargetEntry(target.targetDir, canonicalDir, name);
            if (state === "whole_dir_symlink" || state === "linked" || state === "managed_copy") {
              upsertItem({
                key,
                kind: "skill",
                name,
                description: desc,
                source,
                vendor,
                dir: join(target.targetDir, name),
              });
            }
          }
        }
      }

      for (const { vendor, adapter } of adapters) {
        const target = adapter.skillTarget(ctx, scopeArg);
        if (target.mode !== "symlink" || !existsSync(target.targetDir)) continue;
        const privateScan = listCanonicalSkillNames(target.targetDir);
        if (privateScan.truncated) truncated = true;
        for (const name of privateScan.names) {
          const key = capabilityKey("skill", name);
          const dir = join(target.targetDir, name);
          const desc = readSkillDescription(dir);
          upsertItem({ key, kind: "skill", name, description: desc, source, vendor, dir });
        }
      }
    };

    scanSkillsScope(join(ctx.userHome, ".agents", "skills"), { kind: "global" }, { kind: "global" });
    if (projectDir !== null && projectDir.trim() !== "") {
      const realProj = safeRealpath(projectDir);
      if (realProj !== safeRealpath(ctx.userHome)) {
        const projectLabel = basename(projectDir.replace(/[/\\]+$/, "")) || projectDir;
        scanSkillsScope(
          join(projectDir, ".agents", "skills"),
          { kind: "project", projectDir },
          { kind: "project", projectLabel },
        );
      }
    }

    for (const { vendor, adapter } of adapters) {
      try {
        const mcpRes = adapter.scanMcp(ctx);
        for (const serverName of Object.keys(mcpRes.servers)) {
          upsertItem({
            key: capabilityKey("mcp", serverName),
            kind: "mcp",
            name: serverName,
            description: null,
            source: { kind: "global" },
            vendor,
          });
        }
      } catch {
        hadError = true;
      }
    }

    const extraScans = await Promise.allSettled(
      adapters.map(async ({ vendor, adapter }) => {
        if (!adapter.scanCapabilities) return { vendor, scan: null as VendorCapabilityScan | null };
        const scan = await adapter.scanCapabilities(ctx, { projectDir });
        return { vendor, scan };
      }),
    );

    for (const res of extraScans) {
      if (res.status === "rejected") {
        hadError = true;
        continue;
      }
      const { vendor, scan } = res.value;
      if (!scan) continue;
      for (const p of scan.plugins) {
        pluginLabels.set(`${vendor}:${p.id}`, p.label);
      }
      for (const s of scan.skills) {
        upsertItem({
          key: capabilityKey("skill", s.name),
          kind: "skill",
          name: s.name,
          description: s.description,
          source: s.source,
          vendor,
          dir: s.dir,
        });
      }
      for (const m of scan.mcp) {
        upsertItem({
          key: capabilityKey("mcp", m.name),
          kind: "mcp",
          name: m.name,
          description: null,
          source: m.source,
          vendor,
        });
      }
      for (const c of scan.connectors) {
        upsertItem({
          key: capabilityKey("connector", c.id, vendor),
          kind: "connector",
          name: c.name,
          description: null,
          source: { kind: "account", vendor },
          vendor,
        });
      }
    }

    const orderedKeys = [...itemsMap.keys()].sort(cmpStr);
    if (orderedKeys.length > PM_CAPABILITY_INVENTORY_MAX_ITEMS) {
      truncated = true;
    }
    const keptKeys = orderedKeys.slice(0, PM_CAPABILITY_INVENTORY_MAX_ITEMS);
    const items: CapabilityItem[] = [];
    const groupsById = new Map<
      string,
      { id: string; kind: CapabilityKind; label: string; source: CapabilitySource; itemKeys: CapabilityKey[] }
    >();

    for (const key of keptKeys) {
      const m = itemsMap.get(key)!;
      const sortedVendors = AGENT_VENDORS.filter((v) => m.vendors.has(v));
      const hasMultiDirs = Object.keys(m.skillDirs).length > 1;
      items.push({
        key: m.key,
        kind: m.kind,
        name: m.name,
        description: m.description,
        groupId: m.groupId,
        vendors: sortedVendors,
        ...(m.dir !== undefined ? { dir: m.dir } : {}),
        ...(hasMultiDirs ? { skillDirs: m.skillDirs } : {}),
        ...(Object.keys(m.plugins).length > 0 ? { plugins: m.plugins } : {}),
      });
      let group = groupsById.get(m.groupId);
      if (!group) {
        group = {
          id: m.groupId,
          kind: m.kind,
          label: groupLabelFor(m.source, pluginLabels),
          source: m.source,
          itemKeys: [],
        };
        groupsById.set(m.groupId, group);
      }
      group.itemKeys.push(m.key);
    }

    const groups: CapabilityGroup[] = [...groupsById.values()].sort((a, b) => cmpStr(a.id, b.id));
    const watchPaths = collectWatchPaths(adapters, projectDir);
    return {
      inventory: {
        scannedAt,
        items,
        groups,
        truncated,
      },
      hadError,
      watchPaths,
    };
  }

  return {
    async get(scope) {
      const normalizedProject =
        scope.projectDir !== null && scope.projectDir.trim() !== "" ? safeRealpath(scope.projectDir.trim()) : null;
      const cacheKey = normalizedProject ?? "";
      const currentNow = now();
      const cached = cache.get(cacheKey);
      if (cached !== undefined && currentNow - cached.cachedAt < cached.ttlMs) {
        const latestStamp = computeStamp(cached.watchPaths);
        if (latestStamp === cached.stamp) {
          return cached.inventory;
        }
      }

      const existingPromise = inflight.get(cacheKey);
      if (existingPromise !== undefined) return existingPromise;

      const genAtStart = generation;
      const promise = (async () => {
        try {
          const { inventory, hadError, watchPaths } = await buildInventory(scope.projectDir);
          if (generation === genAtStart) {
            cache.set(cacheKey, {
              inventory,
              cachedAt: now(),
              ttlMs: hadError ? PM_CAPABILITY_INVENTORY_RETRY_MS : PM_CAPABILITY_INVENTORY_TTL_MS,
              stamp: computeStamp(watchPaths),
              watchPaths,
            });
          }
          return inventory;
        } finally {
          inflight.delete(cacheKey);
        }
      })();
      inflight.set(cacheKey, promise);
      return promise;
    },

    invalidate() {
      generation++;
      cache.clear();
    },
  };
}

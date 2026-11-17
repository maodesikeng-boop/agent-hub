// Claude Code 同步适配器：
// - 全局 MCP：`~/.claude.json` 的 `mcpServers`（JSONC 局部补丁，完整保留注释、账号 oauthAccount 与私有云端连接器）；
// - 云端/OAuth 连接器识别：`claudeAiMcp`、`claudeAiMcpServers`、`cachedClaudeAiMcpServers`、`claudeAiConnectors`、`mcpOAuth` 及带 `oauth` 的 `mcpServers`；
// - Skill：全局 `~/.claude/skills/<name>`、项目 `<project>/.claude/skills/<name>` 逐项建软链（兼容整目录软链）。
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ScannedCloudConnector, VendorCapabilityScan, VendorSyncAdapter, VendorSyncContext } from "../daemon-types.ts";
import { isPlainObject, patchJsoncMapEntries, readJsoncObjectFile } from "../_common/sync/jsonc.ts";
import {
  CLOUD_CONNECTOR_NON_SYNCABLE_REASON,
  OAUTH_NON_SYNCABLE_REASON,
  collectProtectedJsonMcpNames,
  parseCommonJsonMcpEntry,
  serializeCommonJsonMcpEntry,
} from "../_common/sync/mcp.ts";
import { listCanonicalSkillNames, readSkillDescription } from "../_common/sync/skills.ts";
import claudeSpec from "./spec.ts";

const CLAUDE_CLOUD_CONNECTOR_KEYS = [
  "claudeAiMcp",
  "claudeAiMcpServers",
  "cachedClaudeAiMcpServers",
  "claudeAiMcpEverConnected",
  "claudeAiConnectors",
  "connectors",
] as const;

function resolveClaudeConfigDir(ctx: VendorSyncContext): string {
  const override = claudeSpec.home.configHome;
  const fromEnv = override ? ctx.env[override.env]?.trim() : "";
  return fromEnv ? fromEnv : join(ctx.userHome, ".claude");
}

export function resolveClaudeMcpConfigPath(ctx: VendorSyncContext): string {
  const envDir = ctx.env.CLAUDE_CONFIG_DIR?.trim();
  if (envDir) {
    const inEnvDir = join(envDir, ".claude.json");
    if (existsSync(inEnvDir) || !existsSync(join(ctx.userHome, ".claude.json"))) {
      return inEnvDir;
    }
  }
  return join(ctx.userHome, ".claude.json");
}

function normalizeOAuthConnectorKey(rawKey: string): string {
  const pipe = rawKey.indexOf("|");
  return (pipe > 0 ? rawKey.slice(0, pipe) : rawKey).trim();
}

function collectClaudeCloudConnectors(
  root: Record<string, unknown>,
  alreadySeen: Set<string>,
): ScannedCloudConnector[] {
  const out: ScannedCloudConnector[] = [];

  for (const key of CLAUDE_CLOUD_CONNECTOR_KEYS) {
    const section = root[key];
    if (isPlainObject(section)) {
      for (const [rawName, val] of Object.entries(section)) {
        if (isPlainObject(val) && val.enabled === false) continue;
        const name = rawName.trim();
        if (!name || alreadySeen.has(name)) continue;
        alreadySeen.add(name);
        out.push({
          name,
          kind: "cloud_connector",
          reason: CLOUD_CONNECTOR_NON_SYNCABLE_REASON,
        });
      }
    } else if (Array.isArray(section)) {
      for (const item of section) {
        let name = "";
        if (typeof item === "string") {
          name = item.trim();
        } else if (isPlainObject(item)) {
          if (item.enabled === false) continue;
          name = typeof item.name === "string" ? item.name.trim() : typeof item.id === "string" ? item.id.trim() : "";
        }
        if (!name || alreadySeen.has(name)) continue;
        alreadySeen.add(name);
        out.push({
          name,
          kind: "cloud_connector",
          reason: CLOUD_CONNECTOR_NON_SYNCABLE_REASON,
        });
      }
    }
  }

  if (isPlainObject(root.mcpOAuth)) {
    for (const [rawKey, val] of Object.entries(root.mcpOAuth)) {
      if (!isPlainObject(val)) continue;
      const name = normalizeOAuthConnectorKey(rawKey);
      if (!name || alreadySeen.has(name)) continue;
      alreadySeen.add(name);
      out.push({
        name,
        kind: "oauth_mcp",
        reason: OAUTH_NON_SYNCABLE_REASON,
      });
    }
  }

  return out;
}

function collectClaudePluginDir(
  pluginRoot: string,
  pluginId: string,
  pluginLabel: string,
  out: VendorCapabilityScan,
): void {
  out.plugins.push({ id: pluginId, label: pluginLabel });
  const source = { kind: "plugin" as const, vendor: "claude" as const, plugin: pluginId };

  const skillsRoot = join(pluginRoot, "skills");
  for (const sName of listCanonicalSkillNames(skillsRoot).names) {
    const dir = join(skillsRoot, sName);
    out.skills.push({
      name: `${pluginLabel}:${sName}`,
      dir,
      description: readSkillDescription(dir),
      source,
    });
  }

  const mcpNames = new Set<string>();
  const mcpJson = readJsoncObjectFile(join(pluginRoot, ".mcp.json"));
  if (mcpJson.exists) {
    const table = isPlainObject(mcpJson.data.mcpServers) ? mcpJson.data.mcpServers : mcpJson.data;
    for (const k of Object.keys(table)) {
      if (k.trim() !== "") mcpNames.add(k.trim());
    }
  }
  const pluginJson = readJsoncObjectFile(join(pluginRoot, ".claude-plugin", "plugin.json"));
  if (pluginJson.exists && isPlainObject(pluginJson.data.mcpServers)) {
    for (const k of Object.keys(pluginJson.data.mcpServers)) {
      if (k.trim() !== "") mcpNames.add(k.trim());
    }
  }
  for (const mName of [...mcpNames].sort()) {
    out.mcp.push({ name: `plugin:${pluginLabel}:${mName}`, source });
  }
}

function scanClaudePlugins(configDir: string, out: VendorCapabilityScan): void {
  const settingsDoc = readJsoncObjectFile(join(configDir, "settings.json"));
  const enabledPlugins = isPlainObject(settingsDoc.data.enabledPlugins) ? settingsDoc.data.enabledPlugins : {};
  const seenPluginIds = new Set<string>();

  const installedDoc = readJsoncObjectFile(join(configDir, "plugins", "installed_plugins.json"));
  if (installedDoc.exists && isPlainObject(installedDoc.data.plugins)) {
    for (const [pluginId, rawEntries] of Object.entries(installedDoc.data.plugins)) {
      if (enabledPlugins[pluginId] === false || seenPluginIds.has(pluginId)) continue;
      const first = Array.isArray(rawEntries) && isPlainObject(rawEntries[0]) ? rawEntries[0] : null;
      const installPath = typeof first?.installPath === "string" ? first.installPath.trim() : "";
      if (!installPath || !existsSync(installPath)) continue;
      const pj = readJsoncObjectFile(join(installPath, ".claude-plugin", "plugin.json"));
      const label =
        typeof pj.data.name === "string" && pj.data.name.trim() !== ""
          ? pj.data.name.trim()
          : (pluginId.split("@")[0] ?? pluginId);
      seenPluginIds.add(pluginId);
      collectClaudePluginDir(installPath, pluginId, label, out);
    }
  }

  const syncedRoot = join(configDir, "plugins", "synced");
  let accountDirs: string[] = [];
  try {
    accountDirs = readdirSync(syncedRoot).sort();
  } catch {
    accountDirs = [];
  }
  for (const acc of accountDirs) {
    if (acc.startsWith(".")) continue;
    const accPath = join(syncedRoot, acc);
    try {
      if (!statSync(accPath).isDirectory()) continue;
    } catch {
      continue;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(accPath).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry.endsWith(".json")) continue;
      const pluginRoot = join(accPath, entry);
      try {
        if (!statSync(pluginRoot).isDirectory()) continue;
      } catch {
        continue;
      }
      const pj = readJsoncObjectFile(join(pluginRoot, ".claude-plugin", "plugin.json"));
      const label = typeof pj.data.name === "string" && pj.data.name.trim() !== "" ? pj.data.name.trim() : entry;
      const pluginId = `${label}@synced`;
      if (enabledPlugins[pluginId] === false || seenPluginIds.has(pluginId)) continue;
      seenPluginIds.add(pluginId);
      collectClaudePluginDir(pluginRoot, pluginId, label, out);
    }
  }
}

export const claudeSyncAdapter: VendorSyncAdapter = {
  supportsSseMcp: true,

  scanMcp(ctx) {
    const configPath = resolveClaudeMcpConfigPath(ctx);
    const doc = readJsoncObjectFile(configPath);
    const servers: ReturnType<VendorSyncAdapter["scanMcp"]>["servers"] = {};
    const nonSyncable: ScannedCloudConnector[] = [];
    const seenNonSyncable = new Set<string>();

    if (isPlainObject(doc.data.mcpServers)) {
      for (const [name, rawEntry] of Object.entries(doc.data.mcpServers)) {
        const parsed = parseCommonJsonMcpEntry(name, rawEntry);
        if (parsed.nonSyncable) {
          seenNonSyncable.add(name);
          nonSyncable.push(parsed.nonSyncable);
        } else if (parsed.server) {
          servers[name] = parsed.server;
        }
      }
    }

    nonSyncable.push(...collectClaudeCloudConnectors(doc.data, seenNonSyncable));
    return { configPath, servers, nonSyncable };
  },

  planMcpPatch(ctx, { upsert, removeNames, isProtectedServer }) {
    const configPath = resolveClaudeMcpConfigPath(ctx);
    const doc = readJsoncObjectFile(configPath);
    const existingMcp = isPlainObject(doc.data.mcpServers) ? doc.data.mcpServers : {};
    const { skipUpsert, skipRemove } = collectProtectedJsonMcpNames(existingMcp, isProtectedServer);

    const serializedUpsert: Record<string, Record<string, unknown>> = {};
    for (const [name, spec] of Object.entries(upsert)) {
      if (skipUpsert.has(name)) continue;
      serializedUpsert[name] = serializeCommonJsonMcpEntry(spec, {
        supportsSseMcp: true,
        explicitType: true,
      });
    }

    const safeRemove = new Set<string>();
    for (const name of removeNames) {
      if (!skipRemove.has(name)) safeRemove.add(name);
    }

    const nextContent = patchJsoncMapEntries({
      doc,
      mapKey: "mcpServers",
      upsert: serializedUpsert,
      removeNames: safeRemove,
    });
    return { configPath, nextContent, mode: 0o600 };
  },

  skillTarget(ctx, scope) {
    if (scope.kind === "global") {
      return { mode: "symlink", targetDir: join(resolveClaudeConfigDir(ctx), "skills") };
    }
    return { mode: "symlink", targetDir: join(scope.projectDir, ".claude", "skills") };
  },

  async scanCapabilities(ctx) {
    const out: VendorCapabilityScan = { skills: [], mcp: [], connectors: [], plugins: [] };
    const mcpScan = claudeSyncAdapter.scanMcp(ctx);
    for (const conn of mcpScan.nonSyncable) {
      const display = conn.name.startsWith("claude.ai ") ? conn.name.slice("claude.ai ".length) : conn.name;
      out.connectors.push({ id: conn.name, name: display });
    }
    scanClaudePlugins(resolveClaudeConfigDir(ctx), out);
    return out;
  },
};

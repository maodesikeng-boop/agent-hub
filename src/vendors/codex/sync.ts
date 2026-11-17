// OpenAI Codex 同步适配器：
// - 全局 MCP：`$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）的 `[mcp_servers.<name>]`，
//   用 `@decimalturn/toml-patch` 局部更新保留注释、`model`、`[features]`、`[projects]`；
// - 旧版 `/sse` 远程 MCP 自动转 `npx -y mcp-remote <url>`；
// - 原厂云端连接器：`[apps.<name>]` 与 `[features].codex_apps` 识别为不可跨厂同步说明项；
// - Skill：全局 `~/.agents/skills` 与项目 `.agents/skills` 均原生读取零冗余。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  CanonicalMcpServer,
  ScannedCloudConnector,
  VendorCapabilityScan,
  VendorSyncAdapter,
  VendorSyncContext,
} from "../daemon-types.ts";
import { isPlainObject, readJsoncObjectFile } from "../_common/sync/jsonc.ts";
import { PM_CAPABILITY_APPS_CACHE_MAX_BYTES } from "../../shared/limits.ts";
import {
  CLOUD_CONNECTOR_NON_SYNCABLE_REASON,
  OAUTH_NON_SYNCABLE_REASON,
  cleanStringArray,
  cleanStringMap,
  isLegacySseEndpointUrl,
  materializeMcpForVendor,
  unwrapMcpRemoteBridge,
} from "../_common/sync/mcp.ts";
import { listCanonicalSkillNames, readSkillDescription } from "../_common/sync/skills.ts";
import { patchTomlMapEntries, readTomlObjectFile } from "../_common/sync/toml.ts";
import codexSpec from "./spec.ts";

function resolveCodexHome(ctx: VendorSyncContext): string {
  const override = codexSpec.home.configHome;
  const fromEnv = override ? ctx.env[override.env]?.trim() : "";
  return fromEnv ? fromEnv : join(ctx.userHome, ".codex");
}

export function resolveCodexConfigPath(ctx: VendorSyncContext): string {
  return join(resolveCodexHome(ctx), "config.toml");
}

function parseCodexMcpEntry(
  name: string,
  rawEntry: unknown,
  options?: { includeDisabled?: boolean },
): { server?: CanonicalMcpServer; nonSyncable?: ScannedCloudConnector } {
  if (!isPlainObject(rawEntry)) return {};
  if (!options?.includeDisabled && rawEntry.enabled === false) return {};
  if (isPlainObject(rawEntry.oauth)) {
    return {
      nonSyncable: {
        name,
        kind: "oauth_mcp",
        reason: OAUTH_NON_SYNCABLE_REASON,
      },
    };
  }

  const command = typeof rawEntry.command === "string" ? rawEntry.command.trim() : "";
  if (command !== "") {
    const args = cleanStringArray(rawEntry.args);
    const env = cleanStringMap(rawEntry.env);
    const unwrapped = Object.keys(env).length === 0 ? unwrapMcpRemoteBridge(command, args) : null;
    return {
      server: {
        transport: "stdio",
        command,
        args,
        env,
        ...(unwrapped ? { bridgedSseUrl: unwrapped.url } : {}),
      },
    };
  }

  const url = typeof rawEntry.url === "string" ? rawEntry.url.trim() : "";
  if (url !== "") {
    const headers = {
      ...cleanStringMap(rawEntry.headers),
      ...cleanStringMap(rawEntry.http_headers),
    };
    const bearerTokenEnvVar =
      typeof rawEntry.bearer_token_env_var === "string" && rawEntry.bearer_token_env_var.trim() !== ""
        ? rawEntry.bearer_token_env_var.trim()
        : undefined;
    return {
      server: {
        transport: isLegacySseEndpointUrl(url) ? "sse" : "http",
        url,
        headers,
        ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
      },
    };
  }

  return {};
}

function serializeCodexMcpEntry(server: CanonicalMcpServer): Record<string, unknown> {
  const materialized = materializeMcpForVendor(server, false);
  if (materialized.transport === "stdio") {
    return {
      command: materialized.command,
      args: [...materialized.args],
      ...(Object.keys(materialized.env).length > 0 ? { env: { ...materialized.env } } : {}),
    };
  }
  return {
    url: materialized.url,
    ...(Object.keys(materialized.headers).length > 0 ? { http_headers: { ...materialized.headers } } : {}),
    ...(materialized.transport === "http" && materialized.bearerTokenEnvVar
      ? { bearer_token_env_var: materialized.bearerTokenEnvVar }
      : {}),
  };
}

function collectCodexAppsConnectors(root: Record<string, unknown>): ScannedCloudConnector[] {
  const out: ScannedCloudConnector[] = [];
  const seen = new Set<string>();

  if (isPlainObject(root.apps)) {
    for (const [appName, val] of Object.entries(root.apps)) {
      if (appName === "_default") continue;
      if (isPlainObject(val) && val.enabled === false) continue;
      seen.add(appName);
      out.push({
        name: appName,
        kind: "cloud_connector",
        reason: CLOUD_CONNECTOR_NON_SYNCABLE_REASON,
      });
    }
  }

  if (
    out.length === 0 &&
    isPlainObject(root.features) &&
    (root.features.codex_apps === true || root.features.apps === true)
  ) {
    out.push({
      name: "codex_apps",
      kind: "cloud_connector",
      reason: CLOUD_CONNECTOR_NON_SYNCABLE_REASON,
    });
  }

  return out;
}

function latestSubdir(parentDir: string): string | null {
  try {
    const subs = readdirSync(parentDir)
      .filter((n) => !n.startsWith("."))
      .filter((n) => {
        try {
          return statSync(join(parentDir, n)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
    return subs.length > 0 ? join(parentDir, subs[subs.length - 1]!) : null;
  } catch {
    return null;
  }
}

function scanCodexPlugins(codexHome: string, configData: Record<string, unknown>, out: VendorCapabilityScan): void {
  const pluginsTable = isPlainObject(configData.plugins) ? configData.plugins : {};
  for (const [pluginId, rawCfg] of Object.entries(pluginsTable)) {
    if (isPlainObject(rawCfg) && rawCfg.enabled === false) continue;
    const at = pluginId.indexOf("@");
    if (at <= 0 || at + 1 >= pluginId.length) continue;
    const pluginName = pluginId.slice(0, at);
    const marketplace = pluginId.slice(at + 1);
    const pluginBase = join(codexHome, "plugins", "cache", marketplace, pluginName);
    const versionDir = existsSync(join(pluginBase, "skills")) ? pluginBase : latestSubdir(pluginBase);
    if (!versionDir) continue;

    out.plugins.push({ id: pluginId, label: pluginName });
    const source = { kind: "plugin" as const, vendor: "codex" as const, plugin: pluginId };
    const skillsRoot = join(versionDir, "skills");
    for (const sName of listCanonicalSkillNames(skillsRoot).names) {
      const dir = join(skillsRoot, sName);
      out.skills.push({
        name: `${pluginName}:${sName}`,
        dir,
        description: readSkillDescription(dir),
        source,
      });
    }
    const mcpDoc = readJsoncObjectFile(join(versionDir, ".mcp.json"));
    if (mcpDoc.exists) {
      const table = isPlainObject(mcpDoc.data.mcpServers) ? mcpDoc.data.mcpServers : mcpDoc.data;
      for (const mName of Object.keys(table).sort()) {
        if (mName.trim() !== "") out.mcp.push({ name: mName.trim(), source });
      }
    }
  }
}

function scanCodexConnectors(codexHome: string, configData: Record<string, unknown>, out: VendorCapabilityScan): void {
  const seen = new Set<string>();
  const appsToolsDir = join(codexHome, "cache", "codex_apps_tools");
  try {
    const files = readdirSync(appsToolsDir)
      .filter((f) => f.endsWith(".json"))
      .sort((a, b) => {
        try {
          return statSync(join(appsToolsDir, b)).mtimeMs - statSync(join(appsToolsDir, a)).mtimeMs;
        } catch {
          return 0;
        }
      });
    for (const f of files.slice(0, 1)) {
      const fullPath = join(appsToolsDir, f);
      const st = statSync(fullPath);
      if (!st.isFile() || st.size > PM_CAPABILITY_APPS_CACHE_MAX_BYTES) continue;
      const parsed: unknown = JSON.parse(readFileSync(fullPath, "utf8"));
      const tools = isPlainObject(parsed) && Array.isArray(parsed.tools) ? parsed.tools : [];
      for (const tool of tools) {
        if (!isPlainObject(tool)) continue;
        const id = typeof tool.connector_id === "string" ? tool.connector_id.trim() : "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const name =
          typeof tool.connector_name === "string" && tool.connector_name.trim() !== ""
            ? tool.connector_name.trim()
            : id;
        out.connectors.push({ id, name });
      }
    }
  } catch {}

  if (isPlainObject(configData.apps)) {
    for (const [appId, val] of Object.entries(configData.apps)) {
      if (appId === "_default" || seen.has(appId)) continue;
      if (isPlainObject(val) && val.enabled === false) continue;
      seen.add(appId);
      out.connectors.push({ id: appId, name: appId });
    }
  }
}

export const codexSyncAdapter: VendorSyncAdapter = {
  supportsSseMcp: false,

  scanMcp(ctx) {
    const configPath = resolveCodexConfigPath(ctx);
    const doc = readTomlObjectFile(configPath);
    const servers: Record<string, CanonicalMcpServer> = {};
    const nonSyncable: ScannedCloudConnector[] = [];

    if (isPlainObject(doc.data.mcp_servers)) {
      for (const [name, rawEntry] of Object.entries(doc.data.mcp_servers)) {
        const parsed = parseCodexMcpEntry(name, rawEntry);
        if (parsed.nonSyncable) {
          nonSyncable.push(parsed.nonSyncable);
        } else if (parsed.server) {
          servers[name] = parsed.server;
        }
      }
    }

    nonSyncable.push(...collectCodexAppsConnectors(doc.data));
    return { configPath, servers, nonSyncable };
  },

  planMcpPatch(ctx, { upsert, removeNames, isProtectedServer }) {
    const configPath = resolveCodexConfigPath(ctx);
    const doc = readTomlObjectFile(configPath);
    const existingMcp = isPlainObject(doc.data.mcp_servers) ? doc.data.mcp_servers : {};
    const skipUpsert = new Set<string>();
    const skipRemove = new Set<string>();
    for (const [name, rawEntry] of Object.entries(existingMcp)) {
      const parsed = parseCodexMcpEntry(name, rawEntry, { includeDisabled: true });
      if (parsed.nonSyncable) {
        skipUpsert.add(name);
        skipRemove.add(name);
      } else if (parsed.server && isProtectedServer?.(parsed.server)) {
        skipRemove.add(name);
      }
    }

    const serializedUpsert: Record<string, Record<string, unknown>> = {};
    for (const [name, spec] of Object.entries(upsert)) {
      if (skipUpsert.has(name)) continue;
      serializedUpsert[name] = serializeCodexMcpEntry(spec);
    }

    const safeRemove = new Set<string>();
    for (const name of removeNames) {
      if (!skipRemove.has(name)) safeRemove.add(name);
    }

    const nextContent = patchTomlMapEntries({
      doc,
      tableKey: "mcp_servers",
      upsert: serializedUpsert,
      removeNames: safeRemove,
    });
    return { configPath, nextContent, mode: 0o600 };
  },

  skillTarget() {
    return { mode: "native" };
  },

  async scanCapabilities(ctx) {
    const out: VendorCapabilityScan = { skills: [], mcp: [], connectors: [], plugins: [] };
    const codexHome = resolveCodexHome(ctx);
    const systemSkillsDir = join(codexHome, "skills", ".system");
    for (const sName of listCanonicalSkillNames(systemSkillsDir).names) {
      const dir = join(systemSkillsDir, sName);
      out.skills.push({
        name: sName,
        dir,
        description: readSkillDescription(dir),
        source: { kind: "vendor_bundled", vendor: "codex" },
      });
    }
    const doc = readTomlObjectFile(resolveCodexConfigPath(ctx));
    scanCodexPlugins(codexHome, doc.data, out);
    scanCodexConnectors(codexHome, doc.data, out);
    return out;
  },
};

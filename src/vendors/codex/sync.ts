// OpenAI Codex 同步适配器：
// - 全局 MCP：`$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）的 `[mcp_servers.<name>]`，
//   用 `@decimalturn/toml-patch` 局部更新保留注释、`model`、`[features]`、`[projects]`；
// - 旧版 `/sse` 远程 MCP 自动转 `npx -y mcp-remote <url>`；
// - 原厂云端连接器：`[apps.<name>]` 与 `[features].codex_apps` 识别为不可跨厂同步说明项；
// - Skill：全局 `~/.agents/skills` 与项目 `.agents/skills` 均原生读取零冗余。
import { join } from "node:path";
import type { CanonicalMcpServer, ScannedCloudConnector, VendorSyncAdapter, VendorSyncContext } from "../daemon-types.ts";
import { isPlainObject } from "../_common/sync/jsonc.ts";
import {
  CLOUD_CONNECTOR_NON_SYNCABLE_REASON,
  OAUTH_NON_SYNCABLE_REASON,
  cleanStringArray,
  cleanStringMap,
  isLegacySseEndpointUrl,
  materializeMcpForVendor,
  unwrapMcpRemoteBridge,
} from "../_common/sync/mcp.ts";
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
): { server?: CanonicalMcpServer; nonSyncable?: ScannedCloudConnector } {
  if (!isPlainObject(rawEntry)) return {};
  if (rawEntry.enabled === false) return {};
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

  planMcpPatch(ctx, { upsert, removeNames }) {
    const configPath = resolveCodexConfigPath(ctx);
    const doc = readTomlObjectFile(configPath);
    const existingMcp = isPlainObject(doc.data.mcp_servers) ? doc.data.mcp_servers : {};
    const protectedNames = new Set<string>();
    for (const [name, rawEntry] of Object.entries(existingMcp)) {
      if (parseCodexMcpEntry(name, rawEntry).nonSyncable) protectedNames.add(name);
    }

    const serializedUpsert: Record<string, Record<string, unknown>> = {};
    for (const [name, spec] of Object.entries(upsert)) {
      if (protectedNames.has(name)) continue;
      serializedUpsert[name] = serializeCodexMcpEntry(spec);
    }

    const safeRemove = new Set<string>();
    for (const name of removeNames) {
      if (!protectedNames.has(name)) safeRemove.add(name);
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
};

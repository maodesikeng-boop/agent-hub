// Claude Code 同步适配器：
// - 全局 MCP：`~/.claude.json` 的 `mcpServers`（JSONC 局部补丁，完整保留注释、账号 oauthAccount 与私有云端连接器）；
// - 云端/OAuth 连接器识别：`claudeAiMcp`、`claudeAiMcpServers`、`cachedClaudeAiMcpServers`、`claudeAiConnectors`、`mcpOAuth` 及带 `oauth` 的 `mcpServers`；
// - Skill：全局 `~/.claude/skills/<name>`、项目 `<project>/.claude/skills/<name>` 逐项建软链（兼容整目录软链）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ScannedCloudConnector, VendorSyncAdapter, VendorSyncContext } from "../daemon-types.ts";
import { isPlainObject, patchJsoncMapEntries, readJsoncObjectFile } from "../_common/sync/jsonc.ts";
import {
  CLOUD_CONNECTOR_NON_SYNCABLE_REASON,
  OAUTH_NON_SYNCABLE_REASON,
  parseCommonJsonMcpEntry,
  serializeCommonJsonMcpEntry,
} from "../_common/sync/mcp.ts";
import claudeSpec from "./spec.ts";

const CLAUDE_CLOUD_CONNECTOR_KEYS = [
  "claudeAiMcp",
  "claudeAiMcpServers",
  "cachedClaudeAiMcpServers",
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
        if (!isPlainObject(item) || item.enabled === false) continue;
        const name = typeof item.name === "string" ? item.name.trim() : typeof item.id === "string" ? item.id.trim() : "";
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

  planMcpPatch(ctx, { upsert, removeNames }) {
    const configPath = resolveClaudeMcpConfigPath(ctx);
    const doc = readJsoncObjectFile(configPath);
    const existingMcp = isPlainObject(doc.data.mcpServers) ? doc.data.mcpServers : {};
    const protectedOAuthNames = new Set<string>();
    for (const [name, rawEntry] of Object.entries(existingMcp)) {
      if (parseCommonJsonMcpEntry(name, rawEntry).nonSyncable) {
        protectedOAuthNames.add(name);
      }
    }

    const serializedUpsert: Record<string, Record<string, unknown>> = {};
    for (const [name, spec] of Object.entries(upsert)) {
      if (protectedOAuthNames.has(name)) continue;
      serializedUpsert[name] = serializeCommonJsonMcpEntry(spec, {
        supportsSseMcp: true,
        explicitType: true,
      });
    }

    const safeRemove = new Set<string>();
    for (const name of removeNames) {
      if (!protectedOAuthNames.has(name)) safeRemove.add(name);
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
};

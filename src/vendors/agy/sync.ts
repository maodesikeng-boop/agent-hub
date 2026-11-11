// Antigravity (agy) 同步适配器：
// - 全局 MCP：`~/.gemini/config/mcp_config.json`（仅支持 stdio 与 streamable HTTP；旧版 `/sse` 自动包 `npx -y mcp-remote <url>`）；
// - Skill：项目 `.agents/skills` 原生发现零冗余；全局 `~/.gemini/config/skills/<name>` 逐项建软链。
import { join } from "node:path";
import type { ScannedCloudConnector, VendorSyncAdapter, VendorSyncContext } from "../daemon-types.ts";
import { isPlainObject, patchJsoncMapEntries, readJsoncObjectFile } from "../_common/sync/jsonc.ts";
import { parseCommonJsonMcpEntry, serializeCommonJsonMcpEntry } from "../_common/sync/mcp.ts";
import { AGY_MCP_CONFIG_REL } from "./spec.ts";

const AGY_GLOBAL_SKILLS_REL = ".gemini/config/skills";

export function resolveAgyMcpConfigPath(ctx: VendorSyncContext): string {
  return join(ctx.userHome, AGY_MCP_CONFIG_REL);
}

export const agySyncAdapter: VendorSyncAdapter = {
  supportsSseMcp: false,

  scanMcp(ctx) {
    const configPath = resolveAgyMcpConfigPath(ctx);
    const doc = readJsoncObjectFile(configPath);
    const servers: ReturnType<VendorSyncAdapter["scanMcp"]>["servers"] = {};
    const nonSyncable: ScannedCloudConnector[] = [];

    if (isPlainObject(doc.data.mcpServers)) {
      for (const [name, rawEntry] of Object.entries(doc.data.mcpServers)) {
        const parsed = parseCommonJsonMcpEntry(name, rawEntry);
        if (parsed.nonSyncable) {
          nonSyncable.push(parsed.nonSyncable);
        } else if (parsed.server) {
          servers[name] = parsed.server;
        }
      }
    }

    return { configPath, servers, nonSyncable };
  },

  planMcpPatch(ctx, { upsert, removeNames }) {
    const configPath = resolveAgyMcpConfigPath(ctx);
    const doc = readJsoncObjectFile(configPath);
    const existingMcp = isPlainObject(doc.data.mcpServers) ? doc.data.mcpServers : {};
    const protectedNames = new Set<string>();
    for (const [name, rawEntry] of Object.entries(existingMcp)) {
      if (parseCommonJsonMcpEntry(name, rawEntry).nonSyncable) protectedNames.add(name);
    }

    const serializedUpsert: Record<string, Record<string, unknown>> = {};
    for (const [name, spec] of Object.entries(upsert)) {
      if (protectedNames.has(name)) continue;
      serializedUpsert[name] = serializeCommonJsonMcpEntry(spec, {
        supportsSseMcp: false,
        explicitType: false,
      });
    }

    const safeRemove = new Set<string>();
    for (const name of removeNames) {
      if (!protectedNames.has(name)) safeRemove.add(name);
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
      return { mode: "symlink", targetDir: join(ctx.userHome, AGY_GLOBAL_SKILLS_REL) };
    }
    return { mode: "native" };
  },
};

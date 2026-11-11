// Cursor 同步适配器：
// - 全局 MCP：`~/.cursor/mcp.json`（原生支持 stdio、streamable HTTP 与 `/sse` 远程 MCP，JSONC 局部补丁保留注释）；
// - Skill：全局 `~/.agents/skills` 与项目 `.agents/skills` 原生读取零冗余。
import { join } from "node:path";
import type { ScannedCloudConnector, VendorSyncAdapter, VendorSyncContext } from "../daemon-types.ts";
import { isPlainObject, patchJsoncMapEntries, readJsoncObjectFile } from "../_common/sync/jsonc.ts";
import { parseCommonJsonMcpEntry, serializeCommonJsonMcpEntry } from "../_common/sync/mcp.ts";

export function resolveCursorMcpConfigPath(ctx: VendorSyncContext): string {
  return join(ctx.userHome, ".cursor", "mcp.json");
}

export const cursorSyncAdapter: VendorSyncAdapter = {
  supportsSseMcp: true,

  scanMcp(ctx) {
    const configPath = resolveCursorMcpConfigPath(ctx);
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
    const configPath = resolveCursorMcpConfigPath(ctx);
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
        supportsSseMcp: true,
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

  skillTarget() {
    return { mode: "native" };
  },
};

import { join } from "node:path";
import type { CanonicalMcpServer, ScannedCloudConnector, VendorSyncAdapter, VendorSyncContext } from "../daemon-types.ts";
import { isPlainObject, patchJsoncMapEntries, readJsoncObjectFile } from "../_common/sync/jsonc.ts";
import { collectProtectedJsonMcpNames, parseCommonJsonMcpEntry, serializeCommonJsonMcpEntry } from "../_common/sync/mcp.ts";
import { resolveKimiHome } from "./paths.ts";

function resolveKimiMcpConfigPath(ctx: VendorSyncContext): string {
  return join(resolveKimiHome(ctx.userHome, ctx.env), "mcp.json");
}

// Kimi treats a url without "transport" as Streamable HTTP, so SSE must be named explicitly.
function serializeKimiMcpEntry(server: CanonicalMcpServer): Record<string, unknown> {
  const entry = serializeCommonJsonMcpEntry(server, { supportsSseMcp: true, explicitType: false });
  return server.transport === "sse" ? { transport: "sse", ...entry } : entry;
}

export const kimiSyncAdapter: VendorSyncAdapter = {
  supportsSseMcp: true,

  scanMcp(ctx) {
    const configPath = resolveKimiMcpConfigPath(ctx);
    const doc = readJsoncObjectFile(configPath);
    const servers: Record<string, CanonicalMcpServer> = {};
    const nonSyncable: ScannedCloudConnector[] = [];
    if (isPlainObject(doc.data.mcpServers)) {
      for (const [name, raw] of Object.entries(doc.data.mcpServers)) {
        if (isPlainObject(raw) && raw.enabled === false) continue;
        const parsed = parseCommonJsonMcpEntry(name, raw);
        if (parsed.nonSyncable) nonSyncable.push(parsed.nonSyncable);
        else if (parsed.server) servers[name] = parsed.server;
      }
    }
    return { configPath, servers, nonSyncable };
  },

  planMcpPatch(ctx, { upsert, removeNames, isProtectedServer }) {
    const configPath = resolveKimiMcpConfigPath(ctx);
    const doc = readJsoncObjectFile(configPath);
    const existing = isPlainObject(doc.data.mcpServers) ? doc.data.mcpServers : {};
    const { skipUpsert, skipRemove } = collectProtectedJsonMcpNames(existing, isProtectedServer);
    const serialized = Object.fromEntries(
      Object.entries(upsert)
        .filter(([name]) => !skipUpsert.has(name))
        .map(([name, server]) => [name, serializeKimiMcpEntry(server)]),
    );
    const nextContent = patchJsoncMapEntries({
      doc,
      mapKey: "mcpServers",
      upsert: serialized,
      removeNames: new Set([...removeNames].filter((name) => !skipRemove.has(name))),
    });
    return { configPath, nextContent, mode: 0o600 };
  },

  skillTarget() {
    return { mode: "native" };
  },
};

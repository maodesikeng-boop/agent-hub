// Pi 同步适配器：
// - 全局 MCP：`$PI_CODING_AGENT_DIR/mcp.json`（默认 `~/.pi/agent/mcp.json`，支持 stdio 与 streamable HTTP，旧版 `/sse` 转 `mcp-remote`）；
// - OAuth 凭证文件 `mcp-auth.json` 绝不读取或复制，带 `oauth` 的条目识别为不可跨厂同步；
// - Skill：全局 `~/.pi/agent/skills/<name>` 逐项建软链，项目级 `.agents/skills` 原生及 `--skill` 直读。
import { join } from "node:path";
import type { ScannedCloudConnector, VendorSyncAdapter, VendorSyncContext } from "../daemon-types.ts";
import { isPlainObject, patchJsoncMapEntries, readJsoncObjectFile } from "../_common/sync/jsonc.ts";
import { parseCommonJsonMcpEntry, serializeCommonJsonMcpEntry } from "../_common/sync/mcp.ts";
import piSpec from "./spec.ts";

function resolvePiAgentDir(ctx: VendorSyncContext): string {
  const override = piSpec.home.configHome;
  const fromEnv = override ? ctx.env[override.env]?.trim() : "";
  return fromEnv ? fromEnv : join(ctx.userHome, ".pi", "agent");
}

export function resolvePiMcpConfigPath(ctx: VendorSyncContext): string {
  return join(resolvePiAgentDir(ctx), "mcp.json");
}

export const piSyncAdapter: VendorSyncAdapter = {
  supportsSseMcp: false,

  scanMcp(ctx) {
    const configPath = resolvePiMcpConfigPath(ctx);
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
    const configPath = resolvePiMcpConfigPath(ctx);
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
      return { mode: "symlink", targetDir: join(resolvePiAgentDir(ctx), "skills") };
    }
    return { mode: "native" };
  },
};

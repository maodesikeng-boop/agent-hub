// DeepSeek (`dsh`) 同步适配器：
// - MCP：`dsh` 无独立全局 MCP 配置文件，同步结果持久化于 `$DSH_HOME/mcp.json`（默认 `~/.dsh/mcp.json`，权限 `0600`），
//   由 `driver.ts` 在新建或恢复会话时通过 ACP 启动参数 `session.mcpServers` 动态注入（不打断运行中会话）；
// - `dsh-acp` 声明 `mcpCapabilities: { http: true }`（不支持 `sse`），因此旧版 `/sse` 自动转为 `npx -y mcp-remote <url>` stdio；
// - Skill：`@deepseek-ai/dsh-agent-instructions` 原生自动发现全局 `~/.agents/skills` 与工作区 `.agents/skills`。
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk/unstable";
import type { CanonicalMcpServer, ScannedCloudConnector, VendorSyncAdapter, VendorSyncContext } from "../daemon-types.ts";
import { isPlainObject, patchJsoncMapEntries, readJsoncObjectFile } from "../_common/sync/jsonc.ts";
import {
  materializeMcpForVendor,
  parseCommonJsonMcpEntry,
  serializeCommonJsonMcpEntry,
} from "../_common/sync/mcp.ts";
import { resolveDeepSeekHome } from "./paths.ts";

export function resolveDeepSeekMcpConfigPath(ctx: VendorSyncContext): string {
  return join(resolveDeepSeekHome(ctx.userHome, ctx.env), "mcp.json");
}

export function canonicalToAcpMcpServer(name: string, server: CanonicalMcpServer): McpServer {
  const materialized = materializeMcpForVendor(server, false);
  if (materialized.transport === "stdio") {
    return {
      name,
      command: materialized.command,
      args: [...materialized.args],
      env: Object.entries(materialized.env).map(([k, v]) => ({ name: k, value: v })),
    };
  }
  return {
    type: "http",
    name,
    url: materialized.url,
    headers: Object.entries(materialized.headers).map(([k, v]) => ({ name: k, value: v })),
  };
}

/** 读取 `$DSH_HOME/mcp.json` 并转换为 ACP `session/new` / `session/resume` 的 `mcpServers` 参数。 */
export function loadDeepSeekAcpMcpServers(dshHome: string): McpServer[] {
  const configPath = join(dshHome, "mcp.json");
  let doc: ReturnType<typeof readJsoncObjectFile>;
  try {
    doc = readJsoncObjectFile(configPath);
  } catch {
    return [];
  }
  if (!doc.exists || !isPlainObject(doc.data.mcpServers)) return [];
  const out: McpServer[] = [];
  for (const [name, rawEntry] of Object.entries(doc.data.mcpServers)) {
    const parsed = parseCommonJsonMcpEntry(name, rawEntry);
    if (parsed.server) {
      out.push(canonicalToAcpMcpServer(name, parsed.server));
    }
  }
  return out;
}

export const deepseekSyncAdapter: VendorSyncAdapter = {
  supportsSseMcp: false,

  scanMcp(ctx) {
    const configPath = resolveDeepSeekMcpConfigPath(ctx);
    const doc = readJsoncObjectFile(configPath);
    const servers: Record<string, CanonicalMcpServer> = {};
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
    const configPath = resolveDeepSeekMcpConfigPath(ctx);
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

  skillTarget() {
    return { mode: "native" };
  },
};

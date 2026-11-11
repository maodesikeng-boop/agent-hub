// 跨厂商可移植 MCP 规格归一化、旧版 `/sse` ↔ `npx -y mcp-remote <url>` 桥接识别与 OAuth 私有连接器过滤。
import type { CanonicalMcpServer, ScannedCloudConnector } from "../../daemon-types.ts";
import { deepEqualJson, isPlainObject } from "./jsonc.ts";

export const OAUTH_NON_SYNCABLE_REASON =
  "Uses provider-specific OAuth authentication; private OAuth tokens cannot be copied across providers";
export const CLOUD_CONNECTOR_NON_SYNCABLE_REASON =
  "Bound to provider cloud account; OAuth credentials cannot be synced across providers";

/** 判断远程 URL 是否属于旧版 HTTP+SSE 端点（路径以 `/sse` 结尾）。 */
export function isLegacySseEndpointUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.trim());
    return /\/sse\/?$/i.test(u.pathname);
  } catch {
    return /\/sse\/?(?:\?.*)?$/i.test(rawUrl.trim());
  }
}

/**
 * 识别形如 `npx -y mcp-remote <url> [--header "K: V" ...]` 的桥接 stdio 命令，
 * 提取原始远程 URL 与 Header，防止二次扫描时把已桥接的 SSE 当成新冲突或再次套壳。
 */
export function unwrapMcpRemoteBridge(
  command: string,
  args: readonly string[],
): { url: string; headers: Record<string, string> } | null {
  const cmd = command.trim();
  const isNpx = cmd === "npx" || cmd.endsWith("/npx");
  const isDirect = cmd === "mcp-remote" || cmd.endsWith("/mcp-remote");
  if (!isNpx && !isDirect) return null;

  let i = 0;
  if (isNpx) {
    while (i < args.length && (args[i] === "-y" || args[i] === "--yes")) i++;
    const pkg = args[i] ?? "";
    if (pkg !== "mcp-remote" && !pkg.startsWith("mcp-remote@")) return null;
    i++;
  }

  let url: string | null = null;
  const headers: Record<string, string> = {};
  while (i < args.length) {
    const token = args[i]!;
    if (token === "--header" && i + 1 < args.length) {
      const rawHeader = args[i + 1]!;
      const colon = rawHeader.indexOf(":");
      if (colon > 0) {
        headers[rawHeader.slice(0, colon).trim()] = rawHeader.slice(colon + 1).trim();
      }
      i += 2;
      continue;
    }
    if (!token.startsWith("-") && url === null && /^https?:\/\//i.test(token)) {
      url = token;
      i++;
      continue;
    }
    return null;
  }

  return url ? { url, headers } : null;
}

/** 将旧版 `/sse` 远程 MCP 转为仅支持 HTTP/stdio 厂商可用的 `npx -y mcp-remote <url>`。 */
export function wrapSseWithMcpRemote(
  url: string,
  headers: Readonly<Record<string, string>> = {},
): Extract<CanonicalMcpServer, { transport: "stdio" }> {
  const args: string[] = ["-y", "mcp-remote", url];
  for (const [k, v] of Object.entries(headers)) {
    args.push("--header", `${k}: ${v}`);
  }
  return {
    transport: "stdio",
    command: "npx",
    args,
    env: {},
    bridgedSseUrl: url,
  };
}

/** 按目标厂商是否原生支持 `/sse` 计算该家实际应落盘的规格。 */
export function materializeMcpForVendor(server: CanonicalMcpServer, supportsSseMcp: boolean): CanonicalMcpServer {
  if (server.transport === "sse" && !supportsSseMcp) {
    return wrapSseWithMcpRemote(server.url, server.headers);
  }
  return server;
}

function stripTransientFields(server: CanonicalMcpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    return {
      transport: "stdio",
      command: server.command,
      args: [...server.args],
      env: { ...server.env },
    };
  }
  if (server.transport === "http") {
    return {
      transport: "http",
      url: server.url,
      headers: { ...server.headers },
      ...(server.bearerTokenEnvVar ? { bearerTokenEnvVar: server.bearerTokenEnvVar } : {}),
    };
  }
  return {
    transport: "sse",
    url: server.url,
    headers: { ...server.headers },
  };
}

/** 判断某厂商当前已配置的 `existing` 是否已经与期望的并集规格 `desired` 等价（含 `mcp-remote` 桥接等价）。 */
export function isVendorMcpUpToDate(
  existing: CanonicalMcpServer | undefined,
  desired: CanonicalMcpServer,
  supportsSseMcp: boolean,
): boolean {
  if (!existing) return false;
  const targetDesired = materializeMcpForVendor(desired, supportsSseMcp);
  return deepEqualJson(stripTransientFields(existing), stripTransientFields(targetDesired));
}

export function cleanStringMap(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function cleanStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

function hasOAuthBinding(entry: Record<string, unknown>): boolean {
  if (isPlainObject(entry.oauth)) return true;
  if (isPlainObject(entry.auth) && String(entry.auth.type ?? "").toLowerCase() === "oauth") return true;
  if (typeof entry.accessToken === "string" || typeof entry.refreshToken === "string" || typeof entry.oauthToken === "string") {
    return true;
  }
  const rawType = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
  if (rawType.includes("claudeai") || rawType.includes("oauth")) return true;
  return false;
}

/**
 * 从通用 JSON `mcpServers` 条目解析出可移植规格或不可同步的 OAuth 条目。
 * 兼容 `url` / `serverUrl` / `httpUrl`、`type` / `transport` 及 `mcp-remote` 桥接识别。
 */
export function parseCommonJsonMcpEntry(
  name: string,
  rawEntry: unknown,
): { server?: CanonicalMcpServer; nonSyncable?: ScannedCloudConnector } {
  if (!isPlainObject(rawEntry)) return {};
  if (hasOAuthBinding(rawEntry)) {
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

  const rawUrl =
    typeof rawEntry.url === "string"
      ? rawEntry.url.trim()
      : typeof rawEntry.serverUrl === "string"
        ? rawEntry.serverUrl.trim()
        : typeof rawEntry.httpUrl === "string"
          ? rawEntry.httpUrl.trim()
          : "";
  if (rawUrl !== "") {
    const rawType =
      typeof rawEntry.type === "string"
        ? rawEntry.type.trim().toLowerCase()
        : typeof rawEntry.transport === "string"
          ? rawEntry.transport.trim().toLowerCase()
          : "";
    const headers = cleanStringMap(rawEntry.headers);
    const isSse = rawType === "sse" || (rawType === "" && isLegacySseEndpointUrl(rawUrl));
    return {
      server: {
        transport: isSse ? "sse" : "http",
        url: rawUrl,
        headers,
      },
    };
  }

  return {};
}

/** 序列化为 JSON `mcpServers[name]` 对象（空 `args`/`env`/`headers` 按家惯例精简，保持文件干净）。 */
export function serializeCommonJsonMcpEntry(
  server: CanonicalMcpServer,
  options: { supportsSseMcp: boolean; explicitType?: boolean },
): Record<string, unknown> {
  const materialized = materializeMcpForVendor(server, options.supportsSseMcp);
  if (materialized.transport === "stdio") {
    return {
      ...(options.explicitType ? { type: "stdio" } : {}),
      command: materialized.command,
      args: [...materialized.args],
      ...(Object.keys(materialized.env).length > 0 ? { env: { ...materialized.env } } : {}),
    };
  }
  return {
    ...(options.explicitType ? { type: materialized.transport } : {}),
    url: materialized.url,
    ...(Object.keys(materialized.headers).length > 0 ? { headers: { ...materialized.headers } } : {}),
  };
}

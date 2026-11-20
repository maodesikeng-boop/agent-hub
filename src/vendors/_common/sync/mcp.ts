import type { CanonicalMcpServer, ScannedCloudConnector } from "../../daemon-types.ts";
import { deepEqualJson, isPlainObject } from "./jsonc.ts";

export const OAUTH_NON_SYNCABLE_REASON =
  "Uses provider-specific OAuth authentication; private OAuth tokens cannot be copied across providers";
export const CLOUD_CONNECTOR_NON_SYNCABLE_REASON =
  "Bound to provider cloud account; OAuth credentials cannot be synced across providers";

export function isLegacySseEndpointUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.trim());
    return /\/sse\/?$/i.test(u.pathname);
  } catch {
    return /\/sse\/?(?:\?.*)?$/i.test(rawUrl.trim());
  }
}

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

export function collectProtectedJsonMcpNames(
  existingMcp: Record<string, unknown>,
  isProtectedServer?: (server: CanonicalMcpServer) => boolean,
): { skipUpsert: Set<string>; skipRemove: Set<string> } {
  const skipUpsert = new Set<string>();
  const skipRemove = new Set<string>();
  for (const [name, rawEntry] of Object.entries(existingMcp)) {
    const parsed = parseCommonJsonMcpEntry(name, rawEntry);
    if (parsed.nonSyncable) {
      skipUpsert.add(name);
      skipRemove.add(name);
    } else if (parsed.server && isProtectedServer?.(parsed.server)) {
      skipRemove.add(name);
    }
  }
  return { skipUpsert, skipRemove };
}

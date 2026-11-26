// V1 keeps servers directly under "mcp"; V2 nests them under "mcp.servers". Patches follow the layout already on disk.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import type { CanonicalMcpServer, ScannedCloudConnector, VendorSyncAdapter, VendorSyncContext } from "../daemon-types.ts";
import { isPlainObject, readJsoncObjectFile, type JsoncDocument } from "../_common/sync/jsonc.ts";
import { OAUTH_NON_SYNCABLE_REASON, cleanStringArray, cleanStringMap, materializeMcpForVendor } from "../_common/sync/mcp.ts";
import { OPENCODE_CONFIG_REL } from "./spec.ts";

function openCodeConfigPaths(ctx: VendorSyncContext): readonly [string, string] {
  const dir = join(ctx.userHome, ...OPENCODE_CONFIG_REL.split("/"));
  return [join(dir, "opencode.jsonc"), join(dir, "opencode.json")];
}

function resolveOpenCodeConfigPath(ctx: VendorSyncContext): string {
  const [jsonc, json] = openCodeConfigPaths(ctx);
  return existsSync(jsonc) ? jsonc : json;
}

function isV1Entry(value: unknown): boolean {
  return isPlainObject(value) && typeof value.type === "string";
}

export function openCodeMcpPath(doc: JsoncDocument): readonly string[] {
  const mcp = doc.data.mcp;
  if (!isPlainObject(mcp)) return ["mcp", "servers"];
  if (isPlainObject(mcp.servers) && !isV1Entry(mcp.servers)) return ["mcp", "servers"];
  return Object.values(mcp).some(isV1Entry) ? ["mcp"] : ["mcp", "servers"];
}

function serverMap(doc: JsoncDocument, path: readonly string[]): Record<string, unknown> {
  let node: unknown = doc.data;
  for (const key of path) node = isPlainObject(node) ? node[key] : undefined;
  if (!isPlainObject(node)) return {};
  return path.length === 1 ? Object.fromEntries(Object.entries(node).filter(([, v]) => isV1Entry(v))) : node;
}

export function parseOpenCodeMcpEntry(name: string, raw: unknown): { server?: CanonicalMcpServer; nonSyncable?: ScannedCloudConnector } {
  if (!isPlainObject(raw) || raw.disabled === true || raw.enabled === false) return {};
  if (raw.type === "local") {
    const [command, ...args] = cleanStringArray(raw.command);
    if (command === undefined || command.trim() === "") return {};
    return { server: { transport: "stdio", command, args, env: cleanStringMap(raw.environment) } };
  }
  if (raw.type === "remote" && typeof raw.url === "string" && raw.url.trim() !== "") {
    if (isPlainObject(raw.oauth)) return { nonSyncable: { name, kind: "oauth_mcp", reason: OAUTH_NON_SYNCABLE_REASON } };
    return { server: { transport: "http", url: raw.url.trim(), headers: cleanStringMap(raw.headers) } };
  }
  return {};
}

function serializeOpenCodeMcpEntry(server: CanonicalMcpServer): Record<string, unknown> {
  const materialized = materializeMcpForVendor(server, false);
  if (materialized.transport === "stdio") {
    return {
      type: "local",
      command: [materialized.command, ...materialized.args],
      ...(Object.keys(materialized.env).length > 0 ? { environment: { ...materialized.env } } : {}),
    };
  }
  return {
    type: "remote",
    url: materialized.url,
    ...(Object.keys(materialized.headers).length > 0 ? { headers: { ...materialized.headers } } : {}),
  };
}

export const opencodeSyncAdapter: VendorSyncAdapter = {
  mcpConfigPaths: openCodeConfigPaths,
  supportsSseMcp: false,

  scanMcp(ctx) {
    const configPath = resolveOpenCodeConfigPath(ctx);
    const doc = readJsoncObjectFile(configPath);
    const servers: Record<string, CanonicalMcpServer> = {};
    const nonSyncable: ScannedCloudConnector[] = [];
    for (const [name, raw] of Object.entries(serverMap(doc, openCodeMcpPath(doc)))) {
      const parsed = parseOpenCodeMcpEntry(name, raw);
      if (parsed.nonSyncable) nonSyncable.push(parsed.nonSyncable);
      else if (parsed.server) servers[name] = parsed.server;
    }
    return { configPath, servers, nonSyncable };
  },

  planMcpPatch(ctx, { upsert, removeNames, isProtectedServer }) {
    const configPath = resolveOpenCodeConfigPath(ctx);
    const doc = readJsoncObjectFile(configPath);
    const path = openCodeMcpPath(doc);
    const existing = serverMap(doc, path);
    const names = Object.keys(upsert).filter((name) => !Object.hasOwn(existing, name)).sort();
    const removable = [...removeNames].filter((name) => {
      if (Object.hasOwn(upsert, name) || !Object.hasOwn(existing, name)) return false;
      const parsed = parseOpenCodeMcpEntry(name, existing[name]);
      return parsed.nonSyncable === undefined && !(parsed.server && isProtectedServer?.(parsed.server));
    });
    if (names.length === 0 && removable.length === 0) return { configPath, nextContent: null };

    const base = doc.raw.trim() === "" ? "{}\n" : doc.raw;
    const formattingOptions = { insertSpaces: true, tabSize: 2, eol: base.includes("\r\n") ? "\r\n" : "\n" };
    let next = base;
    for (const name of removable) next = applyEdits(next, modify(next, [...path, name], undefined, { formattingOptions }));
    for (const name of names) {
      next = applyEdits(next, modify(next, [...path, name], serializeOpenCodeMcpEntry(upsert[name]!), { formattingOptions }));
    }
    if (!next.endsWith("\n")) next += formattingOptions.eol;
    return { configPath, nextContent: next === doc.raw ? null : next, mode: 0o600 };
  },

  skillTarget() {
    return { mode: "native" };
  },
};

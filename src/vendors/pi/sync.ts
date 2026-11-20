import { join } from "node:path";
import type { ScannedCloudConnector, VendorCapabilityScan, VendorSyncAdapter, VendorSyncContext } from "../daemon-types.ts";
import { isPlainObject, patchJsoncMapEntries, readJsoncObjectFile } from "../_common/sync/jsonc.ts";
import { collectProtectedJsonMcpNames, parseCommonJsonMcpEntry, serializeCommonJsonMcpEntry } from "../_common/sync/mcp.ts";
import { listCanonicalSkillNames, readSkillDescription } from "../_common/sync/skills.ts";
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

  planMcpPatch(ctx, { upsert, removeNames, isProtectedServer }) {
    const configPath = resolvePiMcpConfigPath(ctx);
    const doc = readJsoncObjectFile(configPath);
    const existingMcp = isPlainObject(doc.data.mcpServers) ? doc.data.mcpServers : {};
    const { skipUpsert, skipRemove } = collectProtectedJsonMcpNames(existingMcp, isProtectedServer);

    const serializedUpsert: Record<string, Record<string, unknown>> = {};
    for (const [name, spec] of Object.entries(upsert)) {
      if (skipUpsert.has(name)) continue;
      serializedUpsert[name] = serializeCommonJsonMcpEntry(spec, {
        supportsSseMcp: false,
        explicitType: false,
      });
    }

    const safeRemove = new Set<string>();
    for (const name of removeNames) {
      if (!skipRemove.has(name)) safeRemove.add(name);
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

  async scanCapabilities(ctx) {
    const out: VendorCapabilityScan = { skills: [], mcp: [], connectors: [], plugins: [] };
    const globalAgentsSkills = join(ctx.userHome, ".agents", "skills");
    for (const sName of listCanonicalSkillNames(globalAgentsSkills).names) {
      const dir = join(globalAgentsSkills, sName);
      out.skills.push({
        name: sName,
        dir,
        description: readSkillDescription(dir),
        source: { kind: "global" },
      });
    }
    return out;
  },
};

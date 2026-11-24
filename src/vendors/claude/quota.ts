import { join } from "node:path";
import { LRUCache } from "lru-cache";
import { MAX_VENDOR_SYNC_CONFIG_BYTES, type QuotaResponse } from "../../shared/index.ts";
import { readBoundedJsonObject } from "../_common/setup/file-helpers.ts";
import { fileStamp } from "../_common/setup/file-stamp.ts";
import type { VendorQuotaQuery } from "../daemon-types.ts";
import { queryClaudeControl } from "./catalog.ts";
import spec from "./spec.ts";

const accountByFile = new LRUCache<string, { stamp: string; account: string }>({ max: 1 });

function accountScope(file: string): string {
  const stamp = fileStamp(file);
  const cached = accountByFile.get(file);
  if (cached?.stamp === stamp) return cached.account;
  const metadata = readBoundedJsonObject(file, MAX_VENDOR_SYNC_CONFIG_BYTES)?.oauthAccount;
  const account = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? JSON.stringify(["accountUuid", "organizationUuid"].map((key) => (metadata as Record<string, unknown>)[key]))
    : "";
  accountByFile.set(file, { stamp, account });
  return account;
}

export function claudeQuotaScope(home: string, env: NodeJS.ProcessEnv): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  const config = override || join(home, ".claude");
  return JSON.stringify([config, accountScope(join(override || home, ".claude.json")), fileStamp(join(config, ".credentials.json")), fileStamp(join(config, "settings.json"))]);
}

function parseClaudeQuota(usage: Record<string, unknown>): QuotaResponse {
  const limits = usage.rate_limits;
  if (usage.rate_limits_available !== true || typeof limits !== "object" || limits === null) return { groups: [] };
  const windows: QuotaResponse["groups"][number]["windows"] = {};
  for (const key of spec.quota!.windows) {
    const entry = (limits as Record<string, unknown>)[key];
    if (typeof entry !== "object" || entry === null) continue;
    const { utilization, resets_at } = entry as Record<string, unknown>;
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
    const resets = typeof resets_at === "string" ? Date.parse(resets_at) : NaN;
    windows[key] = { utilization: utilization / 100, resetsAt: Number.isFinite(resets) ? resets / 1000 : 0, status: "allowed" };
  }
  return { groups: Object.keys(windows).length > 0 ? [{ vendor: spec.id, id: spec.id, windows }] : [] };
}

export async function queryClaudeQuota({ path, ...options }: VendorQuotaQuery): Promise<QuotaResponse> {
  return parseClaudeQuota(await queryClaudeControl({ ...options, claudePath: path }, "get_usage"));
}

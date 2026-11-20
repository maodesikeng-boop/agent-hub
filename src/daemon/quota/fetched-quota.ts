import { execFile } from "node:child_process";
import { LRUCache } from "lru-cache";
import { FETCHED_QUOTA_FRESH_MS, FETCHED_QUOTA_RETRY_MS, FETCHED_QUOTA_TIMEOUT_MS, type AgentVendor, type FetchedQuotaSpec, type QuotaResponse } from "../../shared/index.ts";

const EMPTY: QuotaResponse = { groups: [] };

export function parseFetchedQuota(text: string, spec: FetchedQuotaSpec, vendor: AgentVendor): QuotaResponse {
  const groups: QuotaResponse["groups"] = spec.groups.map((g) => ({ vendor, id: g.key, windows: {} }));
  for (const line of text.split(/\r?\n/)) {
    const [groupName, windowName, remaining, resets] = line.split("\t").map((cell) => cell.trim());
    const index = spec.groups.findIndex((g) => g.match === groupName);
    const key = windowName === undefined ? undefined : spec.windows[windowName];
    const percent = Number.parseFloat(remaining ?? "");
    if (index < 0 || key === undefined || !Number.isFinite(percent)) continue;
    const resetMs = Date.parse(resets ?? "");
    groups[index]!.windows[key] = {
      utilization: 1 - Math.min(100, Math.max(0, percent)) / 100,
      resetsAt: Number.isFinite(resetMs) ? resetMs / 1000 : 0,
      status: "allowed",
    };
  }
  return { groups: groups.filter((g) => Object.keys(g.windows).length > 0) };
}

export interface QueryFetchedQuotaOptions {
  vendor: AgentVendor;
  path: string;
  spec: FetchedQuotaSpec;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function queryFetchedQuota(options: QueryFetchedQuotaOptions): Promise<QuotaResponse> {
  const { vendor, path, spec, cwd, env, timeoutMs = FETCHED_QUOTA_TIMEOUT_MS } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(
      path,
      [...spec.args],
      { cwd, ...(env ? { env } : {}), timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20 },
      (error, stdout) => {
      if (error) reject(error);
      else resolve(parseFetchedQuota(stdout, spec, vendor));
      },
    );
    child.stdin?.end();
  });
}

export interface FetchedQuota {
  get(): Promise<QuotaResponse>;
}

export function createFetchedQuota(options: { query: (() => Promise<QuotaResponse>) | undefined; now?: () => number }): FetchedQuota {
  const now = options.now ?? Date.now;
  const cache = new LRUCache<"quota", { at: number; ttl: number; value: QuotaResponse }>({ max: 1 });
  let inflight: Promise<QuotaResponse> | null = null;
  return {
    get() {
      if (options.query === undefined) return Promise.resolve(EMPTY);
      const cached = cache.get("quota");
      if (cached !== undefined && now() - cached.at < cached.ttl) return Promise.resolve(cached.value);
      inflight ??= options
        .query()
        .catch(() => EMPTY)
        .then((value) => {
          cache.set("quota", { at: now(), ttl: value.groups.length > 0 ? FETCHED_QUOTA_FRESH_MS : FETCHED_QUOTA_RETRY_MS, value });
          inflight = null;
          return value;
        });
      return inflight;
    },
  };
}

export function mergeFetchedQuotas(quotas: readonly FetchedQuota[]): FetchedQuota {
  return {
    async get() {
      const all = await Promise.all(quotas.map((q) => q.get()));
      return { groups: all.flatMap((r) => r.groups) };
    },
  };
}

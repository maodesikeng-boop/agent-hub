// 事件流里没有额度的厂商（agy）的额度：用户打开额度面板时另起一次性进程问一次（agy -p "/usage"，不耗额度），结果缓存 FETCHED_QUOTA_FRESH_MS。
// 不在后台定时问；没装、问失败、输出认不出来都回空（网页不显示那一块），空结果只记 FETCHED_QUOTA_RETRY_MS。哪家、怎么问、分几组由 shared/vendors.ts 的 quota.fetched 定。
import { execFile } from "node:child_process";
import { FETCHED_QUOTA_FRESH_MS, FETCHED_QUOTA_RETRY_MS, FETCHED_QUOTA_TIMEOUT_MS, type FetchedQuotaSpec, type QuotaResponse } from "../../shared/index.ts";

const EMPTY: QuotaResponse = { groups: [] };

/** 输出每行：组名 TAB 窗口名 TAB 剩余百分比（如 75%） TAB 重置时间（ISO）。认不出来的行跳过，一个窗口都没有的组不返回。 */
export function parseFetchedQuota(text: string, spec: FetchedQuotaSpec): QuotaResponse {
  const groups: QuotaResponse["groups"] = spec.groups.map((g) => ({ id: g.key, name: g.name, windows: {} }));
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
  path: string;
  spec: FetchedQuotaSpec;
  cwd: string;
  timeoutMs?: number;
}

/** 起一次进程问额度，返回解析后的结果；起不来、超时、退出码非 0 报错。 */
export function queryFetchedQuota(options: QueryFetchedQuotaOptions): Promise<QuotaResponse> {
  const { path, spec, cwd, timeoutMs = FETCHED_QUOTA_TIMEOUT_MS } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(path, [...spec.args], { cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(parseFetchedQuota(stdout, spec));
    });
    child.stdin?.end();
  });
}

export interface FetchedQuota {
  /**
   * 缓存新就直接回，旧了问一次；同时来的几次只问一次；不会失败（失败回空）。
   * 问到了有数据的记 FETCHED_QUOTA_FRESH_MS；失败、一组都没认出来的只记 FETCHED_QUOTA_RETRY_MS（不把偶发失败当结果长期缓存）。
   */
  get(): Promise<QuotaResponse>;
}

export function createFetchedQuota(options: { query: (() => Promise<QuotaResponse>) | undefined; now?: () => number }): FetchedQuota {
  const now = options.now ?? Date.now;
  let cached: { at: number; ttl: number; value: QuotaResponse } | null = null;
  let inflight: Promise<QuotaResponse> | null = null;
  return {
    get() {
      if (options.query === undefined) return Promise.resolve(EMPTY);
      if (cached !== null && now() - cached.at < cached.ttl) return Promise.resolve(cached.value);
      inflight ??= options
        .query()
        .catch(() => EMPTY)
        .then((value) => {
          cached = { at: now(), ttl: value.groups.length > 0 ? FETCHED_QUOTA_FRESH_MS : FETCHED_QUOTA_RETRY_MS, value };
          inflight = null;
          return value;
        });
      return inflight;
    },
  };
}

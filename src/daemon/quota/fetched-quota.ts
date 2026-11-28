import {
  FETCHED_QUOTA_FRESH_MS,
  FETCHED_QUOTA_RETRY_MS,
  FETCHED_QUOTA_TIMEOUT_MS,
  PROBE_SHUTDOWN_DRAIN_MS,
  type AgentVendor,
  type FetchedQuotaSpec,
  type QuotaResponse,
} from "../../shared/index.ts";
import { runShortSubcommand } from "../../vendors/_common/setup/file-helpers.ts";

const EMPTY: QuotaResponse = { groups: [] };
const EMPTY_SNAPSHOT: FetchedQuotaSnapshot = { response: EMPTY, probedAt: null };

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
  signal?: AbortSignal;
}

export async function queryFetchedQuota(options: QueryFetchedQuotaOptions): Promise<QuotaResponse | null> {
  const { vendor, path, spec, cwd, env, signal, timeoutMs = FETCHED_QUOTA_TIMEOUT_MS } = options;
  const { code, stdout } = await runShortSubcommand(path, spec.args, { cwd, env, timeoutMs, signal, purpose: `probe:${vendor}-quota` });
  if (code !== 0) throw new Error(`Could not read ${vendor} quota`);
  return stdout.trim() === "" ? null : parseFetchedQuota(stdout, spec, vendor);
}

export interface FetchedQuota {
  get(): Promise<QuotaResponse>;
}

export interface FetchedQuotaSnapshot {
  readonly response: QuotaResponse;
  readonly probedAt: number | null;
}

export interface CachedQuota extends FetchedQuota {
  /**
   * Postcondition: returns the current cached or freshly probed QuotaResponse together with the daemon timestamp recorded when that probe started (null when closed, unconfigured, or empty/failed).
   */
  getSnapshot(): Promise<FetchedQuotaSnapshot>;
  invalidate(): void;
  isCurrent(value: QuotaResponse): boolean;
  /**
   * Postcondition: marks this source closed, aborts every active and previously invalidated in-flight probe, and resolves only after all of them have settled within timeoutMs.
   */
  close(options?: { readonly timeoutMs?: number }): Promise<void>;
}

function currentWindows(value: QuotaResponse, at: number): { value: QuotaResponse; until: number } {
  let until = at + FETCHED_QUOTA_FRESH_MS;
  const groups = value.groups.flatMap((group) => {
    const entries = Object.entries(group.windows).filter(([, w]) => {
      if (w.resetsAt <= 0) return true;
      const reset = w.resetsAt * 1000;
      if (reset <= at) return false;
      until = Math.min(until, reset);
      return true;
    });
    return entries.length ? [{ ...group, windows: Object.fromEntries(entries) }] : [];
  });
  return groups.length ? { value: { groups }, until } : { value: EMPTY, until: at + FETCHED_QUOTA_RETRY_MS };
}

interface CachedQuotaEntry {
  readonly value: QuotaResponse;
  readonly until: number;
  readonly probedAt: number | null;
}

export function createFetchedQuota(options: {
  query: ((signal: AbortSignal) => Promise<QuotaResponse | null>) | undefined;
  fingerprint?: () => string;
  now?: () => number;
  onFetched?: (response: QuotaResponse, probedAt: number) => void;
  onScopeChanged?: () => void;
}): CachedQuota {
  const now = options.now ?? Date.now;
  const fingerprint = options.fingerprint ?? (() => "");
  let scope: string | undefined;
  let cached: CachedQuotaEntry | undefined;
  let inflight: { abort: AbortController; result: Promise<FetchedQuotaSnapshot> } | undefined;
  let closed = false;
  const draining = new Set<{ abort: AbortController; done: Promise<void> }>();
  const invalidate = () => {
    inflight?.abort.abort();
    inflight = undefined;
    cached = undefined;
  };
  const getSnapshot = (): Promise<FetchedQuotaSnapshot> => {
    if (closed || options.query === undefined) return Promise.resolve(EMPTY_SNAPSHOT);
    const key = fingerprint();
    if (key !== scope) {
      const hadScope = scope !== undefined;
      invalidate();
      scope = key;
      if (hadScope) options.onScopeChanged?.();
    }
    if (cached !== undefined && now() < cached.until) {
      return Promise.resolve({ response: cached.value, probedAt: cached.probedAt });
    }
    if (inflight !== undefined) return inflight.result;
    const startedAt = now();
    const abort = new AbortController();
    const run = { abort, done: Promise.resolve() };
    const result = options
      .query(abort.signal)
      .catch(() => EMPTY)
      .then((value): FetchedQuotaSnapshot => {
        if (closed || inflight?.abort !== abort) return EMPTY_SNAPSHOT;
        inflight = undefined;
        if (key !== fingerprint()) return EMPTY_SNAPSHOT;
        if (value === null) {
          cached = { value: EMPTY, until: Infinity, probedAt: null };
          return EMPTY_SNAPSHOT;
        }
        const next = currentWindows(value, now());
        const probedAt = next.value.groups.length > 0 ? startedAt : null;
        cached = { ...next, probedAt };
        if (probedAt !== null) options.onFetched?.(cached.value, probedAt);
        return { response: cached.value, probedAt };
      });
    run.done = result.then(() => undefined, () => undefined).finally(() => {
      draining.delete(run);
    });
    draining.add(run);
    inflight = { abort, result };
    return result;
  };

  return {
    getSnapshot,
    invalidate,
    isCurrent: (value) => !closed && cached?.value === value && now() < cached.until && scope === fingerprint(),
    get: () => getSnapshot().then((snapshot) => snapshot.response),
    async close(closeOptions?: { readonly timeoutMs?: number }): Promise<void> {
      closed = true;
      invalidate();
      for (const run of draining) run.abort.abort();
      const pending = [...draining].map((run) => run.done);
      if (pending.length === 0) return;
      const timeoutMs = closeOptions?.timeoutMs ?? PROBE_SHUTDOWN_DRAIN_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    },
  };
}

export function mergeFetchedQuotas(quotas: readonly CachedQuota[]): FetchedQuota {
  return {
    async get() {
      const all = await Promise.all(quotas.map((q) => q.get()));
      return { groups: all.flatMap((value, i) => quotas[i]!.isCurrent(value) ? value.groups : []) };
    },
  };
}

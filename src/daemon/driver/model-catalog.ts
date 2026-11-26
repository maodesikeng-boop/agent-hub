import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { LRUCache } from "lru-cache";
import {
  AGENT_VENDORS,
  KILL_WAIT_MS,
  MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS,
  MODEL_CATALOG_FRESH_MS,
  MODEL_CATALOG_MAX_PROBE_ATTEMPTS,
  MODEL_CATALOG_RETRY_MS,
  VENDOR_RECHECK_BUDGET_MS,
  bundledModelCatalog,
  isSelectable,
  type AgentVendor,
  type ModelCatalog,
  type VendorAvailability,
  vendorFailureOf,
} from "../../shared/index.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import { forceKill, killFreshGroup } from "./process.ts";

export const STDERR_TAIL_CHARS = 500;

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function effortsOf(entry: Record<string, unknown>): string[] | null {
  if (Array.isArray(entry.supportedEffortLevels)) {
    return [...new Set(entry.supportedEffortLevels.filter((e): e is string => typeof e === "string"))];
  }
  return entry.supportsEffort === false ? [] : null;
}

/** Settle only after the whole group is SIGKILLed; forceKill SIGSTOPs first, so settling early leaves stopped orphans when the caller exits. */
export function killThenSettle(child: ChildProcessWithoutNullStreams, settle: () => void): void {
  forceKill(child)
    .catch(() => killFreshGroup(child))
    .finally(settle);
}

export function parseJsonOutput(stdout: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = stdout.trim();
  if (trimmed === "") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const lines = trimmed
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return { ok: true, value: JSON.parse(lines[i]!) };
      } catch {
      }
    }
    return { ok: false };
  }
}

export interface VendorCatalogSource {
  query: (signal: AbortSignal) => Promise<unknown>;
  parse: (raw: unknown) => ModelCatalog | null;
  availabilityOf?: (raw: unknown) => VendorAvailability;
  availabilityOfError?: (error: unknown) => VendorAvailability;
  confirm?: (signal: AbortSignal) => Promise<VendorAvailability>;
  installed?: () => boolean;
  fingerprint?: () => string;
}

export function defaultAvailabilityOfError(vendor: AgentVendor, error: unknown): VendorAvailability {
  const message = error instanceof Error ? error.message : String(error);
  if (/\bENOENT\b/.test(message)) return "not_installed";
  return vendorFailureOf(message, vendor)?.kind === "auth" ? "signed_out" : "unknown";
}

export interface ModelCatalogsOptions {
  sources: Partial<Record<AgentVendor, VendorCatalogSource>>;
  now?: () => number;
  log?: (line: string) => void;
  ensureUsableBudgetMs?: number;
}

export interface ModelCatalogs {
  list(options?: { refresh?: boolean | "unusable"; vendor?: AgentVendor }): Promise<ModelCatalog[]>;
  current(vendor: AgentVendor): ModelCatalog | null;
  availability(vendor: AgentVendor): VendorAvailability;
  ensureUsable(vendor: AgentVendor): Promise<VendorAvailability>;
  report(vendor: AgentVendor, availability: VendorAvailability): void;
  close(): Promise<void>;
}

interface VendorCatalogSlot {
  readonly vendor: AgentVendor;
  readonly source: VendorCatalogSource | undefined;
  cached: ModelCatalog | null;
  cachedAt: number;
  availability: VendorAvailability | null;
  availabilityAt: number;
  failedAt: number | null;
  fingerprint: string | null;
  fingerprintSeen: string | null;
  fingerprintCheckedAt: number;
  inflight: Promise<void> | null;
}

function resetCatalog(slot: VendorCatalogSlot, fingerprint: string | null): void {
  slot.cached = null;
  slot.cachedAt = 0;
  slot.availability = null;
  slot.availabilityAt = 0;
  slot.failedAt = null;
  slot.fingerprint = fingerprint;
}

async function probeCatalog(source: VendorCatalogSource, vendor: AgentVendor, signal: AbortSignal) {
  let availability: VendorAvailability;
  let catalog: ModelCatalog | null = null;
  let reason: string | null = null;
  try {
    const raw = await source.query(signal);
    availability = source.availabilityOf?.(raw) ?? "available";
    catalog = source.parse(raw);
    if (catalog === null) reason = "回的名单是空的或者认不出";
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
    availability = source.availabilityOfError?.(error) ?? defaultAvailabilityOfError(vendor, error);
  }
  if (availability === "unknown" && source.confirm && !signal.aborted) {
    availability = await source.confirm(signal).catch((): VendorAvailability => "unknown");
  }
  return { catalog, availability, reason };
}

export function createModelCatalogs(options: ModelCatalogsOptions): ModelCatalogs {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const ensureUsableBudgetMs = options.ensureUsableBudgetMs ?? VENDOR_RECHECK_BUDGET_MS;
  let closed = false;
  const controller = new AbortController();

  const slots = new LRUCache<AgentVendor, VendorCatalogSlot>({ max: AGENT_VENDORS.length });
  for (const vendor of AGENT_VENDORS) {
    slots.set(vendor, {
      vendor,
      source: options.sources[vendor],
      cached: null,
      cachedAt: 0,
      availability: null,
      availabilityAt: 0,
      failedAt: null,
      fingerprint: null,
      fingerprintSeen: null,
      fingerprintCheckedAt: 0,
      inflight: null,
    });
  }
  const slotOf = (vendor: AgentVendor): VendorCatalogSlot => slots.get(vendor)!;

  const installed = (slot: VendorCatalogSlot) => slot.source?.installed?.() ?? true;
  /** Recompute the stat fingerprint only on force or after the cooldown. */
  const fingerprintOf = (slot: VendorCatalogSlot, force: boolean): string | null => {
    const compute = slot.source?.fingerprint;
    if (!compute) return null;
    if (force || slot.fingerprintSeen === null || now() - slot.fingerprintCheckedAt >= MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS) {
      slot.fingerprintSeen = compute();
      slot.fingerprintCheckedAt = now();
    }
    return slot.fingerprintSeen;
  };
  const invalidateOnChange = (slot: VendorCatalogSlot, force = false): boolean => {
    const fingerprint = fingerprintOf(slot, force);
    if (slot.fingerprint === null || fingerprint === slot.fingerprint) return false;
    resetCatalog(slot, fingerprint);
    return true;
  };

  const ask = (slot: VendorCatalogSlot): Promise<void> => {
    const source = slot.source;
    if (!source) return Promise.resolve();
    slot.inflight ??= (async () => {
      for (let attempt = 0; attempt < MODEL_CATALOG_MAX_PROBE_ATTEMPTS; attempt++) {
        if (closed || !installed(slot)) return;
        const before = fingerprintOf(slot, false);
        const { catalog, availability, reason } = await probeCatalog(source, slot.vendor, controller.signal);
        if (closed) return;
        const after = fingerprintOf(slot, true);
        if (before !== after) {
          resetCatalog(slot, after);
          continue;
        }
        const at = now();
        if (catalog !== null) {
          slot.cached = catalog;
          slot.cachedAt = at;
        }
        slot.failedAt = catalog === null ? at : null;
        slot.fingerprint = after;
        slot.availability = availability;
        slot.availabilityAt = at;
        if (reason !== null) log(`${LOG_PREFIX} 没问到 ${slot.vendor} 的模型名单（${reason}）`);
        return;
      }
      slot.failedAt = now();
    })().finally(() => {
      slot.inflight = null;
    });
    return slot.inflight;
  };

  const availabilityOf = (slot: VendorCatalogSlot): VendorAvailability => {
    if (!slot.source) return "unknown";
    if (!installed(slot)) return "not_installed";
    return slot.availability ?? "unknown";
  };
  const retryDue = (slot: VendorCatalogSlot) => slot.failedAt === null || now() - slot.failedAt >= MODEL_CATALOG_RETRY_MS;
  const result = (slot: VendorCatalogSlot): ModelCatalog => ({ ...(slot.cached ?? bundledModelCatalog(slot.vendor)), availability: availabilityOf(slot) });

  const catalogOf = async (slot: VendorCatalogSlot, refresh: boolean | "unusable"): Promise<ModelCatalog> => {
    if (!slot.source || closed) return result(slot);
    if (!installed(slot)) {
      resetCatalog(slot, null);
      return result(slot);
    }
    const changed = invalidateOnChange(slot, refresh === true);
    const usable = slot.availability === null || isSelectable(slot.availability);
    if (refresh === true || changed || (refresh === "unusable" && !usable && retryDue(slot))) await ask(slot);
    else if (slot.cached === null) {
      if (slot.inflight || retryDue(slot)) await ask(slot);
    } else if (!slot.inflight && retryDue(slot) && (
      slot.failedAt !== null || now() - slot.cachedAt >= MODEL_CATALOG_FRESH_MS || (!usable && now() - slot.availabilityAt >= MODEL_CATALOG_RETRY_MS)
    )) {
      void ask(slot);
    }
    return result(slot);
  };

  return {
    async list(opts = {}) {
      const refresh = opts.refresh ?? false;
      const vendors = opts.vendor !== undefined ? [opts.vendor] : AGENT_VENDORS;
      return Promise.all(vendors.map((vendor) => catalogOf(slotOf(vendor), refresh)));
    },
    current(vendor) {
      const slot = slotOf(vendor);
      return slot.cached === null ? null : result(slot);
    },
    availability(vendor) {
      return availabilityOf(slotOf(vendor));
    },
    async ensureUsable(vendor) {
      const slot = slotOf(vendor);
      const unasked = slot.availability === null;
      if (slot.source && !closed && installed(slot) && (
        invalidateOnChange(slot) || (retryDue(slot) && (unasked || !isSelectable(availabilityOf(slot))))
      )) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ensureUsableBudgetMs);
        });
        // ask never rejects; if the wait times out it keeps running and the next call reuses the inflight request.
        await Promise.race([ask(slot), timedOut]);
        clearTimeout(timer);
      }
      return availabilityOf(slot);
    },
    report(vendor, availability) {
      const slot = slotOf(vendor);
      if (slot.availability === availability) return;
      slot.availability = availability;
      slot.availabilityAt = now();
    },
    async close() {
      closed = true;
      controller.abort();
      const pending = [...slots.values()].map((s) => s.inflight).filter((p): p is Promise<void> => p !== null);
      if (pending.length === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, KILL_WAIT_MS);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    },
  };
}

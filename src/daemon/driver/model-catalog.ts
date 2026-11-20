import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { LRUCache } from "lru-cache";
import {
  AGENT_VENDORS,
  KILL_WAIT_MS,
  MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS,
  MODEL_CATALOG_FRESH_MS,
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
  failedAt: number | null;
  fingerprint: string | null;
  fingerprintSeen: string | null;
  fingerprintCheckedAt: number;
  inflight: Promise<void> | null;
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
  const fingerprintChanged = (slot: VendorCatalogSlot): boolean => {
    if (slot.fingerprint === null) return false;
    const current = fingerprintOf(slot, false);
    return current !== null && current !== slot.fingerprint;
  };
  const settle = (slot: VendorCatalogSlot, availability: VendorAvailability) => {
    slot.availability = availability;
    if (!isSelectable(availability)) slot.failedAt = now();
  };

  const ask = (slot: VendorCatalogSlot): Promise<void> => {
    const source = slot.source;
    if (!source) return Promise.resolve();
    slot.inflight ??= (async () => {
      if (!installed(slot)) {
        slot.fingerprint = fingerprintOf(slot, true);
        return;
      }
      let availability: VendorAvailability;
      let reason: string | null = null;
      try {
        const raw = await source.query(controller.signal);
        availability = source.availabilityOf?.(raw) ?? "available";
        const catalog = source.parse(raw);
        if (catalog !== null) {
          slot.cached = catalog;
          slot.cachedAt = now();
          slot.failedAt = null;
        } else {
          reason = "回的名单是空的或者认不出";
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        availability = source.availabilityOfError?.(error) ?? defaultAvailabilityOfError(slot.vendor, error);
      }
      if (availability === "unknown" && source.confirm && !closed) availability = await source.confirm(controller.signal);
      if (reason !== null) {
        slot.failedAt = now();
        if (!closed) log(`${LOG_PREFIX} 没问到 ${slot.vendor} 的模型名单（${reason}），先用打包的`);
      }
      slot.fingerprint = fingerprintOf(slot, true);
      settle(slot, availability);
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
    if (!slot.source || closed || !installed(slot)) return result(slot);
    const changed = fingerprintChanged(slot);
    if (changed) slot.failedAt = null;
    const usable = slot.availability === null || isSelectable(slot.availability);
    if (refresh === true || (refresh === "unusable" && !usable) || changed) await ask(slot);
    else if (slot.cached === null) {
      if (slot.inflight || slot.availability === null || retryDue(slot)) await ask(slot);
    } else if (!slot.inflight && (now() - slot.cachedAt >= MODEL_CATALOG_FRESH_MS || !usable) && retryDue(slot)) {
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
      if (slot.source && !closed && installed(slot) && (unasked || !isSelectable(availabilityOf(slot)) || fingerprintChanged(slot))) {
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
      slot.failedAt = isSelectable(availability) ? null : now();
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

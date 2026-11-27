import type { Pm } from "../shared/domain.ts";
import type { Ledger } from "../shared/ledger.ts";
import type { ModelCatalogs } from "./driver/model-catalog.ts";

export interface FirstRunPmOptions {
  ledger: Pick<Ledger, "createPm">;
  models: Pick<ModelCatalogs, "list" | "availability">;
  hasAnyPm: () => boolean;
  defaultModel: string | undefined;
  /** Defaults to VENDOR_RECHECK_BUDGET_MS. */
  probeBudgetMs?: number;
  log: (line: string) => void;
}

/**
 * Creates the project manager a fresh data directory starts with.
 * Precondition: called once during daemon startup, before the UI server accepts requests.
 * Postcondition: returns null without probing when hasAnyPm() is true. Otherwise waits at most probeBudgetMs
 * for vendor probes, creates one PM whose vendor is defaultPmVendor(models.availability), and drops
 * defaultModel (with a log line) when that vendor rejects it.
 */
export async function ensureFirstRunPm(options: FirstRunPmOptions): Promise<Pm | null> {
  void options;
  throw new Error("Not implemented");
}

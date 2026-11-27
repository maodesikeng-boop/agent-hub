import { DEFAULT_PM_MODE, type Pm } from "../shared/domain.ts";
import type { Ledger } from "../shared/ledger.ts";
import { ENV_DEFAULT_MODEL, VENDOR_RECHECK_BUDGET_MS } from "../shared/limits.ts";
import { LOG_PREFIX } from "../shared/names.ts";
import { AGENT_VENDORS, checkAgentSetting, defaultPmVendor } from "../shared/vendors.ts";
import type { ModelCatalogs } from "./driver/model-catalog.ts";
import { DEFAULT_PM_NAME } from "./prompt.ts";

export interface FirstRunPmOptions {
  ledger: Pick<Ledger, "createPm">;
  models: Pick<ModelCatalogs, "list" | "availability"> & Partial<Pick<ModelCatalogs, "current">>;
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
  if (options.hasAnyPm()) return null;
  const { models } = options;
  if (AGENT_VENDORS.some((vendor) => models.availability(vendor) === "unknown")) {
    await waitForProbes(models, options.probeBudgetMs ?? VENDOR_RECHECK_BUDGET_MS, options.log);
  }
  const vendor = defaultPmVendor((v) => models.availability(v));
  let defaultModel = options.defaultModel?.trim() || undefined;
  const catalog = models.current?.(vendor) ?? null;
  const badModel = defaultModel === undefined ? null : checkAgentSetting({ vendor, model: defaultModel, effort: null }, catalog);
  if (badModel !== null) {
    options.log(`${LOG_PREFIX} ${ENV_DEFAULT_MODEL}=${JSON.stringify(defaultModel)} 不能用（${badModel}），项目经理按默认模型建`);
    defaultModel = undefined;
  }
  const { pm } = options.ledger.createPm({
    name: DEFAULT_PM_NAME,
    mode: DEFAULT_PM_MODE,
    persona: "",
    vendor,
    ...(defaultModel ? { defaultModel } : {}),
  });
  options.log(`${LOG_PREFIX} 第一次启动，建了项目经理“${pm.name}”（${pm.vendor}）`);
  return pm;
}

async function waitForProbes(models: Pick<ModelCatalogs, "list">, budgetMs: number, log: (line: string) => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  const probes = models.list().then(
    () => undefined,
    (error: unknown) => log(`${LOG_PREFIX} 第一次启动探测厂商失败：${String(error)}`),
  );
  try {
    await Promise.race([probes, budget]);
  } finally {
    clearTimeout(timer);
  }
}

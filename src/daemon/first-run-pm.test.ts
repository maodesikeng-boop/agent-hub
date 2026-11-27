import { describe, expect, it, vi } from "vitest";
import { VENDOR_RECHECK_BUDGET_MS } from "../shared/limits.ts";
import type { CreatePmInput, CreatePmResult } from "../shared/ledger.ts";
import { bundledModelCatalog, type AgentVendor, type ModelCatalog, type VendorAvailability } from "../shared/vendors.ts";
import { ensureFirstRunPm, type FirstRunPmOptions } from "./first-run-pm.ts";

function harness(opts: {
  before: (vendor: AgentVendor) => VendorAvailability;
  after?: (vendor: AgentVendor) => VendorAvailability;
  probeMs?: number;
  hasAnyPm?: boolean;
  defaultModel?: string;
}) {
  let probed = false;
  const created: CreatePmInput[] = [];
  const createPm = vi.fn((input: CreatePmInput): CreatePmResult => {
    created.push(input);
    return { pm: { id: 1, name: input.name, vendor: input.vendor ?? "claude" } } as unknown as CreatePmResult;
  });
  const availability = (vendor: AgentVendor) => (probed ? (opts.after ?? opts.before) : opts.before)(vendor);
  const list = vi.fn(async (): Promise<ModelCatalog[]> => {
    await new Promise((resolve) => setTimeout(resolve, opts.probeMs ?? 0));
    probed = true;
    return [];
  });
  const lines: string[] = [];
  const options: FirstRunPmOptions = {
    ledger: { createPm },
    models: { list, availability },
    hasAnyPm: () => opts.hasAnyPm ?? false,
    defaultModel: opts.defaultModel,
    probeBudgetMs: 50,
    log: (line) => lines.push(line),
  };
  return { options, created, list, lines };
}

const codexOnly = (vendor: AgentVendor): VendorAvailability => (vendor === "codex" ? "available" : "not_installed");

describe("ensureFirstRunPm", () => {
  it("creates the first PM on the only installed vendor (Codex only)", async () => {
    const h = harness({ before: (v) => (v === "codex" ? "unknown" : "not_installed"), after: codexOnly });
    await ensureFirstRunPm(h.options);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.vendor).toBe("codex");
  });

  it("uses probe results that arrive within the budget (Claude installed but signed out)", async () => {
    const h = harness({
      before: (v) => (v === "claude" || v === "codex" ? "unknown" : "not_installed"),
      after: (v) => (v === "claude" ? "signed_out" : codexOnly(v)),
      probeMs: 5,
    });
    vi.useFakeTimers();
    try {
      const done = ensureFirstRunPm(h.options);
      await vi.advanceTimersByTimeAsync(5);
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(h.created[0]!.vendor).toBe("codex");
  });

  it("does not wait past the budget for a slow probe", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ before: (v) => (v === "claude" || v === "codex" ? "unknown" : "not_installed"), probeMs: 60_000 });
      const done = ensureFirstRunPm(h.options);
      await vi.advanceTimersByTimeAsync(h.options.probeBudgetMs!);
      await done;
      expect(h.created[0]!.vendor).toBe("claude");
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits up to VENDOR_RECHECK_BUDGET_MS (4 s) when no budget is passed", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ before: (v) => (v === "codex" ? "unknown" : "not_installed"), probeMs: 60_000 });
      const { probeBudgetMs: _omit, ...options } = h.options;
      const done = ensureFirstRunPm(options);
      await vi.advanceTimersByTimeAsync(VENDOR_RECHECK_BUDGET_MS - 1);
      expect(h.created).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(h.created[0]!.vendor).toBe("codex");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the registry default when nothing is installed", async () => {
    const h = harness({ before: () => "not_installed" });
    await ensureFirstRunPm(h.options);
    expect(h.created[0]!.vendor).toBe("claude");
  });

  it("checks the default-model environment variable against the chosen vendor", async () => {
    const model = bundledModelCatalog("codex").models[0]!.id;
    const h = harness({ before: codexOnly, defaultModel: model });
    await ensureFirstRunPm(h.options);
    expect(h.created[0]).toMatchObject({ vendor: "codex", defaultModel: model });

    const bad = harness({ before: codexOnly, defaultModel: "-bad" });
    await ensureFirstRunPm(bad.options);
    expect(bad.created[0]!.defaultModel).toBeUndefined();
    expect(bad.lines.join("\n")).toContain("-bad");
  });

  it("does nothing on later starts", async () => {
    const h = harness({ before: codexOnly, hasAnyPm: true });
    expect(await ensureFirstRunPm(h.options)).toBeNull();
    expect(h.created).toHaveLength(0);
    expect(h.list).not.toHaveBeenCalled();
  });
});

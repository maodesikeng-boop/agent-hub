import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";
import { createModelCatalogs } from "../../daemon/driver/model-catalog.ts";
import {
  AGENT_VENDORS,
  CODEX_MODELS_CACHE_FALLBACK_MAX_AGE_MS,
  MAX_CODEX_MODELS_CACHE_BYTES,
  MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS,
  MODEL_CATALOG_FRESH_MS,
  MODEL_CATALOG_RETRY_MS,
  bundledModelCatalog,
  type AgentVendor,
} from "../../shared/index.ts";
import {
  codexCatalogProbe,
  isCodexRemoteRefreshFailure,
  parseCodexModels,
  queryCodexCatalog,
  readCodexModelsCacheFallback,
} from "./catalog.ts";

// Captured from real codex-cli 0.169.0 ~/.codex/models_cache.json (2026-11-28).
const REAL_CODEX_MODELS_CACHE = {
  fetched_at: "2026-11-28T05:39:07.000000Z",
  etag: 'W/"68b097fea583c2572ad32d3ea291b751"',
  client_version: "0.169.0",
  models: [
    {
      slug: "gpt-6.1-sol",
      display_name: "GPT-6.1-Sol",
      description: "Previous generation model for coding and everyday work.",
      visibility: "list",
      supported_in_api: true,
      priority: 5,
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
        { effort: "ultra" },
      ],
    },
    {
      slug: "gpt-6.2-astra",
      display_name: "GPT-6.2-Astra",
      description: "Our most capable model for complex coding and professional work.",
      visibility: "list",
      supported_in_api: true,
      priority: 2,
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
        { effort: "ultra" },
      ],
    },
    {
      slug: "gpt-reserve",
      display_name: "GPT-Reserve",
      description: "Internal hidden model.",
      visibility: "hide",
      supported_in_api: true,
      priority: 4,
    },
    {
      slug: "gpt-6.2-sol",
      display_name: "GPT-6.2-Sol",
      description: "Fast, go-to model for coding and everyday work.",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
        { effort: "ultra" },
      ],
    },
    {
      slug: "codex-auto-review",
      display_name: "Codex Auto Review",
      visibility: "hide",
      supported_in_api: true,
      priority: 12,
    },
  ],
};

// Built-in 9-model static list returned by codex-cli 0.169.0 when remote model refresh fails.
const REAL_CODEX_BUILTIN_STATIC_MODELS = [
  {
    id: "gpt-6.1-sol",
    model: "gpt-6.1-sol",
    displayName: "GPT-6.1-Sol",
    description: "Latest workhorse model for coding and everyday work.",
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }, { reasoningEffort: "max" }, { reasoningEffort: "ultra" }],
  },
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Legacy coding model.",
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }],
  },
];

// Captured verbatim stderr lines from real codex-cli 0.169.0 with default RUST_LOG.
const REAL_CODEX_TIMEOUT_STDERR =
  "\x1B[2m2026-11-28T06:08:17.980589Z\x1B[0m \x1B[31mERROR\x1B[0m \x1B[2mcodex_models_manager::manager\x1B[0m\x1B[2m:\x1B[0m failed to refresh available models: request timed out\n";
const REAL_CODEX_403_STDERR =
  "\x1B[2m2026-11-28T06:09:06.764685Z\x1B[0m \x1B[31mERROR\x1B[0m \x1B[2mcodex_models_manager::manager\x1B[0m\x1B[2m:\x1B[0m failed to refresh available models: unexpected status 403 Forbidden: forbidden\n";

const CHATGPT_ACCOUNT = {
  account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
  requiresOpenaiAuth: true,
};

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFakeCodex(
  dir: string,
  options: { models: unknown; account?: unknown; stderr?: string },
): string {
  return writeExecutableNodeScript(
    join(dir, "codex"),
    `
const readline = require("node:readline");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    out({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "agent-hub/0.169.0" } });
  } else if (msg.method === "model/list") {
    ${options.stderr ? `process.stderr.write(${JSON.stringify(options.stderr)});` : ""}
    out({ jsonrpc: "2.0", id: msg.id, result: { data: ${JSON.stringify(options.models)} } });
  } else if (msg.method === "account/read") {
    out({ jsonrpc: "2.0", id: msg.id, result: ${JSON.stringify(options.account ?? CHATGPT_ACCOUNT)} });
  }
});
`,
  );
}

describe("Codex degraded catalog detection and recovery (new behavior)", () => {
  it("detects codex 0.169.0 remote model refresh failure lines with or without ANSI escapes", () => {
    expect(isCodexRemoteRefreshFailure(REAL_CODEX_TIMEOUT_STDERR)).toBe(true);
    expect(isCodexRemoteRefreshFailure(REAL_CODEX_403_STDERR)).toBe(true);
    expect(isCodexRemoteRefreshFailure("ERROR codex_models_manager::manager: failed to refresh available models: high demand")).toBe(true);
    expect(isCodexRemoteRefreshFailure("INFO codex_models_manager::cache: models cache: cache hit")).toBe(false);
    expect(isCodexRemoteRefreshFailure("")).toBe(false);
  });

  it("sorts models_cache.json entries by ascending priority and selects the lowest visible priority as default", () => {
    const parsed = parseCodexModels(REAL_CODEX_MODELS_CACHE);
    expect(parsed?.models.map((m) => m.id)).toEqual(["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol"]);
    expect(parsed?.defaultModelId).toBe("gpt-6.2-sol");
    expect(parsed?.defaultModel).toBe("GPT-6.2-Sol");
    expect(parsed?.defaultEfforts).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("reads bounded models_cache.json fallback only for eligible ChatGPT accounts and rejects stale, oversized, corrupt, or non-ChatGPT caches", () => {
    const nowMs = Date.parse("2026-11-28T06:10:00Z");
    const codexHome = makeTempDir("codex-cache-fallback-");
    const cacheFile = join(codexHome, "models_cache.json");
    const authFile = join(codexHome, "auth.json");

    writeFileSync(authFile, JSON.stringify({ auth_mode: "chatgpt" }));
    utimesSync(authFile, new Date(nowMs - 60_000), new Date(nowMs - 60_000));
    writeFileSync(cacheFile, JSON.stringify(REAL_CODEX_MODELS_CACHE));
    utimesSync(cacheFile, new Date(nowMs - 10_000), new Date(nowMs - 10_000));

    const ok = readCodexModelsCacheFallback({ codexHome, account: CHATGPT_ACCOUNT, nowMs });
    expect(parseCodexModels(ok)?.models.map((m) => m.id)).toEqual(["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol"]);

    expect(readCodexModelsCacheFallback({ codexHome, account: { account: null, requiresOpenaiAuth: true }, nowMs })).toBeNull();
    expect(readCodexModelsCacheFallback({ codexHome, account: { account: { type: "apiKey" }, requiresOpenaiAuth: true }, nowMs })).toBeNull();
    expect(readCodexModelsCacheFallback({ codexHome, account: { account: { type: "amazonBedrock" }, requiresOpenaiAuth: false }, nowMs })).toBeNull();

    utimesSync(authFile, new Date(nowMs), new Date(nowMs));
    expect(readCodexModelsCacheFallback({ codexHome, account: CHATGPT_ACCOUNT, nowMs })).toBeNull();

    utimesSync(authFile, new Date(nowMs - 60_000), new Date(nowMs - 60_000));
    const expiredCache = {
      ...REAL_CODEX_MODELS_CACHE,
      fetched_at: new Date(nowMs - CODEX_MODELS_CACHE_FALLBACK_MAX_AGE_MS - 1_000).toISOString(),
    };
    writeFileSync(cacheFile, JSON.stringify(expiredCache));
    utimesSync(cacheFile, new Date(nowMs - 10_000), new Date(nowMs - 10_000));
    expect(readCodexModelsCacheFallback({ codexHome, account: CHATGPT_ACCOUNT, nowMs })).toBeNull();

    writeFileSync(cacheFile, "{truncated-json");
    utimesSync(cacheFile, new Date(nowMs - 10_000), new Date(nowMs - 10_000));
    expect(readCodexModelsCacheFallback({ codexHome, account: CHATGPT_ACCOUNT, nowMs })).toBeNull();

    writeFileSync(cacheFile, JSON.stringify(REAL_CODEX_MODELS_CACHE));
    utimesSync(cacheFile, new Date(nowMs - 10_000), new Date(nowMs - 10_000));
    expect(readCodexModelsCacheFallback({ codexHome, account: CHATGPT_ACCOUNT, nowMs, maxBytes: 128 })).toBeNull();
    expect(MAX_CODEX_MODELS_CACHE_BYTES).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  });

  it("queryCodexCatalog recovers gpt-6.2-sol and gpt-6.2-astra from models_cache.json and marks degraded when model/list logs a refresh timeout", async () => {
    const root = makeTempDir("codex-degraded-query-");
    const codexHome = join(root, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const now = new Date();
    const authFile = join(codexHome, "auth.json");
    const cacheFile = join(codexHome, "models_cache.json");
    writeFileSync(authFile, JSON.stringify({ auth_mode: "chatgpt" }));
    utimesSync(authFile, new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));
    writeFileSync(cacheFile, JSON.stringify({ ...REAL_CODEX_MODELS_CACHE, fetched_at: now.toISOString() }));
    utimesSync(cacheFile, now, now);

    const codexPath = writeFakeCodex(root, {
      models: REAL_CODEX_BUILTIN_STATIC_MODELS,
      account: CHATGPT_ACCOUNT,
      stderr: REAL_CODEX_TIMEOUT_STDERR,
    });
    const raw = await queryCodexCatalog({
      codexPath,
      cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: codexHome },
    });

    expect(raw.degraded).toBe(true);
    expect(codexCatalogProbe.isDegraded?.(raw)).toBe(true);
    const catalog = codexCatalogProbe.parse(raw);
    expect(catalog?.models.map((m) => m.id)).toContain("gpt-6.2-sol");
    expect(catalog?.models.map((m) => m.id)).toContain("gpt-6.2-astra");
    expect(catalog?.models.map((m) => m.id)).not.toContain("gpt-5.5");
    expect(catalog?.defaultModelId).toBe("gpt-6.2-sol");
  });

  it("queryCodexCatalog still marks degraded when remote refresh fails and no models_cache.json exists", async () => {
    const root = makeTempDir("codex-degraded-nocache-");
    const codexHome = join(root, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const codexPath = writeFakeCodex(root, {
      models: REAL_CODEX_BUILTIN_STATIC_MODELS,
      account: CHATGPT_ACCOUNT,
      stderr: REAL_CODEX_403_STDERR,
    });
    const raw = await queryCodexCatalog({
      codexPath,
      cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: codexHome },
    });

    expect(raw.degraded).toBe(true);
    expect(codexCatalogProbe.isDegraded?.(raw)).toBe(true);
    expect(codexCatalogProbe.parse(raw)?.models.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-5.5"]);
  });
});

describe("Cross-vendor ModelCatalogs degradation and input-change semantics (new behavior)", () => {
  it.each(AGENT_VENDORS)(
    "%s preserves an existing live catalog across a degraded refresh and retries a degraded cold start at MODEL_CATALOG_RETRY_MS",
    async (vendor: AgentVendor) => {
      let now = 1_000_000;
      const responses: Array<{ id: string; degraded: boolean }> = [
        { id: "degraded-cold", degraded: true },
        { id: "live-v1", degraded: false },
        { id: "degraded-blip", degraded: true },
        { id: "live-v2", degraded: false },
      ];
      const query = vi.fn(async () => responses.shift()!);
      const catalogs = createModelCatalogs({
        sources: {
          [vendor]: {
            query,
            parse: (raw: unknown) => {
              const r = raw as { id: string };
              return { ...bundledModelCatalog(vendor), source: "vendor", defaultModelId: r.id };
            },
            isDegraded: (raw: unknown) => (raw as { degraded?: boolean }).degraded === true,
          },
        },
        now: () => now,
      });
      onTestFinished(() => catalogs.close());

      const first = (await catalogs.list({ vendor }))[0]!;
      expect(first.defaultModelId).toBe("degraded-cold");
      expect(query).toHaveBeenCalledTimes(1);

      now += MODEL_CATALOG_RETRY_MS - 1;
      expect((await catalogs.list({ vendor }))[0]?.defaultModelId).toBe("degraded-cold");
      expect(query).toHaveBeenCalledTimes(1);

      now += 1;
      await catalogs.list({ vendor });
      await expect.poll(() => catalogs.current(vendor)?.defaultModelId).toBe("live-v1");
      expect(query).toHaveBeenCalledTimes(2);

      // A degraded explicit refresh must NOT overwrite the existing live catalog.
      const afterDegradedRefresh = (await catalogs.list({ vendor, refresh: true }))[0]!;
      expect(afterDegradedRefresh.defaultModelId).toBe("live-v1");
      expect(query).toHaveBeenCalledTimes(3);

      // Because the refresh degraded, a retry runs after MODEL_CATALOG_RETRY_MS (well before 6h MODEL_CATALOG_FRESH_MS).
      now += MODEL_CATALOG_RETRY_MS;
      await catalogs.list({ vendor });
      await expect.poll(() => catalogs.current(vendor)?.defaultModelId).toBe("live-v2");
      expect(query).toHaveBeenCalledTimes(4);
    },
  );

  it.each(AGENT_VENDORS)(
    "%s invokes onInputsChanged when the vendor input fingerprint changes so sibling caches invalidate",
    async (vendor: AgentVendor) => {
      let now = 5_000_000;
      let fpInputs = "acct-a";
      const changed: AgentVendor[] = [];
      const catalogs = createModelCatalogs({
        sources: {
          [vendor]: {
            query: async () => fpInputs,
            parse: (raw: unknown) => ({ ...bundledModelCatalog(vendor), source: "vendor", defaultModelId: String(raw) }),
            fingerprint: () => ({ inputs: fpInputs, probeState: "" }),
          },
        },
        now: () => now,
        onInputsChanged: (v) => changed.push(v),
      });
      onTestFinished(() => catalogs.close());

      await catalogs.list({ vendor });
      expect(changed).toEqual([]);

      fpInputs = "acct-b";
      now += MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS;
      expect((await catalogs.list({ vendor }))[0]?.defaultModelId).toBe("acct-b");
      expect(changed).toEqual([vendor]);
    },
  );
});

describe("Codex catalog regression checks (unchanged existing rules)", () => {
  it("parses healthy model/list payloads with explicit isDefault unchanged", () => {
    const parsed = parseCodexModels({ data: REAL_CODEX_BUILTIN_STATIC_MODELS });
    expect(parsed?.defaultModelId).toBe("gpt-6.1-sol");
    expect(parsed?.models.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-5.5"]);
  });

  it("healthy queryCodexCatalog without refresh error omits degraded and returns live models", async () => {
    const root = makeTempDir("codex-healthy-query-");
    const codexPath = writeFakeCodex(root, {
      models: [
        { id: "gpt-6.2-sol", displayName: "GPT-6.2-Sol", isDefault: true, hidden: false },
        { id: "gpt-6.2-astra", displayName: "GPT-6.2-Astra", isDefault: false, hidden: false },
      ],
      account: CHATGPT_ACCOUNT,
    });
    const raw = await queryCodexCatalog({ codexPath, cwd: root });
    expect(raw.degraded).toBeUndefined();
    expect(codexCatalogProbe.isDegraded?.(raw)).toBe(false);
    expect(codexCatalogProbe.parse(raw)?.defaultModelId).toBe("gpt-6.2-sol");
  });

  it("healthy non-degraded catalog remains cached across MODEL_CATALOG_FRESH_MS minus 1ms", async () => {
    let now = 2_000_000;
    const query = vi.fn(async () => ({ models: REAL_CODEX_BUILTIN_STATIC_MODELS, account: CHATGPT_ACCOUNT }));
    const catalogs = createModelCatalogs({
      sources: { codex: { ...codexCatalogProbe, query } },
      now: () => now,
    });
    onTestFinished(() => catalogs.close());

    await catalogs.list({ vendor: "codex" });
    now += MODEL_CATALOG_FRESH_MS - 1;
    await catalogs.list({ vendor: "codex" });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

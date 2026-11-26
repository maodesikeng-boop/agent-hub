import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_VENDORS, API_PATHS, vendorSpec, type AgentVendor, type ModelsResponse, type ProvidersStatusResponse } from "../../shared/index.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import { runShortSubcommand } from "../../vendors/_common/setup/file-helpers.ts";
import { createModelCatalogs, type VendorCatalogSource } from "../driver/model-catalog.ts";
import { removeTreeWithRetry } from "../platform/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { FakeLedger } from "../ui-server/fake-ledger.ts";
import { createUiServer } from "../ui-server/server.ts";
import { testLogin } from "../ui-server/test-login.ts";
import { createManagedProviderSecrets, createProviderManager, createVendorRuntimeResolver } from "./index.ts";

let home: string;

vi.mock(import("../../vendors/_common/setup/file-helpers.ts"), async (original) => ({
  ...await original(),
  runShortSubcommand: vi.fn(),
}));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bellwood-provider-status-"));
  vi.mocked(runShortSubcommand).mockReset();
});

afterEach(() => removeTreeWithRetry(home));

function setup(sources: Record<AgentVendor, VendorCatalogSource>, versionOutput: (vendor: AgentVendor) => string) {
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
  const binaries = new Map<string, AgentVendor>();
  for (const vendor of AGENT_VENDORS) {
    const binary = join(home, vendor);
    writeFileSync(binary, "");
    env[vendorSpec(vendor).cli.envVar] = binary;
    binaries.set(binary, vendor);
  }
  const probes: AgentVendor[] = [];
  vi.mocked(runShortSubcommand).mockImplementation(async (program, args) => {
    const vendor = binaries.get(program);
    if (vendor === undefined || args.join(" ") !== "--version") {
      return { code: 1, stdout: "", stderr: "" };
    }
    probes.push(vendor);
    return { code: 0, stdout: versionOutput(vendor), stderr: "" };
  });
  const paths = resolveHubPaths(env, home, { home: join(home, "hub") });
  const secrets = createManagedProviderSecrets(paths.providerSecretsFile);
  const runtime = createVendorRuntimeResolver({ paths, userHome: home, baseEnv: env, secrets });
  const models = createModelCatalogs({ sources });
  const providers = createProviderManager({ runtime, models });
  const db = openTestDb();
  const port = 4391;
  const app = createUiServer({
    ledger: new FakeLedger().asLedger(),
    token: "secret-ui-token-0123456789abcdef",
    db,
    port,
    uploadsDir: paths.uploadsDir,
    sentFilesDir: paths.sentFilesDir,
    staticDir: join(home, "no-static"),
    models,
    providers,
  });
  const client = testLogin(db, port);
  return {
    secrets,
    probes,
    async get<T>(url: string): Promise<T> {
      const res = await app.inject({ method: "GET", url, headers: { host: `127.0.0.1:${port}`, cookie: client.cookie() } });
      expect(res.statusCode).toBe(200);
      return res.json<T>();
    },
    async close() {
      await providers.close();
      await models.close();
      await app.close();
      db.close();
    },
  };
}

function sourcesWith(source: VendorCatalogSource): Record<AgentVendor, VendorCatalogSource> {
  return Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, source])) as Record<AgentVendor, VendorCatalogSource>;
}

describe("Providers status", () => {
  it("reports installed CLI versions on the first ordinary GET", async () => {
    const versions: Partial<Record<AgentVendor, string>> = { cursor: "2026.11.22-e9042b2", kimi: "2.7.2" };
    const app = setup(sourcesWith({ query: async () => null, parse: () => null }), (vendor) => versions[vendor] ?? "1.2.3");
    try {
      const { providers } = await app.get<ProvidersStatusResponse>(API_PATHS.providers);
      expect(providers.map(({ vendor, installed, version }) => ({ vendor, installed, version }))).toEqual(
        AGENT_VENDORS.map((vendor) => ({ vendor, installed: true, version: versions[vendor] ?? "1.2.3" })),
      );
      expect((await app.get<ProvidersStatusResponse>(API_PATHS.providers)).providers).toEqual(providers);
      expect(app.probes.sort()).toEqual([...AGENT_VENDORS].sort());
    } finally {
      await app.close();
    }
  });

  it("uses the catalog availability even when local account details exist", async () => {
    const query = vi.fn(async () => null);
    const app = setup(sourcesWith({ query, parse: () => null, availabilityOf: () => "signed_out" }), () => "1.2.3");
    try {
      app.secrets.set("claude", { ANTHROPIC_API_KEY: "test-key" });
      const { providers } = await app.get<ProvidersStatusResponse>(API_PATHS.providers);
      const { catalogs } = await app.get<ModelsResponse>(API_PATHS.models);
      expect(catalogs.every(({ availability }) => availability === "signed_out")).toBe(true);
      expect(providers.map(({ vendor, availability }) => ({ vendor, availability }))).toEqual(
        catalogs.map(({ vendor, availability }) => ({ vendor, availability })),
      );
      expect(providers.find(({ vendor }) => vendor === "claude")).toMatchObject({
        availability: "signed_out",
        accountSummary: "API key configured",
        canSignOut: true,
      });
      expect(query).toHaveBeenCalledTimes(AGENT_VENDORS.length);
    } finally {
      await app.close();
    }
  });
});

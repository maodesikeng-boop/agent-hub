import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { AGENT_VENDORS, MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS, type AgentVendor, bundledModelCatalog } from "../../shared/index.ts";
import { createVendorCatalogSources } from "../vendors/index.ts";
import { createModelCatalogs } from "./model-catalog.ts";

const files: Record<AgentVendor, string> = {
  agy: ".gemini/antigravity-cli/settings.json",
  claude: ".claude/settings.json",
  codex: ".codex/config.toml",
  cursor: ".cursor/cli-config.json",
  deepseek: ".dsh/.env",
  kimi: ".kimi-code/config.toml",
  opencode: ".config/opencode/opencode.json",
  pi: ".pi/agent/models.json",
};

function catalogFile(vendor: AgentVendor) {
  const cwd = mkdtempSync(join(tmpdir(), "hub-catalog-invalidation-"));
  onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  const file = join(cwd, files[vendor]);
  mkdirSync(dirname(file), { recursive: true });
  const path = process.execPath;
  const options = { path, cwd, installed: () => true, env: { HOME: cwd, USERPROFILE: cwd } };
  const sources = createVendorCatalogSources(Object.fromEntries(AGENT_VENDORS.map((v) => [v, options])) as Record<AgentVendor, typeof options>);
  const source = sources[vendor];
  if (!source) throw new Error(`Missing catalog source for ${vendor}`);
  const parse = (raw: unknown) => typeof raw === "string" && raw !== "" ? { ...bundledModelCatalog(vendor), defaultModelId: raw } : null;
  return { ...source, cwd, file, parse, availabilityOf: () => "available" as const };
}

function gate() {
  let open = () => {};
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

it.each(AGENT_VENDORS)("%s invalidates a fresh catalog after its config is replaced with the same mtime and size", async (vendor) => {
  const source = catalogFile(vendor);
  const stamp = new Date(1_600_000_000_000);
  const replacement = `${source.file}.new`;
  writeFileSync(source.file, "model-a");
  utimesSync(source.file, stamp, stamp);
  let now = 0;
  const query = vi.fn(async () => readFileSync(source.file, "utf8"));
  const catalogs = createModelCatalogs({ sources: { [vendor]: { ...source, query } }, now: () => now });
  onTestFinished(() => catalogs.close());
  expect((await catalogs.list({ vendor }))[0]?.defaultModelId).toBe("model-a");

  writeFileSync(replacement, "model-b");
  utimesSync(replacement, stamp, stamp);
  renameSync(replacement, source.file);
  now += MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS;
  expect((await catalogs.list({ vendor }))[0]?.defaultModelId).toBe("model-b");
  expect(query).toHaveBeenCalledTimes(2);
});

it.each(["settings.json", "antigravity-oauth-token"])("invalidates Antigravity's catalog after an in-place edit of %s", async (name) => {
  const source = catalogFile("agy");
  const file = join(dirname(source.file), name);
  writeFileSync(file, "old-model");
  let now = 0;
  const query = vi.fn(async () => readFileSync(file, "utf8"));
  const catalogs = createModelCatalogs({ sources: { agy: { ...source, query } }, now: () => now });
  onTestFinished(() => catalogs.close());
  expect((await catalogs.list({ vendor: "agy" }))[0]?.defaultModelId).toBe("old-model");
  writeFileSync(file, "new-provider-model");
  now += MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS;
  expect((await catalogs.list({ vendor: "agy" }))[0]?.defaultModelId).toBe("new-provider-model");
  expect(query).toHaveBeenCalledTimes(2);
});

it.each([
  { vendor: "agy", statePath: ".gemini/antigravity-cli/cli.log" },
  { vendor: "claude", statePath: ".claude.json" },
  { vendor: "codex", statePath: ".codex/models_cache.json" },
  { vendor: "pi", statePath: ".pi/agent/auth.json" },
  { vendor: "pi", statePath: ".pi/agent/models-store.json" },
] as const)("$vendor keeps the live catalog when discovery writes $statePath", async ({ vendor, statePath }) => {
  const source = catalogFile(vendor);
  const stateFile = join(source.cwd, statePath);
  let now = 0;
  let writes = 0;
  const query = vi.fn(async () => {
    const temp = `${stateFile}.new`;
    writeFileSync(temp, String(++writes));
    renameSync(temp, stateFile);
    if (vendor === "agy") utimesSync(dirname(stateFile), writes, writes);
    return "live-model";
  });
  const catalogs = createModelCatalogs({ sources: { [vendor]: { ...source, query } }, now: () => now });
  onTestFinished(() => catalogs.close());
  expect((await catalogs.list({ vendor }))[0]?.defaultModelId).toBe("live-model");
  now += MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS;
  expect((await catalogs.list({ vendor }))[0]?.defaultModelId).toBe("live-model");
  expect(query).toHaveBeenCalledOnce();

  writeFileSync(stateFile, "different state written between probes");
  now += MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS;
  await catalogs.list({ vendor });
  expect(query).toHaveBeenCalledTimes(vendor === "agy" ? 1 : 2);
});

it("reads current configuration before rechecking a signed-out catalog during the fingerprint cooldown", async () => {
  const source = catalogFile("codex");
  writeFileSync(source.file, "old-model");
  const query = vi.fn(async () => readFileSync(source.file, "utf8"));
  const catalogs = createModelCatalogs({ sources: { codex: { ...source, query } }, now: () => 0 });
  onTestFinished(() => catalogs.close());
  await catalogs.list({ vendor: "codex" });
  catalogs.report("codex", "signed_out");
  writeFileSync(source.file, "new-provider-model");
  expect((await catalogs.list({ vendor: "codex", refresh: "unusable" }))[0]?.defaultModelId).toBe("new-provider-model");
  expect(query).toHaveBeenCalledTimes(2);
});

it.each(["list", "ensureUsable"])("%s explicitly rechecks a signed-out vendor with no catalog during passive backoff", async (method) => {
  const source = catalogFile("codex");
  const vendor = "codex";
  const query = vi.fn(async () => "live-model").mockRejectedValueOnce(new Error("sign in"));
  const catalogs = createModelCatalogs({
    sources: { codex: { ...source, query, availabilityOfError: () => "signed_out" } },
    now: () => 0,
  });
  onTestFinished(() => catalogs.close());
  expect((await catalogs.list({ vendor }))[0]?.availability).toBe("signed_out");
  expect(catalogs.current(vendor)).toBeNull();
  expect((await catalogs.list({ vendor }))[0]?.availability).toBe("signed_out");
  expect(query).toHaveBeenCalledOnce();

  const availability = method === "list"
    ? (await catalogs.list({ vendor, refresh: "unusable" }))[0]?.availability
    : await catalogs.ensureUsable(vendor);
  expect(availability).toBe("available");
  expect(catalogs.current(vendor)?.defaultModelId).toBe("live-model");
  expect(query).toHaveBeenCalledTimes(2);
});

it("does not associate a Codex reply with configuration changed while the probe was reading it", async () => {
  const source = catalogFile("codex");
  writeFileSync(source.file, "proxy-model");
  const read = gate();
  const reply = gate();
  const query = vi.fn(async () => readFileSync(source.file, "utf8")).mockImplementationOnce(async () => {
    const model = readFileSync(source.file, "utf8");
    read.open();
    await reply.wait;
    return model;
  });
  const catalogs = createModelCatalogs({ sources: { codex: { ...source, query } }, now: () => 0 });
  onTestFinished(() => catalogs.close());
  const listing = catalogs.list({ vendor: "codex" });
  await read.wait;
  writeFileSync(source.file, "native-model");
  writeFileSync(join(dirname(source.file), "models_cache.json"), "{}");
  reply.open();
  expect((await listing)[0]?.defaultModelId).toBe("native-model");
  expect((await catalogs.list({ vendor: "codex" }))[0]?.defaultModelId).toBe("native-model");
  expect(query).toHaveBeenCalledTimes(2);
});

it("does not return the old provider's catalog when discovery fails after a config edit", async () => {
  const source = catalogFile("codex");
  writeFileSync(source.file, "proxy-model");
  let now = 0;
  const query = vi.fn(async () => "").mockResolvedValueOnce("proxy-model");
  const catalogs = createModelCatalogs({ sources: { codex: { ...source, query } }, now: () => now });
  onTestFinished(() => catalogs.close());
  expect((await catalogs.list({ vendor: "codex" }))[0]?.defaultModelId).toBe("proxy-model");
  writeFileSync(source.file, "native-model");
  now += MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS;
  expect((await catalogs.list({ vendor: "codex" }))[0]?.defaultModelId).toBeNull();
  expect(catalogs.current("codex")).toBeNull();
  await catalogs.list({ vendor: "codex" });
  expect(query).toHaveBeenCalledTimes(2);
});

it.each(["empty", "failed"])("retries after a %s refresh even when the last good catalog is fresh", async (failure) => {
  let now = 0;
  const query = vi.fn(async () => "recovered").mockResolvedValueOnce("initial");
  if (failure === "empty") query.mockResolvedValueOnce("");
  else query.mockRejectedValueOnce(new Error("offline"));
  const catalogs = createModelCatalogs({
    sources: { codex: {
      query,
      parse: (raw) => typeof raw === "string" && raw !== "" ? { ...bundledModelCatalog("codex"), defaultModelId: raw } : null,
      availabilityOfError: () => "signed_out",
    } },
    now: () => now,
  });
  onTestFinished(() => catalogs.close());
  await catalogs.list({ vendor: "codex" });
  await catalogs.list({ vendor: "codex", refresh: true });
  now += 29_999;
  expect((await catalogs.list({ vendor: "codex" }))[0]?.defaultModelId).toBe("initial");
  expect(query).toHaveBeenCalledTimes(2);
  now++;
  await catalogs.list({ vendor: "codex" });
  expect(query).toHaveBeenCalledTimes(3);
  expect((await catalogs.list({ vendor: "codex" }))[0]?.defaultModelId).toBe("recovered");
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHubPaths } from "../../shared/paths.ts";
import { AGY_FORCE_FILE_TOKEN_STORAGE_ENV, AGY_MACOS_LOGIN_KEYCHAIN_REL } from "../../vendors/agy/paths.ts";
import { createManagedProviderSecrets } from "./secrets-store.ts";
import { createVendorRuntimeResolver } from "./runtime-resolver.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeResolver(platform: string, withLoginKeychain: boolean) {
  const root = mkdtempSync(join(tmpdir(), "bellwood-runtime-resolver-"));
  dirs.push(root);
  const dataDir = join(root, "data");
  const userHome = join(root, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  if (withLoginKeychain) {
    const kc = join(userHome, AGY_MACOS_LOGIN_KEYCHAIN_REL);
    mkdirSync(join(userHome, "Library", "Keychains"), { recursive: true });
    writeFileSync(kc, "");
  }
  const paths = resolveHubPaths({ AGENT_HUB_HOME: dataDir }, userHome, { platform });
  const secrets = createManagedProviderSecrets(paths.providerSecretsFile);
  return createVendorRuntimeResolver({
    paths,
    userHome,
    baseEnv: { HOME: userHome, PATH: "/usr/bin:/bin" },
    platform,
    secrets,
  });
}

describe("createVendorRuntimeResolver runtimeEnv (acceptance S3/S12/S13)", () => {
  it("injects AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 for agy on macOS isolated HOME without login.keychain-db", () => {
    const resolver = makeResolver("darwin", false);
    expect(resolver.resolveVendorEnv("agy")[AGY_FORCE_FILE_TOKEN_STORAGE_ENV]).toBe("1");
    expect(resolver.resolveVendorEnv("claude")[AGY_FORCE_FILE_TOKEN_STORAGE_ENV]).toBeUndefined();
  });

  it("does not inject AGY_CLI_FORCE_FILE_TOKEN_STORAGE when login.keychain-db exists or on Linux", () => {
    expect(makeResolver("darwin", true).resolveVendorEnv("agy")[AGY_FORCE_FILE_TOKEN_STORAGE_ENV]).toBeUndefined();
    expect(makeResolver("linux", false).resolveVendorEnv("agy")[AGY_FORCE_FILE_TOKEN_STORAGE_ENV]).toBeUndefined();
  });
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VendorAvailability } from "../../shared/index.ts";
import type { ManagedProviderSecrets, VendorSetupContext } from "../daemon-types.ts";
import { claudeSetupAdapter } from "./setup.ts";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-setup-test-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function memorySecrets(initial: Record<string, string> = {}): ManagedProviderSecrets {
  const map = new Map(Object.entries(initial));
  return {
    keys: () => [...map.keys()],
    has: (_vendor, envName) => {
      const val = map.get(envName);
      return typeof val === "string" && val.trim() !== "";
    },
    getEnv: () => Object.fromEntries(map),
    set: (_vendor, entries) => {
      for (const [k, v] of Object.entries(entries)) map.set(k, v);
    },
    remove: (_vendor, names) => {
      if (!names) map.clear();
      else for (const name of names) map.delete(name);
    },
    fingerprint: () => String(map.size),
  };
}

function makeCtx(options: {
  availability: VendorAvailability;
  secrets?: Record<string, string>;
  env?: Record<string, string | undefined>;
}): VendorSetupContext {
  return {
    platform: process.platform,
    userHome: dir,
    availability: options.availability,
    executablePath: () => "/usr/local/bin/claude",
    installed: () => options.availability !== "not_installed",
    env: () => ({ HOME: dir, ...options.env }),
    secrets: memorySecrets(options.secrets),
  };
}

describe("claudeSetupAdapter.inspectAuth", () => {
  it("ignores leftover .claude.json oauthAccount and stale .credentials.json when availability is signed_out", async () => {
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "failed-login@example.com" } }),
    );
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", ".credentials.json"), JSON.stringify({ stale: true }));

    const inspected = await claudeSetupAdapter.inspectAuth(makeCtx({ availability: "signed_out" }));
    expect(inspected.accountSummary).toBeNull();
    expect(inspected.canSignOut).toBe(false);
  });

  it("does not trust .claude.json oauthAccount alone when availability is unknown and .credentials.json is absent", async () => {
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "stale@example.com" } }),
    );

    const inspected = await claudeSetupAdapter.inspectAuth(makeCtx({ availability: "unknown" }));
    expect(inspected.accountSummary).toBeNull();
    expect(inspected.canSignOut).toBe(false);
  });

  it("returns email summary and canSignOut when availability is available", async () => {
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "dev@example.com" } }),
    );

    const withEmail = await claudeSetupAdapter.inspectAuth(makeCtx({ availability: "available" }));
    expect(withEmail.accountSummary).toBe("dev@example.com");
    expect(withEmail.canSignOut).toBe(true);

    rmSync(join(dir, ".claude.json"));
    const withoutEmail = await claudeSetupAdapter.inspectAuth(makeCtx({ availability: "available" }));
    expect(withoutEmail.accountSummary).toBe("Signed in");
    expect(withoutEmail.canSignOut).toBe(true);
  });

  it("reports configured managed API key or OAuth token regardless of catalog availability", async () => {
    const apiKey = await claudeSetupAdapter.inspectAuth(
      makeCtx({ availability: "signed_out", secrets: { ANTHROPIC_API_KEY: "sk-ant-test" } }),
    );
    expect(apiKey.accountSummary).toBe("API key configured");
    expect(apiKey.canSignOut).toBe(true);

    const oauthToken = await claudeSetupAdapter.inspectAuth(
      makeCtx({ availability: "signed_out", secrets: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test" } }),
    );
    expect(oauthToken.accountSummary).toBe("Token configured");
    expect(oauthToken.canSignOut).toBe(true);
  });
});

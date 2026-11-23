import { describe, it } from "vitest";

describe("VENDOR_BENCH", () => {
  it.todo("has a recipe for every vendor in VENDOR_LIST");
  it.todo("names only models the vendor accepts (bundled, or custom when the vendor allows custom models)");
});

describe("installCommandFor and loginCommandFor", () => {
  it.todo("returns the product's installCommand, or windowsInstallCommand on win32");
  it.todo("throws for a vendor that ships no install command on the platform");
  it.todo("prefers the product's headlessLoginCommand and falls back to the spec's cli.loginCommand");
});

describe("installVendor", () => {
  it.todo("runs the install command with HOME and the npm global prefix inside the bench HOME");
  it.todo("reports install_failed with the exit code and the last 20 stderr lines");
});

describe("probeVendor", () => {
  it.todo("reports not_installed when the CLI does not resolve from the bench HOME and PATH, ignoring the developer's own tool directories");
  it.todo("reports signed_out when the CLI is installed but the daemon reports signed_out or the status command shows no account");
  it.todo("reports ready only when the CLI resolves, the daemon reports available, and the account is signed in");
  it.todo("names the fix command for every non-ready status");
  it.todo("starts no model turn");
});

describe("openGaps", () => {
  it.todo("returns every non-ready entry the owner has not accepted");
  it.todo("keeps accepted gaps out of the alert list while they stay in coverage");
});

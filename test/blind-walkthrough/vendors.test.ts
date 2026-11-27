import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VENDOR_LIST } from "../../src/vendors/registry.ts";
import { listBlindVendorSupport, parseBlindActionResponse, resolveBlindVendorAdapter } from "./vendors.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("vendors (S13, S14)", () => {
  it("S14: covers every registered AgentVendor in VENDOR_LIST with an explicit mode and reason", () => {
    const matrix = listBlindVendorSupport();
    const registeredIds = VENDOR_LIST.map((v) => v.id);
    expect(Object.keys(matrix).sort()).toEqual([...registeredIds].sort());

    for (const vendorId of registeredIds) {
      const entry = matrix[vendorId];
      expect(entry.vendor).toBe(vendorId);
      expect(["vision_cli", "a11y_cli", "unsupported"]).toContain(entry.mode);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("S14: resolves an adapter with an immutable systemPrompt for supported vendors", () => {
    const blindCwd = makeTempDir("blind-cwd-");
    const blindHome = makeTempDir("blind-home-");
    const systemPrompt = "You are a brand-new user testing an unfamiliar app.";
    const adapter = resolveBlindVendorAdapter({
      vendor: "claude",
      systemPrompt,
      blindCwd,
      blindHomeDir: blindHome,
    });

    expect(adapter.id).toBe("claude");
    expect(adapter.systemPrompt).toBe(systemPrompt);
  });

  it("S13: parses valid JSON responses and converts malformed or truncated vendor output into harness_noise without throwing", () => {
    const validJson = JSON.stringify({
      thought: "I see a button to create a new project.",
      confusion: null,
      action: { kind: "click_label", role: "button", label: "New Project" },
    });
    const parsedValid = parseBlindActionResponse(validJson);
    expect(parsedValid.ok).toBe(true);
    if (parsedValid.ok) {
      expect(parsedValid.response.action).toEqual({ kind: "click_label", role: "button", label: "New Project" });
    }

    const malformedCases = [
      "",
      "Sure! Here is what I would do next without JSON.",
      "{\"thought\":\"half-written",
      JSON.stringify({ thought: "missing action fields", confusion: null, action: { kind: "click_point" } }),
    ];
    for (const raw of malformedCases) {
      const parsed = parseBlindActionResponse(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.noiseReason.length).toBeGreaterThan(0);
      }
    }
  });
});

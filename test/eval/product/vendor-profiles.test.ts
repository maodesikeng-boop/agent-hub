import { describe, expect, it } from "vitest";
import { AGENT_VENDORS, type AgentVendor } from "../../../src/shared/vendors.ts";
import {
  buildVendorCoverageMatrix,
  getVendorEvalProfile,
  getVendorEvalProfiles,
  resolveVendorMockEnv,
} from "./vendor-profiles.ts";
import type {
  BaseUrlStrategy,
  MockModelProtocol,
  PromptCacheCheckKind,
  ReplaySupportKind,
  Tier1CoverageKind,
  VendorCoverageRow,
  VendorEvalProfile,
  VendorMockLaunchConfig,
} from "./types.ts";

describe("cross-vendor evaluation profiles", () => {
  it("registers an explicit profile and coverage row for every vendor in AGENT_VENDORS with zero silent skips", () => {
    const profiles: Readonly<Record<AgentVendor, VendorEvalProfile>> = getVendorEvalProfiles();
    const matrix: VendorCoverageRow[] = buildVendorCoverageMatrix(profiles);

    expect(Object.keys(profiles).sort()).toEqual([...AGENT_VENDORS].sort());
    expect(matrix.map((row) => row.vendor)).toEqual([...AGENT_VENDORS]);

    const validProtocols: readonly MockModelProtocol[] = [
      "anthropic_messages",
      "openai_responses",
      "openai_chat",
      "acp_fake",
      "unsupported",
    ];
    const validTier1: readonly Tier1CoverageKind[] = ["real_cli_mock_server", "fake_driver_contract"];
    const validCache: readonly PromptCacheCheckKind[] = ["prefix_and_key", "prefix_only", "live_cache_read_only"];
    const validReplay: readonly ReplaySupportKind[] = ["full", "driver_contract_only"];

    for (const vendor of AGENT_VENDORS) {
      const profile = getVendorEvalProfile(vendor);
      expect(profile.vendor).toBe(vendor);
      expect(validProtocols).toContain(profile.mockServerProtocol);
      expect(validTier1).toContain(profile.tier1Coverage);
      expect(validCache).toContain(profile.promptCacheCheck);
      expect(validReplay).toContain(profile.replaySupport);
      const strategy: BaseUrlStrategy = profile.baseUrlStrategy;
      if (profile.tier1Coverage === "fake_driver_contract") {
        expect(profile.gapReason).toBeTruthy();
      }
      if (strategy.kind === "none") {
        expect(strategy.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("builds isolated loopback mock launch configs for claude and codex without touching real user config", () => {
    const scratchHome = "/tmp/bellwood-eval-isolated-home";
    const loopbackUrl = "http://127.0.0.1:43999";

    const claudeLaunch: VendorMockLaunchConfig = resolveVendorMockEnv("claude", loopbackUrl, scratchHome);
    expect(claudeLaunch.supported).toBe(true);
    expect(claudeLaunch.env.ANTHROPIC_BASE_URL).toBe(loopbackUrl);
    expect(claudeLaunch.env.HOME).toBe(scratchHome);

    const codexLaunch = resolveVendorMockEnv("codex", loopbackUrl, scratchHome);
    expect(codexLaunch.supported).toBe(true);
    expect(codexLaunch.env.CODEX_HOME).toContain(scratchHome);
    expect(codexLaunch.configFiles.some((f) => f.relativePath.endsWith("config.toml") && f.content.includes(loopbackUrl))).toBe(true);

    // Non-loopback URLs must be rejected so mock tests can never leak credentials to external hosts.
    expect(() => resolveVendorMockEnv("claude", "https://api.example.com", scratchHome)).toThrow(RangeError);
  });
});

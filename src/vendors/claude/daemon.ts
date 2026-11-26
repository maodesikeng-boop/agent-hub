import { defineVendorDaemon } from "../daemon-types.ts";
import { claudeCapabilityDenyRules, claudeCapabilitySettings } from "./capabilities.ts";
import { claudeCatalogProbe, createClaudeCatalogSource, queryClaudeInitialize } from "./catalog.ts";
import { claudeComposerBase, createClaudeComposer } from "./composer.ts";
import { createClaudeDriver } from "./driver.ts";
import { CLAUDE_FORKERS } from "./handover.ts";
import { claudeQuotaScope, queryClaudeQuota } from "./quota.ts";
import { buildSessionSettings, sessionEnv } from "./settings.ts";
import { claudeSetupAdapter } from "./setup.ts";
import { claudeSyncAdapter } from "./sync.ts";
import { claudeTranscriptPath } from "./transcript.ts";

export default defineVendorDaemon({
  createDriver: (deps) => createClaudeDriver(deps),
  composer: { base: claudeComposerBase, create: (deps) => createClaudeComposer({ ...deps, queryInitialize: queryClaudeInitialize }) },
  catalog: { probe: claudeCatalogProbe, source: createClaudeCatalogSource },
  forkers: CLAUDE_FORKERS,
  transcriptPath: claudeTranscriptPath,
  capabilityLaunch: (caps) => ({ settings: claudeCapabilitySettings(caps), deny: claudeCapabilityDenyRules(caps) }),
  launchFiles: (input) => ({ settings: JSON.stringify(buildSessionSettings(input), null, 2) + "\n", env: sessionEnv(input.role) }),
  sync: claudeSyncAdapter,
  setup: claudeSetupAdapter,
  quotaScope: claudeQuotaScope,
  queryQuota: queryClaudeQuota,
});

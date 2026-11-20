import { defineVendorDaemon } from "../daemon-types.ts";
import { codexCapabilityArgs } from "./capabilities.ts";
import { codexCatalogProbe, createCodexCatalogSource } from "./catalog.ts";
import { codexComposerBase, createCodexComposer } from "./composer.ts";
import { createCodexDriver } from "./driver.ts";
import { CODEX_FORKERS } from "./handover.ts";
import { codexSetupAdapter } from "./setup.ts";
import { codexSyncAdapter } from "./sync.ts";
import { codexTranscriptPath } from "./transcript.ts";

export default defineVendorDaemon({
  createDriver: (deps) => createCodexDriver(deps),
  composer: { base: codexComposerBase, create: (deps) => createCodexComposer(deps) },
  catalog: { probe: codexCatalogProbe, source: createCodexCatalogSource },
  forkers: CODEX_FORKERS,
  transcriptPath: codexTranscriptPath,
  // codex always writes a rollout file for a session.
  sessionFiles: (ref, roots) => [codexTranscriptPath(ref, roots)].filter((file) => file !== null),
  capabilityLaunch: codexCapabilityArgs,
  sync: codexSyncAdapter,
  setup: codexSetupAdapter,
});

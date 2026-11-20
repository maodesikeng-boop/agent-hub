import { defineVendorDaemon } from "../daemon-types.ts";
import { agyCapabilityDenyRules } from "./capabilities.ts";
import { agyCatalogProbe, createAgyCatalogSource } from "./catalog.ts";
import { agyComposerBase, createAgyComposer } from "./composer.ts";
import { createAgyDriver } from "./driver.ts";
import { AGY_FORKERS } from "./handover.ts";
import { agySetupAdapter } from "./setup.ts";
import { agySyncAdapter } from "./sync.ts";
import { agySessionFiles, agyTranscriptPath } from "./transcript.ts";

export default defineVendorDaemon({
  createDriver: (deps) => createAgyDriver(deps),
  composer: { base: agyComposerBase, create: (deps) => createAgyComposer(deps) },
  catalog: { probe: agyCatalogProbe, source: createAgyCatalogSource },
  forkers: AGY_FORKERS,
  transcriptPath: agyTranscriptPath,
  sessionFiles: agySessionFiles,
  capabilityLaunch: agyCapabilityDenyRules,
  sync: agySyncAdapter,
  setup: agySetupAdapter,
});

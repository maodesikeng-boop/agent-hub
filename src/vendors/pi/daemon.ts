import { defineVendorDaemon } from "../daemon-types.ts";
import { piCapabilityArgs } from "./capabilities.ts";
import { createPiCatalogSource, piCatalogProbe } from "./catalog.ts";
import { createPiComposer, piComposerBase } from "./composer.ts";
import { createPiDriver } from "./driver.ts";
import { PI_FORKERS } from "./handover.ts";
import { piSetupAdapter } from "./setup.ts";
import { piSyncAdapter } from "./sync.ts";
import { piSessionFiles, piTranscriptPath } from "./transcript.ts";

export default defineVendorDaemon({
  createDriver: (deps) => createPiDriver(deps),
  composer: { base: piComposerBase, create: (deps) => createPiComposer(deps) },
  catalog: { probe: piCatalogProbe, source: createPiCatalogSource },
  forkers: PI_FORKERS,
  transcriptPath: piTranscriptPath,
  sessionFiles: piSessionFiles,
  capabilityLaunch: piCapabilityArgs,
  sync: piSyncAdapter,
  setup: piSetupAdapter,
});

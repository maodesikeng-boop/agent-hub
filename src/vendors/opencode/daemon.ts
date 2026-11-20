import { defineVendorDaemon } from "../daemon-types.ts";
import { createOpenCodeCatalogSource, opencodeCatalogProbe } from "./catalog.ts";
import { createOpenCodeComposer, opencodeComposerBase } from "./composer.ts";
import { buildOpenCodeConfigOverride, createOpenCodeDriver } from "./driver.ts";
import { opencodeSetupAdapter } from "./setup.ts";
import { opencodeSyncAdapter } from "./sync.ts";

export default defineVendorDaemon({
  createDriver: (deps) => createOpenCodeDriver(deps),
  composer: {
    base: opencodeComposerBase,
    create: (deps) => createOpenCodeComposer(deps),
  },
  catalog: {
    probe: opencodeCatalogProbe,
    source: (options) => createOpenCodeCatalogSource(options),
  },
  capabilityLaunch: (capabilities) => buildOpenCodeConfigOverride({ promptFile: "", env: {}, fingerprint: "", capabilities }),
  launchFiles: () => ({ env: { OPENCODE_DISABLE_AUTOUPDATE: "1" } }),
  sync: opencodeSyncAdapter,
  setup: opencodeSetupAdapter,
});

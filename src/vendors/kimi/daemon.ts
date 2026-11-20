import { defineVendorDaemon } from "../daemon-types.ts";
import { createKimiCatalogSource, kimiCatalogProbe } from "./catalog.ts";
import { createKimiComposer, kimiComposerBase } from "./composer.ts";
import { createKimiDriver } from "./driver.ts";
import { kimiSetupAdapter } from "./setup.ts";
import { kimiSyncAdapter } from "./sync.ts";

export default defineVendorDaemon({
  createDriver: (deps) => createKimiDriver(deps),
  composer: {
    base: kimiComposerBase,
    create: () => createKimiComposer(),
  },
  catalog: {
    probe: kimiCatalogProbe,
    source: (options) => createKimiCatalogSource(options),
  },
  launchFiles: () => ({ env: { KIMI_CODE_NO_AUTO_UPDATE: "1" } }),
  sync: kimiSyncAdapter,
  setup: kimiSetupAdapter,
});

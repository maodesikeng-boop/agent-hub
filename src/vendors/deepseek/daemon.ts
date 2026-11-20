import { defineVendorDaemon } from "../daemon-types.ts";
import { deepseekSkillFilesystemConfig } from "./capabilities.ts";
import { createDeepSeekCatalogSource, deepseekCatalogProbe } from "./catalog.ts";
import { buildDeepSeekPatchSettings, createDeepSeekDriver } from "./driver.ts";
import { deepseekSetupAdapter } from "./setup.ts";
import { deepseekSyncAdapter } from "./sync.ts";

export default defineVendorDaemon({
  createDriver: (deps) => createDeepSeekDriver(deps),
  catalog: {
    probe: deepseekCatalogProbe,
    source: (options) => createDeepSeekCatalogSource(options),
  },
  capabilityLaunch: (caps) => ({ skills: deepseekSkillFilesystemConfig(caps, undefined), mcp: caps.deny.mcp }),
  launchFiles: () => ({ settings: buildDeepSeekPatchSettings() }),
  sync: deepseekSyncAdapter,
  setup: deepseekSetupAdapter,
});

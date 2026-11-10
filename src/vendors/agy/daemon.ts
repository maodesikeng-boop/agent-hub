// agy 的守护进程侧（docs/vendor-plugin-design.md 3.3 节）：daemon-registry.ts 按名单加载这个文件的默认导出。
import { defineVendorDaemon } from "../daemon-types.ts";
import { agyCatalogProbe, createAgyCatalogSource } from "./catalog.ts";
import { agyComposerBase, createAgyComposer } from "./composer.ts";
import { createAgyDriver } from "./driver.ts";
import { AGY_FORKERS } from "./handover.ts";
import { agyTranscriptPath } from "./transcript.ts";

export default defineVendorDaemon({
  createDriver: (deps) => createAgyDriver(deps),
  composer: { base: agyComposerBase, create: (deps) => createAgyComposer(deps) },
  catalog: { probe: agyCatalogProbe, source: createAgyCatalogSource },
  forkers: AGY_FORKERS,
  transcriptPath: agyTranscriptPath,
});

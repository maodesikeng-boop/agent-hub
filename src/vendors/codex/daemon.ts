// codex 的守护进程侧（docs/vendor-plugin-design.md 3.3 节）：daemon-registry.ts 按名单加载这个文件的默认导出。
import { defineVendorDaemon } from "../daemon-types.ts";
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
  // codex 起会话时没法不存记录：只有那一个 rollout 文件
  sessionFiles: (ref, roots) => [codexTranscriptPath(ref, roots)].filter((file) => file !== null),
  sync: codexSyncAdapter,
  setup: codexSetupAdapter,
});

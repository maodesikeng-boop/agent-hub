// claude 的守护进程侧（docs/vendor-plugin-design.md 3.3 节）：daemon-registry.ts 按名单加载这个文件的默认导出。
import { defineVendorDaemon } from "../daemon-types.ts";
import { claudeCatalogProbe, createClaudeCatalogSource, queryClaudeInitialize } from "./catalog.ts";
import { claudeComposerBase, createClaudeComposer } from "./composer.ts";
import { createClaudeDriver } from "./driver.ts";
import { CLAUDE_FORKERS } from "./handover.ts";
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
  // 每个会话一份 --settings（权限档、放行 hub、沙箱），Worker 多设关掉自动记忆的环境变量
  launchFiles: (input) => ({ settings: JSON.stringify(buildSessionSettings(input), null, 2) + "\n", env: sessionEnv(input.role) }),
  sync: claudeSyncAdapter,
  setup: claudeSetupAdapter,
});

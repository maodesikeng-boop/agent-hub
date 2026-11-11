// cursor 守护进程侧装配入口（按名单由 daemon-registry.ts 加载）。
import { homedir } from "node:os";
import { join } from "node:path";
import { safeId, type TranscriptRef, type TranscriptRoots } from "../../daemon/driver/transcript-files.ts";
import { defineVendorDaemon } from "../daemon-types.ts";
import { createCursorCatalogSource, cursorCatalogProbe } from "./catalog.ts";
import { createCursorComposer, cursorComposerBase } from "./composer.ts";
import { createCursorDriver } from "./driver.ts";
import { cursorSyncAdapter } from "./sync.ts";

export function cursorSessionFiles(ref: TranscriptRef, roots: TranscriptRoots): string[] {
  if (!safeId(ref.vendorSessionId)) return [];
  const home = roots.home ?? homedir();
  return [join(home, ".cursor", "acp-sessions", ref.vendorSessionId)];
}

export default defineVendorDaemon({
  createDriver: (deps) => createCursorDriver(deps),
  composer: {
    base: cursorComposerBase,
    create: (deps) => createCursorComposer(deps),
  },
  catalog: {
    probe: cursorCatalogProbe,
    source: (options) => createCursorCatalogSource(options),
  },
  sessionFiles: cursorSessionFiles,
  sync: cursorSyncAdapter,
});

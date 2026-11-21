import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHubPaths } from "../../shared/paths.ts";
import type { SqliteLedger } from "../ledger/index.ts";
import type { ProcessLedger } from "../process-ledger.ts";
import { createDaemonSessionScope } from "../session-tmp.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { WorktreeCleanup } from "../worktree-cleanup.ts";
import { startDaemonResources } from "./daemon-wiring.ts";
import type { SessionProcess, SessionProcessReaper } from "./session-processes.ts";

let root: string;
let db: Db;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "daemon-resources-")));
  mkdirSync(join(root, "state"), { recursive: true });
  db = openTestDb();
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("startDaemonResources", () => {
  it("stop() waits for the startup process sweep and the sweep stops before reaping anything once stop begins", async () => {
    let finishScan!: (procs: SessionProcess[]) => void;
    const reapOne = vi.fn(async () => true);
    const sessionProcesses: SessionProcessReaper = {
      reapSession: async () => [],
      listEnded: () => new Promise((resolve) => (finishScan = resolve)),
      reapOne,
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      const resources = startDaemonResources({
        db,
        paths: resolveHubPaths({ AGENT_HUB_HOME: root }, root),
        ledger: {} as SqliteLedger,
        worktrees: {} as WorktreeCleanup,
        sessionScope: createDaemonSessionScope({ ledgerFile: join(root, "state", "session-tmp.json"), env: {} }),
        sessionProcesses,
        processLedger: { size: 0 } as ProcessLedger,
        feishuPosts: { prunePosts: () => 0 },
        feishuOfflineInbox: { expire: () => [] },
        uploadsDir: join(root, "uploads"),
        sentFilesDir: join(root, "sent-files"),
        extraWorktreeRoots: () => [],
        log: () => {},
      });
      let stopped = false;
      const stopping = resources.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);

      finishScan([{ pid: 4321, sessionId: 9, tag: "s9:x", command: "node dev.js", cwd: "/work/wt", sessionPrivate: true }]);
      await stopping;
      expect(reapOne).not.toHaveBeenCalled();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

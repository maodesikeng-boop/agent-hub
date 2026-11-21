import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_SESSION_OWNER_TAG } from "../../shared/limits.ts";
import { isAlive, waitForExit } from "../driver/process.ts";
import type { ListTaggedProcessesOptions } from "../platform/index.ts";
import { createDaemonSessionScope, type DaemonSessionScope } from "../session-tmp.ts";
import type { Db } from "../store/index.ts";
import { createSessionProcessReaper } from "./session-processes.ts";

const pids: number[] = [];
let root: string;
let worktree: string;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "session-processes-")));
  worktree = join(root, "worktrees", "5");
  mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }
  rmSync(root, { recursive: true, force: true });
});

function sessionDb(cwdById: Record<number, string>): Db {
  return { get: (_sql: string, id: number) => (cwdById[id] === undefined ? undefined : { cwd: cwdById[id] }) } as unknown as Db;
}

function spawnTagged(envTag: string): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, [ENV_SESSION_OWNER_TAG]: envTag },
  });
  child.unref();
  pids.push(child.pid!);
  return child.pid!;
}

/** The sandbox blocks setuid ps, so the darwin parser is fed the live PIDs; signals still hit the real processes. */
function fakeProcessTable(rows: Array<{ pid: number; envTag: string; cwd: string }>): ListTaggedProcessesOptions {
  const uid = process.getuid?.() ?? 501;
  return {
    platform: "darwin",
    ownUid: uid,
    runPs: async (args) => {
      if (args[0] === "-p") return `${process.pid}\n`;
      return rows
        .filter((row) => isAlive(row.pid))
        .map((row) => `  ${row.pid}     1  ${row.pid}   ${uid} node -e server ${ENV_SESSION_OWNER_TAG}=${row.envTag} PATH=/usr/bin`)
        .join("\n");
    },
    cwdOf: async (asked) => new Map(rows.filter((row) => asked.includes(row.pid)).map((row) => [row.pid, row.cwd])),
  };
}

function reaperFor(scope: DaemonSessionScope, platform: ListTaggedProcessesOptions) {
  return createSessionProcessReaper({
    db: sessionDb({ 5: worktree }),
    tagNonce: scope.tagNonce,
    ownerTag: scope.ownerTag,
    sessionTmp: scope.tmp,
    platform,
  });
}

describe("session process reaper", () => {
  it.skipIf(process.platform === "win32")("reaps a descendant tagged before a daemon restart when its session ends afterwards", async () => {
    const ledgerFile = join(root, "state", "session-tmp.json");
    mkdirSync(join(root, "state"));
    const before = createDaemonSessionScope({ ledgerFile, env: {} });
    const devServer = spawnTagged(before.ownerEnv(5));
    const table = fakeProcessTable([{ pid: devServer, envTag: before.ownerEnv(5), cwd: worktree }]);

    const after = reaperFor(createDaemonSessionScope({ ledgerFile, env: {} }), table);
    expect((await after.listEnded(new Set()))?.map((p) => [p.pid, p.sessionId, p.sessionPrivate])).toEqual([[devServer, 5, true]]);
    expect(await after.reapSession(5)).toEqual([devServer]);
    expect(await waitForExit(devServer, 2_000)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("leaves a tagged process running outside the session's folders for the user to decide", async () => {
    const ledgerFile = join(root, "state", "session-tmp.json");
    mkdirSync(join(root, "state"));
    const scope = createDaemonSessionScope({ ledgerFile, env: {} });
    const inTmp = spawnTagged(scope.ownerEnv(5));
    const shared = spawnTagged(scope.ownerEnv(5));
    const sessionTmp = scope.tmp.allocate(5);
    const table = fakeProcessTable([
      { pid: inTmp, envTag: scope.ownerEnv(5), cwd: join(sessionTmp, "vitest") },
      { pid: shared, envTag: scope.ownerEnv(5), cwd: join(root, "home", ".gradle", "daemon", "8.10") },
    ]);
    const reaper = reaperFor(scope, table);

    const listed = await reaper.listEnded(new Set());
    expect(listed?.map((p) => [p.pid, p.sessionPrivate]).sort()).toEqual([[inTmp, true], [shared, false]].sort());
    expect(await reaper.listEnded(new Set([5]))).toEqual([]);

    expect(await reaper.reapSession(5)).toEqual([inTmp]);
    expect(await waitForExit(inTmp, 2_000)).toBe(true);
    expect(isAlive(shared)).toBe(true);

    expect(await reaper.reapOne(shared, "s6:wrong")).toBe(false);
    expect(isAlive(shared)).toBe(true);
    expect(await reaper.reapOne(shared, scope.ownerTag(5))).toBe(true);
    expect(await waitForExit(shared, 2_000)).toBe(true);
  });

  it("returns null instead of an empty list when the process table cannot be read", async () => {
    const scope = createDaemonSessionScope({ ledgerFile: join(root, "state", "session-tmp.json"), env: {} });
    const reaper = reaperFor(scope, { platform: "darwin", runPs: async () => null });
    expect(await reaper.listEnded(new Set())).toBeNull();
  });
});

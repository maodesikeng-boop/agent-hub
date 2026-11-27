import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUB_USAGE } from "../hub/usage.ts";
import { LedgerRequestError } from "../shared/ledger.ts";
import { SELF_RELOAD_BUSY_ITEMS_MAX, SELF_RELOAD_QUIET_MS } from "../shared/limits.ts";
import { pmMemoryDirPath } from "../shared/paths.ts";
import { createResolveFolder } from "./ledger/files.ts";
import { createLedger, type SqliteLedger } from "./ledger/index.ts";
import { createSelfReload, createStagedWebBuild, type BuildOutcome } from "./self-reload.ts";
import {
  describeBusySessionsForReload,
  type BusyBackgroundCommand,
  type BusySessionSnapshot,
} from "./self-reload-busy.ts";
import { openTestDb } from "./store/test-helpers.ts";
import type { Db } from "./store/index.ts";

describe("S7: self-reload cancel, status, and named busy Workers / background commands", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("formats active Workers, PMs, and running background commands with durations capped at SELF_RELOAD_BUSY_ITEMS_MAX", () => {
    const now = 600_000;
    const bg: BusyBackgroundCommand = { label: "pnpm test:ci", startedAt: now - 252_000 };
    const sessions: BusySessionSnapshot[] = [
      { sessionId: 1, role: "pm", activity: "working", pmName: "agent-hub" },
      { sessionId: 2, role: "worker", activity: "background", workerId: 42, workerTitle: "Run full suite", backgroundTasks: [bg] },
      ...Array.from({ length: SELF_RELOAD_BUSY_ITEMS_MAX + 3 }, (_, idx): BusySessionSnapshot => ({
        sessionId: 10 + idx,
        role: "worker",
        activity: "working",
        workerId: 100 + idx,
        workerTitle: `Task ${idx}`,
      })),
    ];

    const reasons = describeBusySessionsForReload(sessions, now);
    expect(reasons.some((line) => line.includes("Worker #42") && line.includes("pnpm test:ci"))).toBe(true);
    expect(reasons.some((line) => line.includes("另有"))).toBe(true);
    expect(reasons.length).toBeLessThanOrEqual(SELF_RELOAD_BUSY_ITEMS_MAX + 1);
  });

  it("cancels draining and in-flight building reloads cleanly, is idempotent on idle, and rejects restarting", () => {
    vi.setSystemTime(new Date(2026, 10, 28, 10, 0, 0));
    const restart = vi.fn();
    let aborted = false;
    const buildHandle: { resolve?: (outcome: BuildOutcome) => void } = {};
    const listeners = new Set<() => void>();
    const reload = createSelfReload({
      busyReasons: () => ["Worker #42「跑测试」（后台命令 1 个）"],
      unresumableReasons: () => [],
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      build: (signal) =>
        new Promise<BuildOutcome>((resolve) => {
          signal.addEventListener("abort", () => { aborted = true; }, { once: true });
          buildHandle.resolve = resolve;
        }),
      restart,
      log: () => {},
    });

    const idleCancel = reload.cancel({ by: "pm 1" });
    expect(idleCancel.status.state).toBe("idle");
    expect(idleCancel.text).toContain("没有");

    reload.request({ build: true, by: "pm 1" });
    expect(reload.status().state).toBe("building");
    const cancelled = reload.cancel({ by: "pm 1" });
    expect(aborted).toBe(true);
    expect(cancelled.status.state).toBe("idle");
    expect(cancelled.status.lastFailure).toBeNull();
    expect(listeners.size).toBe(0);
    buildHandle.resolve?.({ ok: true });
    vi.advanceTimersByTime(SELF_RELOAD_QUIET_MS * 10);
    expect(restart).not.toHaveBeenCalled();

    // Re-scheduling works after cancel, and cancelling once restarting throws conflict.
    const idleReload = createSelfReload({
      busyReasons: () => [],
      unresumableReasons: () => [],
      subscribe: () => () => {},
      restart,
      log: () => {},
    });
    idleReload.request({ build: false, by: "pm 1" });
    vi.advanceTimersByTime(SELF_RELOAD_QUIET_MS);
    expect(idleReload.status().state).toBe("restarting");
    expect(() => idleReload.cancel({ by: "pm 1" })).toThrow(LedgerRequestError);
  });
});

describe("S8 and S9: PM-own memory file sharing, Worker/cross-PM isolation, receipt IDs, and max-time copy", () => {
  let db: Db;
  let root: string;
  let dataHome: string;
  let pmMemoryDir: string;
  let folder: string;
  let ledger: SqliteLedger;
  let pm1Id: number;
  let pm1SessionId: number;
  let pm2Id: number;

  function openLedger(): SqliteLedger {
    return createLedger(db, {
      now: () => 50_000,
      pmHomeRoot: join(dataHome, "pm-home"),
      dataHome,
      pmMemoryDir,
      sentFilesDir: join(dataHome, "sent-files"),
      uploadsDir: join(dataHome, "uploads"),
      shareTmpDirs: [],
      resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    });
  }

  beforeEach(() => {
    db = openTestDb();
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "hub-pm-mem-share-")));
    dataHome = join(root, ".agent-hub");
    pmMemoryDir = join(dataHome, "state", "pm-memory");
    folder = join(root, "proj");
    mkdirSync(folder, { recursive: true });
    mkdirSync(pmMemoryDir, { recursive: true });
    ledger = openLedger();
    const pm1 = ledger.createPm({ name: "PM1", mode: "manage_only", persona: "", folder });
    pm1Id = pm1.pm.id;
    pm1SessionId = pm1.sessionId;
    const pm2Folder = join(root, "proj2");
    mkdirSync(pm2Folder, { recursive: true });
    const pm2 = ledger.createPm({ name: "PM2", mode: "manage_only", persona: "", folder: pm2Folder });
    pm2Id = pm2.pm.id;
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("allows a PM to share files from its own pm-memory/<pmId> via hub ask --file while blocking other PMs, symlinks, state files, and Workers", async () => {
    const ownDir = pmMemoryDirPath(pmMemoryDir, pm1Id);
    const otherDir = pmMemoryDirPath(pmMemoryDir, pm2Id);
    mkdirSync(ownDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });

    const ownPlan = join(ownDir, "plan.md");
    const otherSecret = join(otherDir, "secret.md");
    const stateToken = join(dataHome, "state", "ui-token");
    const escapeLink = join(ownDir, "escape.md");
    writeFileSync(ownPlan, "# Plan\n");
    writeFileSync(otherSecret, "top secret\n");
    writeFileSync(stateToken, "secret-token\n");
    symlinkSync(stateToken, escapeLink);

    const ownShared = await ledger.shareHubFiles(pm1SessionId, [{ label: "方案", path: ownPlan }]);
    expect(ownShared[0]?.status).toBe("saved");

    // Cross-PM memory, symlink escape, and raw state files remain denied.
    const crossPm = await ledger.shareHubFiles(pm1SessionId, [{ label: null, path: otherSecret }]);
    expect(crossPm[0]?.status).toBe("not_allowed");
    const symlinkEscape = await ledger.shareHubFiles(pm1SessionId, [{ label: null, path: escapeLink }]);
    expect(symlinkEscape[0]?.status).toBe("not_allowed");
    const rawState = await ledger.shareHubFiles(pm1SessionId, [{ label: null, path: stateToken }]);
    expect(rawState[0]?.status).toBe("not_allowed");

    // A Worker must NEVER share any PM's memory directory.
    const workerRes = ledger.hubCall(pm1SessionId, "worker.start", { title: "W1", task: "Check", noWorktree: true });
    const workerSession = db.get<{ id: number }>(
      "SELECT id FROM agent_sessions WHERE worker_id = ?",
      workerRes.data.worker.id,
    )!;
    const workerAttempt = await ledger.shareHubFiles(workerSession.id, [{ label: null, path: ownPlan }]);
    expect(workerAttempt[0]?.status).toBe("not_allowed");
  });

  it("regression: plain hub ask prints the card number and worker show separates turn elapsed from time budget", () => {
    const askRes = ledger.hubCall(pm1SessionId, "ask", { text: "Choose one?", options: ["A", "B"] });
    expect(askRes.data.item).toBeDefined();
    expect(askRes.text).toContain(`卡 #${askRes.data.item!.id}`);

    const workerRes = ledger.hubCall(pm1SessionId, "worker.start", { title: "W2", task: "Do work", noWorktree: true });
    const shown = ledger.hubCall(pm1SessionId, "worker.show", { workerId: workerRes.data.worker.id });
    expect(shown.text).toContain("时间预算：");
    expect(shown.text).toContain("从派活时起算，重启不重置");
  });

  it("includes --message <id> in hub ask --node receipt and aligns max-time help copy with 时间预算", () => {
    const graphId = ledger.hubCall(pm1SessionId, "graph.create", {
      specJson: JSON.stringify({ title: "G", steps: [{ key: "plan", title: "Plan" }] }),
    }).data.graph.id;
    const stepAsk = ledger.hubCall(pm1SessionId, "ask", {
      node: "plan",
      graphId,
      text: "Approve plan?",
      options: ["Yes", "No"],
    });
    expect(stepAsk.text).toContain(`--message ${stepAsk.data.messageId}`);
    expect(HUB_USAGE).not.toContain("本轮最大容忍时间");
    expect(HUB_USAGE).toContain("时间预算");
  });
});

describe("S7 regression: createSelfReload + createStagedWebBuild cancel cleanup, restart recovery, and serialized re-entry", () => {
  let root: string;
  let staticDir: string;
  let stagingDir: string;
  let readyDir: string;
  let logPath: string;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "hub-self-reload-audit-")));
    staticDir = join(root, "dist", "web");
    stagingDir = join(root, "dist", ".web-reload-next");
    readyDir = join(root, "dist", ".web-reload-ready");
    logPath = join(root, "logs", "self-reload-build.log");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "old");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { build: "echo ok" } }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("cleans up late staging writes after cancel exits (even if sync cleanup throws EBUSY) so next-startup recover() returns null", async () => {
    const webBuild = createStagedWebBuild({
      repoDir: root,
      staticDir,
      logPath,
      command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      log: () => {},
    })!;
    let releaseFirstBuild!: () => void;
    const firstBuildDone = new Promise<void>((resolve) => { releaseFirstBuild = resolve; });
    let buildSettled!: () => void;
    const buildFinished = new Promise<void>((resolve) => { buildSettled = resolve; });
    let cleanupAttempts = 0;

    const reload = createSelfReload({
      busyReasons: () => ["Worker #1 忙碌中"],
      unresumableReasons: () => [],
      subscribe: () => () => {},
      build: async (signal) => {
        mkdirSync(stagingDir, { recursive: true });
        writeFileSync(join(stagingDir, "index.html"), "partial");
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        await firstBuildDone;
        // Simulate a child process still writing into .web-reload-next before exiting on abort.
        mkdirSync(stagingDir, { recursive: true });
        writeFileSync(join(stagingDir, "late.js"), "console.log('late');");
        queueMicrotask(buildSettled);
        return { ok: false, reason: "被取消" };
      },
      applyBuild: () => webBuild.apply(),
      cancelBuild: () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
        }
        webBuild.cleanup();
      },
      restart: vi.fn(),
      log: () => {},
    });

    reload.request({ build: true, by: "pm 1" });
    expect(existsSync(stagingDir)).toBe(true);
    expect(() => reload.cancel({ by: "pm 1" })).not.toThrow();
    expect(reload.status().state).toBe("idle");

    releaseFirstBuild();
    await buildFinished;
    await vi.waitFor(() => expect(existsSync(stagingDir)).toBe(false));
    expect(existsSync(readyDir)).toBe(false);
    expect(readFileSync(join(staticDir, "index.html"), "utf8")).toBe("old");

    // Across a restart, a fresh StagedWebBuild must not misreport the cancelled build as an interruption.
    const nextStartup = createStagedWebBuild({
      repoDir: root,
      staticDir,
      logPath,
      command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      log: () => {},
    })!;
    expect(nextStartup.recover()).toBeNull();

    // Contrasting invariant: daemon close() during a build keeps .web-reload-next so restart recovery reports the interruption.
    const shutdownReload = createSelfReload({
      busyReasons: () => ["Worker #1 忙碌中"],
      unresumableReasons: () => [],
      subscribe: () => () => {},
      build: async (signal) => {
        mkdirSync(stagingDir, { recursive: true });
        writeFileSync(join(stagingDir, "index.html"), "partial");
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { ok: false, reason: "被取消" };
      },
      applyBuild: () => webBuild.apply(),
      cancelBuild: () => webBuild.cleanup(),
      restart: vi.fn(),
      log: () => {},
    });
    shutdownReload.request({ build: true, by: "pm 1" });
    await shutdownReload.close();
    await vi.waitFor(() => expect(existsSync(stagingDir)).toBe(true));
    expect(nextStartup.recover()).toContain("在网页构建完成前被打断");
    expect(existsSync(stagingDir)).toBe(false);
  });

  it("serializes a re-requested build behind a cancelled in-flight build and cleans staging with real createStagedWebBuild", async () => {
    writeFileSync(
      join(root, "fake-build.mjs"),
      `import { mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--outDir") + 1];
mkdirSync(out, { recursive: true });
writeFileSync(out + "/index.html", "v2");
if (process.argv.includes("HANG")) setInterval(() => {}, 1000);`,
    );
    const hangingBuild = createStagedWebBuild({
      repoDir: root,
      staticDir,
      logPath,
      command: `${JSON.stringify(process.execPath)} fake-build.mjs HANG`,
      log: () => {},
    })!;
    const fastBuild = createStagedWebBuild({
      repoDir: root,
      staticDir,
      logPath,
      command: `${JSON.stringify(process.execPath)} fake-build.mjs`,
      log: () => {},
    })!;

    let inFlight = 0;
    let maxConcurrent = 0;
    let buildCalls = 0;
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const events: string[] = [];
    const restart = vi.fn();

    const reload = createSelfReload({
      busyReasons: () => [],
      unresumableReasons: () => [],
      subscribe: () => () => {},
      quietMs: 20,
      build: async (signal) => {
        buildCalls += 1;
        const idx = buildCalls;
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        events.push(`start:${idx}`);
        try {
          if (idx === 1) {
            const res = await hangingBuild.build(signal);
            await holdFirst;
            return res;
          }
          return await fastBuild.build(signal);
        } finally {
          events.push(`end:${idx}`);
          inFlight -= 1;
        }
      },
      applyBuild: () => fastBuild.apply(),
      cancelBuild: () => {
        events.push("cleanup");
        hangingBuild.cleanup();
      },
      restart,
      log: () => {},
    });

    // 1. Start hanging real build, wait until staging file exists, then cancel.
    reload.request({ build: true, by: "pm 1" });
    await vi.waitFor(() => expect(existsSync(join(stagingDir, "index.html"))).toBe(true));
    reload.cancel({ by: "pm 1" });

    // 2. Immediately re-request --build before the first build settles; build #2 must wait.
    reload.request({ build: true, by: "pm 1" });
    expect(reload.status().state).toBe("building");
    expect(buildCalls).toBe(1);
    expect(maxConcurrent).toBe(1);

    // 3. Let build #1 finish exiting: cleanup runs before build #2 starts, and build #2 completes and swaps cleanly.
    releaseFirst();
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    expect(buildCalls).toBe(2);
    expect(maxConcurrent).toBe(1);
    expect(events.indexOf("end:1")).toBeLessThan(events.indexOf("start:2"));
    expect(readFileSync(join(staticDir, "index.html"), "utf8")).toBe("v2");
    expect(existsSync(stagingDir)).toBe(false);
    expect(existsSync(readyDir)).toBe(false);
    expect(fastBuild.recover()).toBeNull();
  });
});

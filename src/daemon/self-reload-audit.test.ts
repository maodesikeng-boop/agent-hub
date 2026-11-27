import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUB_USAGE } from "../hub/usage.ts";
import { LedgerRequestError } from "../shared/ledger.ts";
import { SELF_RELOAD_BUSY_ITEMS_MAX, SELF_RELOAD_QUIET_MS } from "../shared/limits.ts";
import { pmMemoryDirPath } from "../shared/paths.ts";
import { createResolveFolder } from "./ledger/files.ts";
import { createLedger, type SqliteLedger } from "./ledger/index.ts";
import { createSelfReload, type BuildOutcome } from "./self-reload.ts";
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

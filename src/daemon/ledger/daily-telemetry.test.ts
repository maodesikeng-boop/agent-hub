import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_VENDORS } from "../../shared/vendors.ts";
import {
  DAILY_TELEMETRY_MAX_BYTES,
  DAILY_TELEMETRY_MAX_MESSAGES,
  DAILY_TELEMETRY_MAX_TURNS,
} from "../../shared/limits.ts";
import {
  DAILY_TELEMETRY_SECTIONS,
  type DailyTelemetryBundle,
} from "../../shared/daily-telemetry.ts";
import { hubCommandAllowed } from "../../shared/hub.ts";
import { parseCommand } from "../../hub/parse.ts";
import { openDatabase, type Db } from "../store/db.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "../store/migrate.ts";
import {
  collectDailyTelemetry,
  collectDailyTelemetryDbSnapshot,
  readBoundedOperationalLogs,
} from "./daily-telemetry.ts";

const NOW_MS = Date.UTC(2026, 10, 28, 0, 30, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

const tempDirs: string[] = [];
const openDbs: Db[] = [];

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()!.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function createMigratedDb(): Db {
  const db = openDatabase(":memory:", { exclusive: false });
  migrate(db, DEFAULT_MIGRATIONS_DIR);
  openDbs.push(db);
  return db;
}

function seedBasePm(db: Db, pmId = 1, vendor = "claude"): { pmId: number; convId: number; sessionId: number; projectId: number } {
  db.run(
    "INSERT INTO pms (id, name, mode, vendor, created_at) VALUES (?, ?, 'manage_only', ?, ?)",
    pmId,
    `PM-${pmId}`,
    vendor,
    NOW_MS - 2 * DAY_MS,
  );
  db.run(
    "INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (?, 'pm', ?, ?, ?)",
    pmId,
    pmId,
    `PM-${pmId}`,
    NOW_MS - 2 * DAY_MS,
  );
  db.run(
    "INSERT INTO projects (id, name, status, pm_id, conversation_id, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, ?)",
    pmId,
    `Proj-${pmId}`,
    pmId,
    pmId,
    NOW_MS - 2 * DAY_MS,
    NOW_MS - 2 * DAY_MS,
  );
  db.run(
    `INSERT INTO agent_sessions (id, role, conversation_id, pm_id, vendor, vendor_session_id, cwd, status, created_at, updated_at)
     VALUES (?, 'pm', ?, ?, ?, ?, '/work/proj', 'idle', ?, ?)`,
    pmId,
    pmId,
    pmId,
    vendor,
    `vs-pm-${pmId}`,
    NOW_MS - 2 * DAY_MS,
    NOW_MS - 2 * DAY_MS,
  );
  return { pmId, convId: pmId, sessionId: pmId, projectId: pmId };
}

describe("daemon daily telemetry collector", () => {
  it("regression: Workers and Router assistants are denied telemetry.export and telemetry.mine (S11)", () => {
    expect(hubCommandAllowed("pm", "telemetry.export")).toBe(true);
    expect(hubCommandAllowed("pm", "telemetry.mine")).toBe(true);
    expect(hubCommandAllowed("worker", "telemetry.export")).toBe(false);
    expect(hubCommandAllowed("worker", "telemetry.mine")).toBe(false);
    expect(hubCommandAllowed("assistant", "telemetry.export")).toBe(false);
    expect(hubCommandAllowed("assistant", "telemetry.mine")).toBe(false);
  });

  it("collects all operational sources strictly read-only, redacts secrets, and excludes self-loop traffic (S1)", () => {
    const db = createMigratedDb();
    const { pmId, convId, sessionId, projectId } = seedBasePm(db);

    db.run(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'user', 'text', '每次都要手动点同意，能不能加个批量通过？Bearer secret-token-123', ?, 'u1', 'replied', ?, ?)`,
      convId,
      sessionId,
      JSON.stringify({ rewound: true, sentWhileBusy: true }),
      NOW_MS - 3_600_000,
      NOW_MS - 3_600_000,
    );
    db.run(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'system', 'text', 'checklist reminder', ?, 'chk-rem', 'replied', ?, ?)`,
      convId,
      sessionId,
      JSON.stringify({ event: "checklist.reminder", sessionId, uuid: "u", toolUseId: "t1" }),
      NOW_MS - 2_000_000,
      NOW_MS - 2_000_000,
    );
    db.run(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'system', 'text', '【定时任务 · 每日产品需求挖掘】\n\nhub telemetry mine', ?, 'sched-self', 'replied', ?, ?)`,
      convId,
      sessionId,
      JSON.stringify({ event: "schedule.run", scheduleId: 99, name: "每日产品需求挖掘" }),
      NOW_MS - 1_800_000,
      NOW_MS - 1_800_000,
    );
    db.run(
      `INSERT INTO hub_calls (session_id, command, args, ok, error_code, result, created_at)
       VALUES (?, 'graph.patch', '{}', 0, 'invalid', '步骤职责最多 1500 字', ?),
              (?, 'telemetry.export', '{}', 1, NULL, 'ok', ?)`,
      sessionId,
      NOW_MS - 1_200_000,
      sessionId,
      NOW_MS - 600_000,
    );
    db.run(
      `INSERT INTO router_commands (id, client_id, input_text, vendor, status, error, created_at, updated_at)
       VALUES (1, 'rc-1', '把所有项目未合并 PR 汇总发给我', 'claude', 'failed', 'no matching route', ?, ?)`,
      NOW_MS - 900_000,
      NOW_MS - 900_000,
    );
    db.run(
      `INSERT INTO task_graphs (id, project_id, pm_id, conversation_id, title, status, created_at, updated_at)
       VALUES (1, ?, ?, ?, '修审批流', 'active', ?, ?)`,
      projectId,
      pmId,
      convId,
      NOW_MS - 7_200_000,
      NOW_MS - 300_000,
    );
    db.run(
      `INSERT INTO task_graph_steps (id, graph_id, node_key, title, status, skipped, worker_ids_json, pm_note, created_at, updated_at)
       VALUES (1, 1, 'impl', '实现', 'done', 0, '[10,11]', '第一次超预算换人', ?, ?)`,
      NOW_MS - 7_000_000,
      NOW_MS - 300_000,
    );

    const beforeTotalChanges = db.get<{ c: number }>("SELECT total_changes() AS c")!.c;
    const bundle: DailyTelemetryBundle = collectDailyTelemetryDbSnapshot(db, {
      pmId,
      sinceMs: NOW_MS - DAY_MS,
      untilMs: NOW_MS,
      scope: "pm",
      sections: DAILY_TELEMETRY_SECTIONS,
      nowMs: NOW_MS,
      platform: "darwin",
    });
    const afterTotalChanges = db.get<{ c: number }>("SELECT total_changes() AS c")!.c;

    expect(afterTotalChanges).toBe(beforeTotalChanges);
    expect(bundle.sections.messages.length).toBe(1);
    expect(bundle.sections.messages[0]!.rewound).toBe(true);
    expect(bundle.sections.messages[0]!.sentWhileBusy).toBe(true);
    expect(bundle.sections.messages[0]!.excerpt).not.toContain("secret-token-123");
    expect(bundle.sections.messages[0]!.excerpt).toContain("[REDACTED]");
    expect(bundle.sections.hubCalls.map((c) => c.command)).toEqual(["graph.patch"]);
    expect(bundle.sections.taskGraphs[0]?.retakenSteps).toBe(1);
    expect(bundle.sections.routerCommands.length).toBe(1);
  });

  it("reads bounded operational log tails and aborts immediately when signal aborts (S6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bw-tel-logs-"));
    tempDirs.push(dir);
    const logsDir = join(dir, "logs");
    const setupLogsDir = join(logsDir, "setup");
    mkdirSync(setupLogsDir, { recursive: true });
    writeFileSync(
      join(logsDir, "daemon.log"),
      `${new Date(NOW_MS - 60_000).toISOString()} [bellwood] uncaughtException: boom Bearer top-secret\n`,
      "utf8",
    );
    writeFileSync(join(setupLogsDir, "worker-1.log"), "setup failed: timeout\n", "utf8");

    const logs = await readBoundedOperationalLogs({
      logsDir,
      setupLogsDir,
      sinceMs: NOW_MS - DAY_MS,
      untilMs: NOW_MS,
      maxLines: 20,
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.some((l) => l.excerpt.includes("top-secret"))).toBe(false);

    const ac = new AbortController();
    ac.abort();
    const db = createMigratedDb();
    seedBasePm(db);
    await expect(
      collectDailyTelemetry(
        { db, logsDir, setupLogsDir, now: () => NOW_MS },
        { pmId: 1, query: { scope: "pm" }, signal: ac.signal },
      ),
    ).rejects.toThrow();
  });

  it("bounds one-month volume (300 finished Workers, 30,000 messages, 50,000 steps) within limits.ts caps (S8)", () => {
    const db = createMigratedDb();
    const { pmId, convId, sessionId, projectId } = seedBasePm(db);

    db.transaction(() => {
      for (let i = 1; i <= 300; i++) {
        const wConvId = 1_000 + i;
        const wSessId = 2_000 + i;
        db.run("INSERT INTO conversations (id, kind, pm_id, project_id, title, created_at) VALUES (?, 'worker', ?, ?, ?, ?)", wConvId, pmId, projectId, `W${i}`, NOW_MS - 10_000);
        db.run(
          "INSERT INTO workers (id, project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, workspace, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'task', 'main', 'ended', ?, ?)",
          i, projectId, pmId, convId, wConvId, `Worker ${i}`, NOW_MS - 10_000, NOW_MS - 5_000,
        );
        db.run(
          "INSERT INTO agent_sessions (id, role, conversation_id, worker_id, pm_id, vendor, vendor_session_id, cwd, status, created_at, updated_at) VALUES (?, 'worker', ?, ?, ?, 'claude', ?, '/w', 'ended', ?, ?)",
          wSessId, wConvId, i, pmId, `vs-w-${i}`, NOW_MS - 10_000, NOW_MS - 5_000,
        );
      }
      for (let i = 1; i <= 30_000; i++) {
        db.run(
          "INSERT INTO messages (conversation_id, session_id, sender, kind, text, dedupe_key, status, created_at, updated_at) VALUES (?, ?, 'user', 'text', ?, ?, 'replied', ?, ?)",
          convId, sessionId, `message payload #${i} `.repeat(8), `m-${i}`, NOW_MS - (i % 86_400) * 1_000, NOW_MS - (i % 86_400) * 1_000,
        );
      }
      for (let i = 1; i <= 50_000; i++) {
        db.run(
          "INSERT INTO session_steps (session_id, kind, at, name, summary) VALUES (?, 'tool', ?, 'bash', 'ok')",
          2_001 + (i % 300), NOW_MS - 1_000,
        );
      }
    });

    const bundle = collectDailyTelemetryDbSnapshot(db, {
      pmId,
      sinceMs: NOW_MS - DAY_MS,
      untilMs: NOW_MS,
      scope: "pm",
      sections: DAILY_TELEMETRY_SECTIONS,
      nowMs: NOW_MS,
      platform: "darwin",
    });
    expect(bundle.sections.messages.length).toBeLessThanOrEqual(DAILY_TELEMETRY_MAX_MESSAGES);
    expect(bundle.sections.turns.length).toBeLessThanOrEqual(DAILY_TELEMETRY_MAX_TURNS);
    expect(Buffer.byteLength(JSON.stringify(bundle), "utf8")).toBeLessThanOrEqual(DAILY_TELEMETRY_MAX_BYTES);
  });

  it("handles corrupt messages.meta JSON and unformatted Worker reports without crashing (S9)", () => {
    const db = createMigratedDb();
    const { pmId, convId, sessionId, projectId } = seedBasePm(db);
    db.run("INSERT INTO conversations (id, kind, pm_id, project_id, title, created_at) VALUES (50, 'worker', ?, ?, 'W50', ?)", pmId, projectId, NOW_MS - 5_000);
    db.run(
      "INSERT INTO workers (id, project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, workspace, status, created_at, updated_at) VALUES (50, ?, ?, ?, 50, 'Broken', 't', 'main', 'ended', ?, ?)",
      projectId, pmId, convId, NOW_MS - 5_000, NOW_MS - 4_000,
    );
    db.run(
      "INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at) VALUES (?, ?, 'user', 'text', 'corrupt meta test', '{not-json', 'bad-meta', 'replied', ?, ?)",
      convId, sessionId, NOW_MS - 3_000, NOW_MS - 3_000,
    );
    db.run(
      `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 50, 'system', 'worker', 'freeform report with no markers', '{"event":"report"}', 'unfmt-rep', 'replied', ?, ?)`,
      convId, sessionId, NOW_MS - 2_000, NOW_MS - 2_000,
    );

    const bundle = collectDailyTelemetryDbSnapshot(db, {
      pmId,
      sinceMs: NOW_MS - DAY_MS,
      untilMs: NOW_MS,
      scope: "pm",
      sections: DAILY_TELEMETRY_SECTIONS,
      nowMs: NOW_MS,
      platform: "linux",
    });
    expect(bundle.sections.messages.length).toBeGreaterThanOrEqual(1);
    expect(bundle.sections.workerReports.some((r) => r.workerId === 50 && !r.formatted)).toBe(true);
  });

  it("collects sessions uniformly across all eight registered vendors (S10)", () => {
    const db = createMigratedDb();
    AGENT_VENDORS.forEach((vendor, idx) => {
      const id = idx + 1;
      const { convId, sessionId } = seedBasePm(db, id, vendor);
      db.run(
        "INSERT INTO messages (conversation_id, session_id, sender, kind, text, dedupe_key, status, created_at, updated_at) VALUES (?, ?, 'user', 'text', ?, ?, 'replied', ?, ?)",
        convId, sessionId, `feedback from ${vendor}`, `v-${vendor}`, NOW_MS - 1_000, NOW_MS - 1_000,
      );
    });

    const bundle = collectDailyTelemetryDbSnapshot(db, {
      pmId: 1,
      sinceMs: NOW_MS - DAY_MS,
      untilMs: NOW_MS,
      scope: "all",
      sections: DAILY_TELEMETRY_SECTIONS,
      nowMs: NOW_MS,
      platform: "win32",
    });
    expect([...bundle.vendorsSeen].sort()).toEqual([...AGENT_VENDORS].sort());
  });

  it("parses cross-platform CLI flags for telemetry export and runs snapshot extraction (S11, S12)", () => {
    const parsed = parseCommand(
      ["telemetry", "export", "--window", "24h", "--scope", "all", "--sections", "messages,hub_calls", "--format", "json"],
      {},
      "C:\\work\\app",
    );
    expect(parsed).toEqual({
      command: "telemetry.export",
      body: { windowMs: DAY_MS, scope: "all", sections: ["messages", "hub_calls"], format: "json" },
      textSource: null,
    });
    const db = createMigratedDb();
    seedBasePm(db);
    const bundle = collectDailyTelemetryDbSnapshot(db, {
      pmId: 1,
      sinceMs: NOW_MS - DAY_MS,
      untilMs: NOW_MS,
      scope: "all",
      sections: ["messages", "hub_calls"],
      nowMs: NOW_MS,
      platform: "win32",
    });
    expect(bundle.platform).toBe("win32");
  });
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RAW_TELEMETRY_LOG_FILE_MAX_BYTES,
  RAW_TELEMETRY_SETUP_LOGS_MAX_FILES,
  RAW_TELEMETRY_SQL_MAX_ROWS_PER_TABLE,
} from "../../shared/limits.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import { redactRawText } from "../../shared/raw-telemetry.ts";
import { findResourceEntry } from "../../shared/resource-registry.ts";
import { AGENT_VENDORS } from "../../shared/vendors.ts";
import { dataDirReadScope } from "../../shared/write-scope.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { Db } from "../store/db.ts";
import { collectRawTelemetry } from "./collector.ts";

const T_NOW = Date.UTC(2026, 10, 28, 1, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

let tempRoot: string;
let db: Db;

function seedBaseProjectAndPm(target: Db, nowMs: number) {
  target.run("INSERT INTO pms (id, name, mode, vendor, created_at) VALUES (1, 'PM', 'manage_only', 'claude', ?)", nowMs - DAY_MS);
  target.run("INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (1, 'pm', 1, 'PM', ?)", nowMs - DAY_MS);
  target.run(
    "INSERT INTO projects (id, name, status, pm_id, conversation_id, created_at, updated_at) VALUES (1, 'demo', 'active', 1, 1, ?, ?)",
    nowMs - DAY_MS,
    nowMs - DAY_MS,
  );
  target.run(
    "INSERT INTO agent_sessions (id, role, conversation_id, pm_id, vendor, vendor_session_id, cwd, status, created_at, updated_at) VALUES (1, 'pm', 1, 1, 'claude', 'sess-pm-1', '/repo', 'idle', ?, ?)",
    nowMs - DAY_MS,
    nowMs - 1_000,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T_NOW);
  tempRoot = mkdtempSync(join(tmpdir(), "bw-collector-test-"));
  db = openTestDb();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Raw telemetry path and sandbox invariants (regression)", () => {
  it("resolves bugHuntStateFile under state/ across macOS, Linux, and Windows and keeps it denied to Workers", () => {
    const mac = resolveHubPaths({}, "/Users/tester");
    const lin = resolveHubPaths({}, "/home/tester");
    const win = resolveHubPaths({}, "C:\\Users\\tester");

    expect(mac.bugHuntStateFile).toBe("/Users/tester/.agent-hub/state/bug-hunt-state.json");
    expect(lin.bugHuntStateFile).toBe("/home/tester/.agent-hub/state/bug-hunt-state.json");
    expect(win.bugHuntStateFile).toBe("C:\\Users\\tester\\.agent-hub\\state\\bug-hunt-state.json");
    expect(findResourceEntry("data_dir", "bugHuntStateFile")).not.toBeNull();

    const scope = dataDirReadScope({ dataDir: mac.home });
    expect(scope.readable.some((dir) => mac.bugHuntStateFile.startsWith(dir))).toBe(false);
  });
});

describe("collectRawTelemetry acceptance scenarios (S1, S3, S5, S6, S7, S8, S11)", () => {
  it("S1 + S11: collects read-only raw telemetry across ledger, logs, and transcripts without mutating hub.sqlite", async () => {
    seedBaseProjectAndPm(db, T_NOW);
    const paths = resolveHubPaths({ AGENT_HUB_HOME: join(tempRoot, "hub") }, join(tempRoot, "user"));
    mkdirSync(paths.setupLogsDir, { recursive: true });
    mkdirSync(join(tempRoot, "user"), { recursive: true });

    db.run(
      `INSERT INTO turns (id, session_id, conversation_id, cause, status, outcome, stop_source, failure_reason, started_at, ended_at, duration_ms, updated_at)
       VALUES (10, 1, 1, 'input', 'ended', 'failed', 'crash', 'driver crashed unexpectedly', ?, ?, 1500, ?)`,
      T_NOW - 60_000,
      T_NOW - 58_500,
      T_NOW - 58_500,
    );
    db.run(
      `INSERT INTO hub_calls (session_id, command, args, ok, error_code, result, created_at)
       VALUES (1, 'worker.show', '{}', 0, 'internal', 'TypeError: cannot read properties of undefined', ?)`,
      T_NOW - 30_000,
    );
    writeFileSync(
      join(paths.logsDir, "daemon.log"),
      `${new Date(T_NOW - 20_000).toISOString()} [agent-hub] 未捕获异常 (uncaughtException)：\nError: boom\n`,
      "utf8",
    );
    writeFileSync(
      join(paths.setupLogsDir, "worker-7.log"),
      "setup command exited with code 1\nError: EACCES permission denied\n",
      "utf8",
    );

    const beforeVersion = db.get<{ data_version: number }>("PRAGMA data_version")!.data_version;
    const beforeHubCalls = db.get<{ n: number }>("SELECT count(*) AS n FROM hub_calls")!.n;

    const window = await collectRawTelemetry(
      {
        db,
        paths,
        userHome: join(tempRoot, "user"),
        now: () => T_NOW,
      },
      { profile: "bug_hunt", windowStartMs: T_NOW - DAY_MS, windowEndMs: T_NOW },
    );

    expect(window.profile).toBe("bug_hunt");
    expect(window.turnAnomalies.length).toBeGreaterThanOrEqual(1);
    expect(window.hubCallFailures.length).toBe(1);
    expect(window.logHits.some((hit) => hit.source === "daemon_log" && hit.kind === "uncaught_exception")).toBe(true);
    expect(window.setupFailures.some((f) => f.workerId === 7)).toBe(true);
    expect(db.get<{ data_version: number }>("PRAGMA data_version")!.data_version).toBe(beforeVersion);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM hub_calls")!.n).toBe(beforeHubCalls);
  });

  it("S5: redacts secrets and userHome paths and never opens secret files", async () => {
    const userHome = join(tempRoot, "user");
    const paths = resolveHubPaths({ AGENT_HUB_HOME: join(tempRoot, "hub") }, userHome);
    mkdirSync(paths.setupLogsDir, { recursive: true });
    mkdirSync(userHome, { recursive: true });
    seedBaseProjectAndPm(db, T_NOW);

    const secretInput = [
      "Authorization: Bearer super_secret_token_123456",
      "apiKey=sk-ant-api03-abcdef1234567890",
      "ghToken=ghp_1234567890abcdefghijklmnop",
      "HUB_TOKEN=hubtok_secret_value_999",
      `path=${userHome}/project/secret.ts`,
      "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
    ].join("\n");

    const redacted = redactRawText(secretInput, { userHome, maxChars: 2_000 });
    expect(redacted).not.toContain("super_secret_token_123456");
    expect(redacted).not.toContain("sk-ant-api03-abcdef1234567890");
    expect(redacted).not.toContain("ghp_1234567890abcdefghijklmnop");
    expect(redacted).not.toContain("hubtok_secret_value_999");
    expect(redacted).not.toContain("MIIBVQIBADANBgkqhkiG9w0BAQEFAASC");
    expect(redacted).not.toContain(userHome);
    expect(redacted).toContain("[REDACTED]");

    writeFileSync(paths.uiTokenFile, "UI_TOKEN_DO_NOT_READ_999", "utf8");
    writeFileSync(paths.providerSecretsFile, JSON.stringify({ key: "PROVIDER_SECRET_DO_NOT_READ" }), "utf8");
    writeFileSync(join(paths.logsDir, "daemon.log"), `${new Date(T_NOW - 10_000).toISOString()} [agent-hub] 未捕获异常 (uncaughtException)：\n${secretInput}\n`, "utf8");

    const window = await collectRawTelemetry(
      { db, paths, userHome, now: () => T_NOW },
      { profile: "bug_hunt", windowStartMs: T_NOW - DAY_MS, windowEndMs: T_NOW },
    );

    const serialized = JSON.stringify(window);
    expect(serialized).not.toContain("UI_TOKEN_DO_NOT_READ_999");
    expect(serialized).not.toContain("PROVIDER_SECRET_DO_NOT_READ");
    expect(serialized).not.toContain("super_secret_token_123456");
    expect(serialized).not.toContain("sk-ant-api03-abcdef1234567890");
  });

  it("S6: bounds one-month data volumes (300 workers, 30,000 messages, 50,000 steps, 2 MiB log, 50 setup logs)", async () => {
    seedBaseProjectAndPm(db, T_NOW);
    const paths = resolveHubPaths({ AGENT_HUB_HOME: join(tempRoot, "hub") }, join(tempRoot, "user"));
    mkdirSync(paths.setupLogsDir, { recursive: true });

    db.transaction(() => {
      for (let i = 1; i <= RAW_TELEMETRY_SQL_MAX_ROWS_PER_TABLE + 150; i++) {
        db.run(
          "INSERT INTO hub_calls (session_id, command, args, ok, error_code, result, created_at) VALUES (1, 'worker.show', '{}', 0, 'internal', 'boom', ?)",
          T_NOW - i * 10,
        );
      }
      for (let i = 1; i <= 300; i++) {
        db.run(
          "INSERT INTO conversations (id, kind, pm_id, project_id, title, created_at) VALUES (?, 'pm', NULL, 1, ?, ?)",
          100 + i,
          `worker-${i}`,
          T_NOW - 1_000,
        );
      }
    });

    const bigLogChunk = `${new Date(T_NOW - 1_000).toISOString()} [agent-hub] 未捕获异常 (uncaughtException)：\nError: repeated\n`;
    const bigLog = bigLogChunk.repeat(Math.ceil((RAW_TELEMETRY_LOG_FILE_MAX_BYTES * 2) / bigLogChunk.length));
    writeFileSync(join(paths.logsDir, "daemon.log"), bigLog, "utf8");

    for (let i = 1; i <= RAW_TELEMETRY_SETUP_LOGS_MAX_FILES + 20; i++) {
      writeFileSync(join(paths.setupLogsDir, `worker-${i}.log`), `error in worker ${i}\n`, "utf8");
    }

    const window = await collectRawTelemetry(
      { db, paths, userHome: join(tempRoot, "user"), now: () => T_NOW },
      { profile: "bug_hunt", windowStartMs: T_NOW - DAY_MS, windowEndMs: T_NOW },
    );

    expect(window.hubCallFailures.length).toBeLessThanOrEqual(RAW_TELEMETRY_SQL_MAX_ROWS_PER_TABLE);
    const logSource = window.sources.find((s) => s.kind === "daemon_log" && s.name === "daemon.log");
    expect(logSource).toBeDefined();
    expect(logSource!.bytesRead).toBeLessThanOrEqual(RAW_TELEMETRY_LOG_FILE_MAX_BYTES);
    expect(logSource!.truncated).toBe(true);
    expect(window.setupFailures.length).toBeLessThanOrEqual(RAW_TELEMETRY_SETUP_LOGS_MAX_FILES);
  });

  it("S7: tolerates corrupt JSON, invalid UTF-8 logs, broken JSONL transcripts, and missing files", async () => {
    seedBaseProjectAndPm(db, T_NOW);
    const userHome = join(tempRoot, "user");
    const paths = resolveHubPaths({ AGENT_HUB_HOME: join(tempRoot, "hub") }, userHome);
    mkdirSync(paths.setupLogsDir, { recursive: true });
    mkdirSync(userHome, { recursive: true });

    writeFileSync(paths.childProcessesFile, "{truncated json", "utf8");
    writeFileSync(join(paths.logsDir, "daemon.log"), Buffer.from([0xff, 0xfe, 0x00, 0x61]));
    const transcriptFile = join(tempRoot, "claude-corrupt.jsonl");
    writeFileSync(transcriptFile, "{\"type\":\"ok\"}\n{not valid json\n", "utf8");

    const window = await collectRawTelemetry(
      {
        db,
        paths,
        userHome,
        findTranscript: (ref) => (ref.vendor === "claude" ? transcriptFile : null),
        now: () => T_NOW,
      },
      { profile: "bug_hunt", windowStartMs: T_NOW - DAY_MS, windowEndMs: T_NOW, includeVendorTranscripts: true },
    );

    expect(window.sources.some((s) => s.kind === "runtime_state" && s.status === "corrupt")).toBe(true);
    expect(window.sources.some((s) => s.kind === "desktop_log" && s.status === "missing")).toBe(true);
    expect(window.transcriptAnomalies.some((t) => t.kind === "malformed_jsonl" && t.vendor === "claude")).toBe(true);
  });

  it("S8: handles all eight registered vendors uniformly without opening binary or secret vendor DBs", async () => {
    seedBaseProjectAndPm(db, T_NOW);
    const userHome = join(tempRoot, "user");
    const paths = resolveHubPaths({ AGENT_HUB_HOME: join(tempRoot, "hub") }, userHome);
    mkdirSync(paths.logsDir, { recursive: true });

    const agyDbFile = join(tempRoot, "agy.db");
    writeFileSync(agyDbFile, "SQLite format 3\0binary", "utf8");
    const claudeJsonl = join(tempRoot, "claude.jsonl");
    writeFileSync(claudeJsonl, "{\"type\":\"error\",\"error\":\"upstream protocol error\"}\n", "utf8");

    let sessionId = 10;
    for (const vendor of AGENT_VENDORS) {
      db.run(
        "INSERT INTO agent_sessions (id, role, conversation_id, pm_id, vendor, vendor_session_id, cwd, status, created_at, updated_at) VALUES (?, 'worker', NULL, 1, ?, ?, '/repo', 'idle', ?, ?)",
        sessionId,
        vendor,
        `vs-${vendor}`,
        T_NOW - 10_000,
        T_NOW - 5_000,
      );
      sessionId++;
    }

    const window = await collectRawTelemetry(
      {
        db,
        paths,
        userHome,
        findTranscript: (ref) => {
          if (ref.vendor === "claude") return claudeJsonl;
          if (ref.vendor === "agy") return agyDbFile;
          return null;
        },
        now: () => T_NOW,
      },
      { profile: "bug_hunt", windowStartMs: T_NOW - DAY_MS, windowEndMs: T_NOW, includeVendorTranscripts: true },
    );

    const agySource = window.sources.find((s) => s.kind === "vendor_transcript" && s.vendor === "agy");
    expect(agySource?.status).toBe("unsupported_format");
    const opencodeSource = window.sources.find((s) => s.kind === "vendor_transcript" && s.vendor === "opencode");
    expect(opencodeSource?.status).toBe("unavailable");
    expect(window.transcriptAnomalies.some((a) => a.vendor === "claude" && a.kind === "vendor_error_frame")).toBe(true);
  });

  it("S3: stops immediately when AbortSignal is aborted during collection", async () => {
    seedBaseProjectAndPm(db, T_NOW);
    const paths = resolveHubPaths({ AGENT_HUB_HOME: join(tempRoot, "hub") }, join(tempRoot, "user"));
    const controller = new AbortController();
    controller.abort();

    await expect(
      collectRawTelemetry(
        { db, paths, userHome: join(tempRoot, "user"), now: () => T_NOW },
        { profile: "bug_hunt", windowStartMs: T_NOW - DAY_MS, windowEndMs: T_NOW },
        controller.signal,
      ),
    ).rejects.toThrow(/abort/i);
  });
});

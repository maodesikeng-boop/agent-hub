import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIAG_BUG_HUNT_AGENT_PATH } from "../../shared/bug-hunt.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import { HUB_USAGE_PROMPT } from "../prompt.ts";
import { createAgentApi } from "../agent-api/server.ts";
import { FakeHubLedger } from "../agent-api/fake-ledger.ts";
import { createSessionTokens } from "../agent-api/tokens.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { Db } from "../store/db.ts";
import { parseCommand } from "../../hub/parse.ts";
import { commandUsageFor, HUB_USAGE } from "../../hub/usage.ts";
import { createBugHuntService } from "./bug-hunt.ts";

const T0 = Date.UTC(2026, 10, 28, 1, 0, 0);

let tempRoot: string;
let db: Db;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "bw-api-bug-hunt-"));
  db = openTestDb();
});

afterEach(() => {
  db.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Prompt-cache safety and help discovery (S8 regression)", () => {
  it("regression: keeps HUB_USAGE_PROMPT unchanged while documenting hub diag bug-hunt in HUB_USAGE", () => {
    expect(HUB_USAGE_PROMPT).not.toContain("diag bug-hunt");
    expect(HUB_USAGE).toContain("diag bug-hunt");
    expect(commandUsageFor(["diag"])).toContain("diag bug-hunt");
  });
});

describe("hub diag bug-hunt CLI parsing and PM-only Agent API route (S1, S5, S10)", () => {
  it("S10: parses scan and lifecycle flags and rejects invalid or conflicting combinations", () => {
    expect(parseCommand(["diag", "bug-hunt", "--since", "24h", "--dry-run", "--run-key", "daily:2026-11-28", "--json"], {}, "/repo")).toEqual({
      command: "diag.bug-hunt",
      body: { action: "scan", sinceMs: 24 * 60 * 60 * 1000, dryRun: true, runKey: "daily:2026-11-28", json: true },
      textSource: null,
    });
    expect(parseCommand(["diag", "bug-hunt", "--fix", "bh-a1b2c3d4e5f6", "--commit", "abc1234"], {}, "/repo")).toEqual({
      command: "diag.bug-hunt",
      body: { action: "fix", fingerprint: "bh-a1b2c3d4e5f6", commit: "abc1234" },
      textSource: null,
    });
    expect(() => parseCommand(["diag", "bug-hunt", "--ack", "bh-111111111111", "--mute", "bh-111111111111"], {}, "/repo")).toThrow();
    expect(() => parseCommand(["diag", "bug-hunt", "--since", "30d"], {}, "/repo")).toThrow();
  });

  it("S5: allows PM token on POST /v1/diag.bug-hunt and rejects Worker and Router assistant tokens with 403", async () => {
    const ledger = new FakeHubLedger();
    const tokens = createSessionTokens();
    const pmToken = tokens.issue(1);
    const workerToken = tokens.issue(2);
    const routerToken = tokens.issue(3);
    ledger.sessionRoles.set(1, "pm");
    ledger.sessionRoles.set(2, "worker");
    ledger.sessionRoles.set(3, "assistant");

    const app = createAgentApi({
      ledger,
      tokens,
      bugHunt: async () => ({
        text: "ok",
        data: {
          kind: "scan",
          runId: "r-1",
          runKey: null,
          replayed: false,
          dryRun: true,
          windowStartMs: T0 - 86_400_000,
          windowEndMs: T0,
          ranAt: T0,
          findings: [],
          suppressedCount: 0,
          omittedCount: 0,
          sources: [],
          stateRecovered: false,
        },
      }),
    });

    try {
      const workerRes = await app.inject({
        method: "POST",
        url: DIAG_BUG_HUNT_AGENT_PATH,
        headers: { authorization: `Bearer ${workerToken}` },
        payload: { action: "scan" },
      });
      expect(workerRes.statusCode).toBe(403);
      expect(workerRes.json()).toMatchObject({ ok: false, code: "forbidden" });

      const routerRes = await app.inject({
        method: "POST",
        url: DIAG_BUG_HUNT_AGENT_PATH,
        headers: { authorization: `Bearer ${routerToken}` },
        payload: { action: "scan" },
      });
      expect(routerRes.statusCode).toBe(403);
      expect(routerRes.json()).toMatchObject({ ok: false, code: "forbidden" });

      const pmRes = await app.inject({
        method: "POST",
        url: DIAG_BUG_HUNT_AGENT_PATH,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { action: "scan", dryRun: true },
      });
      expect(pmRes.statusCode).toBe(200);
      expect(pmRes.json()).toMatchObject({ ok: true, text: "ok" });
    } finally {
      await app.close();
    }
  });

  it("S1 + S10: runs end-to-end over agent-api with createBugHuntService and makes zero SQLite writes", async () => {
    const paths = resolveHubPaths({ AGENT_HUB_HOME: join(tempRoot, "hub") }, join(tempRoot, "user"));
    mkdirSync(paths.stateDir, { recursive: true });
    const service = createBugHuntService({
      db,
      paths,
      stateFile: paths.bugHuntStateFile,
      userHome: join(tempRoot, "user"),
      now: () => T0,
    });
    const ledger = new FakeHubLedger();
    ledger.defaultRole = null;
    ledger.sessionRoles.set(1, "pm");
    const tokens = createSessionTokens();
    const pmToken = tokens.issue(1);
    const app = createAgentApi({
      ledger,
      tokens,
      bugHunt: (req, signal) => service.run(req, signal),
    });

    const beforeVersion = db.get<{ data_version: number }>("PRAGMA data_version")!.data_version;
    const beforeHubCalls = db.get<{ n: number }>("SELECT count(*) AS n FROM hub_calls")!.n;
    try {
      const res = await app.inject({
        method: "POST",
        url: DIAG_BUG_HUNT_AGENT_PATH,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { action: "scan", sinceMs: 24 * 60 * 60 * 1000 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; data: { kind: string } };
      expect(body.ok).toBe(true);
      expect(body.data.kind).toBe("scan");
      expect(db.get<{ data_version: number }>("PRAGMA data_version")!.data_version).toBe(beforeVersion);
      expect(db.get<{ n: number }>("SELECT count(*) AS n FROM hub_calls")!.n).toBe(beforeHubCalls);
    } finally {
      await app.close();
      await service.close();
    }
  });
});

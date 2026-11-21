import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { RELEASE_DB_DIR, RELEASE_SAMPLE } from "../../scripts/release-db-fixture.ts";
import { loadMigrations, openDatabase, openStore, userVersion } from "../../src/daemon/store/index.ts";
import { API_PATHS, ENV_DB_SHARED_ACCESS } from "../../src/shared/index.ts";
import { resolveHubPaths } from "../../src/shared/paths.ts";
import { Client, agentTexts, makeEnv, waitForStatus, type E2eEnv } from "./harness.ts";

const LATEST = loadMigrations(fileURLToPath(new URL("../../migrations/", import.meta.url))).length;
const RELEASES = readdirSync(RELEASE_DB_DIR)
  .flatMap((name) => /^(v\d+\.\d+\.\d+)\.sqlite\.gz$/.exec(name)?.[1] ?? [])
  .sort();

let env: E2eEnv | undefined;
const scratch: string[] = [];
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function inspect<T>(file: string, read: (db: ReturnType<typeof openDatabase>) => T): T {
  const db = openDatabase(file);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const schemaOf = (db: ReturnType<typeof openDatabase>) =>
  db.all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");

function freshSchema(): unknown[] {
  const home = mkdtempSync(join(tmpdir(), "agent-hub-fresh-"));
  scratch.push(home);
  const { db } = openStore(resolveHubPaths({ AGENT_HUB_HOME: home }, "/nonexistent"));
  try {
    return schemaOf(db);
  } finally {
    db.close();
  }
}

describe("upgrading ledgers written by released versions", { timeout: 30_000 }, () => {
  it("samples v0.2.0 and v0.3.0 at least", () => {
    expect(RELEASES).toEqual(expect.arrayContaining(["v0.2.0", "v0.3.0"]));
  });

  it.each(RELEASES)("%s: the daemon backs it up, migrates it to the fresh schema, serves its records, and writes new ones", async (tag) => {
    env = makeEnv();
    const stateDir = join(env.home, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const dbFile = join(stateDir, "hub.sqlite");
    const released = gunzipSync(readFileSync(join(RELEASE_DB_DIR, `${tag}.sqlite.gz`)));
    writeFileSync(dbFile, released);
    const from = inspect(dbFile, userVersion);
    expect(from).toBeLessThan(LATEST);

    env.setScript({ defaultTurn: { steps: [{ text: "after the upgrade" }] } });
    // Installed builds lock the ledger exclusively; this test reads it only after shutdown.
    const daemon = await env.start({ env: { [ENV_DB_SHARED_ACCESS]: "0" } });
    const client = await Client.login(daemon);
    const state = await client.state();
    const samplePm = state.pms.find((pm) => pm.name === RELEASE_SAMPLE.pmName)!;
    expect(samplePm).toBeDefined();
    expect(state.projects.map((p) => p.name)).toEqual([RELEASE_SAMPLE.projectName]);
    const sampleChat = state.conversations.find((c) => c.conversation.kind === "pm" && c.conversation.pmId === samplePm.id)!;
    expect(agentTexts(state, sampleChat.conversation.id)).toEqual([RELEASE_SAMPLE.answer]);

    expect((await client.postJson(API_PATHS.archivePm(samplePm.id), undefined)).status).toBe(200);
    expect((await client.postJson(API_PATHS.unarchivePm(samplePm.id), undefined)).status).toBe(200);
    const pm = await client.createPm({ name: "Created after the upgrade", mode: "manage_only", persona: "" });
    await waitForStatus(client, await client.post(pm.conversationId, "hello after the upgrade"), "replied");
    expect(agentTexts(await client.state(), pm.conversationId)).toEqual(["after the upgrade"]);
    expect((await daemon.terminate()).code).toBe(0);

    inspect(dbFile, (db) => {
      expect(userVersion(db)).toBe(LATEST);
      expect(db.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
      expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(schemaOf(db)).toEqual(freshSchema());
    });
    const backups = readdirSync(stateDir).filter((name) => name.startsWith(`hub.sqlite.bak-${from}-`));
    expect(backups).toHaveLength(1);
    inspect(join(stateDir, backups[0]!), (db) => {
      expect(userVersion(db)).toBe(from);
      expect(db.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
    });
  });
});

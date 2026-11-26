import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { RELEASE_DB_DIR, RELEASE_SAMPLE, captureSampleLedger, headerUserVersion } from "../../scripts/release-db-fixture.ts";
import { loadMigrations, openStore } from "../../src/daemon/store/index.ts";
import { API_PATHS, ENV_DB_SHARED_ACCESS } from "../../src/shared/index.ts";
import { resolveHubPaths } from "../../src/shared/paths.ts";
import * as harness from "./harness.ts";
import { Client, agentTexts, makeEnv, waitForStatus, type E2eEnv } from "./harness.ts";

const LATEST = loadMigrations(fileURLToPath(new URL("../../migrations/", import.meta.url))).length;
const RELEASES = readdirSync(RELEASE_DB_DIR)
  .flatMap((name) => /^(v\d+\.\d+\.\d+)\.sqlite\.gz$/.exec(name)?.[1] ?? [])
  .sort();
const releasedLedger = (tag: string): Buffer => gunzipSync(readFileSync(join(RELEASE_DB_DIR, `${tag}.sqlite.gz`)));
const SAMPLES: [string, () => Promise<Buffer>][] = [
  ...RELEASES.map((tag): [string, () => Promise<Buffer>] => [tag, async () => releasedLedger(tag)]),
  // A release with no new migration yields a sample at the latest version, like this one.
  ["HEAD", () => captureSampleLedger(harness)],
];

let env: E2eEnv | undefined;
const scratch: string[] = [];
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Read-only, so a check never rewrites the bytes the daemon reads next.
function inspect<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const userVersionOf = (db: DatabaseSync) => db.prepare("PRAGMA user_version").get()?.user_version;
const schemaOf = (db: DatabaseSync) =>
  db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();

function freshSchema(): unknown[] {
  const home = mkdtempSync(join(tmpdir(), "agent-hub-fresh-"));
  scratch.push(home);
  const paths = resolveHubPaths({ AGENT_HUB_HOME: home }, "/nonexistent");
  openStore(paths).db.close();
  return inspect(paths.dbFile, schemaOf);
}

describe("upgrading ledgers written by released versions", { timeout: 30_000 }, () => {
  it("samples v0.2.0 and v0.3.0 at least, both older than the latest migration", () => {
    expect(RELEASES).toEqual(expect.arrayContaining(["v0.2.0", "v0.3.0"]));
    for (const tag of ["v0.2.0", "v0.3.0"]) expect(headerUserVersion(releasedLedger(tag)), tag).toBeLessThan(LATEST);
  });

  it.each(SAMPLES)("%s: the daemon migrates it to the fresh schema, backs it up only if it migrated, serves its records, and writes new ones", async (_tag, load) => {
    env = makeEnv();
    const stateDir = join(env.home, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const dbFile = join(stateDir, "hub.sqlite");
    const sample = await load();
    writeFileSync(dbFile, sample);
    const from = headerUserVersion(sample);
    expect(from).toBeLessThanOrEqual(LATEST);

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
    expect(await daemon.terminate()).toEqual({ code: 0, signal: null });

    inspect(dbFile, (db) => {
      expect(userVersionOf(db)).toBe(LATEST);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(schemaOf(db)).toEqual(freshSchema());
    });
    const backups = readdirSync(stateDir).filter((name) => name.startsWith("hub.sqlite.bak-"));
    expect(backups).toEqual(from < LATEST ? [expect.stringMatching(new RegExp(`^hub\\.sqlite\\.bak-${from}-`))] : []);
    for (const backup of backups) {
      inspect(join(stateDir, backup), (db) => {
        expect(userVersionOf(db)).toBe(from);
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      });
    }
  });
});

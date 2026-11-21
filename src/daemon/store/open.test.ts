import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHubPaths } from "../../shared/paths.ts";
import type { HubPaths } from "../../shared/paths.ts";
import { StartupError } from "../startup-error.ts";
import { openStore } from "./open.ts";

let home: string;
let paths: HubPaths;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-hub-open-"));
  paths = resolveHubPaths({ AGENT_HUB_HOME: home }, "/nonexistent");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const TRY_WRITE_LOCK = `
const { DatabaseSync } = require("node:sqlite");
try {
  const db = new DatabaseSync(process.argv[1]);
  db.exec("BEGIN IMMEDIATE");
  db.exec("ROLLBACK");
  db.close();
  console.log("locked");
} catch (error) {
  console.log("refused: " + error.message);
}`;

const HOLD_OPEN = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("SELECT count(*) FROM pms");
console.log("open");
process.stdin.on("end", () => db.close()).resume();`;

function writeLockFromAnotherProcess(file: string): string {
  return execFileSync(process.execPath, ["-e", TRY_WRITE_LOCK, file], { encoding: "utf8" }).trim();
}

describe("ledger file lock", () => {
  it("no other process can take the write lock that the daemon's synchronous writes would wait on", () => {
    const { db } = openStore(paths);
    try {
      expect(writeLockFromAnotherProcess(paths.dbFile)).toBe("refused: database is locked");
      expect(db.get("PRAGMA locking_mode")).toEqual({ locking_mode: "exclusive" });
      expect(db.run("INSERT INTO pms (name, created_at) VALUES ('still writable', 0)").changes).toBe(1);
    } finally {
      db.close();
    }
    expect(writeLockFromAnotherProcess(paths.dbFile)).toBe("locked");
  });

  it("sharedAccess leaves the file open to other processes for end-to-end tests", () => {
    const { db } = openStore(paths, { sharedAccess: true });
    try {
      expect(writeLockFromAnotherProcess(paths.dbFile)).toBe("locked");
    } finally {
      db.close();
    }
  });

  it("refuses to start with a clear error while another process holds the ledger open", async () => {
    openStore(paths).db.close();
    const other = spawn(process.execPath, ["-e", HOLD_OPEN, paths.dbFile], { stdio: ["pipe", "pipe", "inherit"] });
    const exited = once(other, "exit");
    try {
      const ready = await Promise.race([
        once(other.stdout.setEncoding("utf8"), "data").then(([line]) => String(line).trim()),
        exited.then(([code, signal]) => `exited early with ${code ?? signal}`),
      ]);
      expect(ready).toBe("open");
      expect(() => openStore(paths)).toThrow(expect.objectContaining({ name: StartupError.name, code: "ledger_locked", detail: paths.dbFile }));
    } finally {
      other.stdin.end();
      await exited;
    }
    openStore(paths).db.close();
  });
});

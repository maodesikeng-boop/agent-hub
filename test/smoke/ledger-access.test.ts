import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import { VENDOR_LIST } from "../../src/shared/index.ts";
import { smokeDaemonEnv } from "./kit.ts";

const SMOKE_DIR = fileURLToPath(new URL("./", import.meta.url));

describe("smoke scripts that read the ledger while the daemon runs", () => {
  it("every script that calls startDaemon() builds its env with smokeDaemonEnv()", () => {
    const offenders = readdirSync(SMOKE_DIR)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "kit.ts")
      .filter((name) => {
        const source = readFileSync(join(SMOKE_DIR, name), "utf8");
        return /\bstartDaemon\(/.test(source) && !/\bsmokeDaemonEnv\(/.test(source);
      });
    expect(offenders).toEqual([]);
  });

  it("a daemon started with smokeDaemonEnv() lets the script open its ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ah-smoke-env-"));
    const env = smokeDaemonEnv(join(dir, "home"));
    for (const { id, cli } of VENDOR_LIST) env[cli.envVar] = join(dir, `missing-${id}`);
    const daemon = await startDaemon({ userHome: join(dir, "user"), env, log: () => {} });
    try {
      const db = openDatabase(daemon.paths.dbFile);
      try {
        expect(db.get("SELECT count(*) AS n FROM pms")).toEqual({ n: expect.any(Number) });
      } finally {
        db.close();
      }
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

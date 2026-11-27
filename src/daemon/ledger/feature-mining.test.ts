import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { FEATURE_MINING_BACKLOG_FILE_MAX_BYTES } from "../../shared/limits.ts";
import { EMPTY_FEATURE_MINING_STATE, type FeatureMiningState } from "../../shared/feature-mining.ts";
import { readMiningInputs, writeMiningStateAtomic } from "./feature-mining.ts";

const NOW_MS = Date.UTC(2026, 10, 28, 0, 30, 0);
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-feature-mine-"));
  tempDirs.push(dir);
  return dir;
}

describe("daemon feature mining file I/O boundaries", () => {
  it("reads fresh backlog updates immediately on each run without stale caching (S7)", async () => {
    const dir = makeTempDir();
    const backlogPath = join(dir, "feature-queue.md");
    writeFileSync(backlogPath, "- [ ] [F1] Initial item\n", "utf8");
    const first = await readMiningInputs({ backlogPaths: [backlogPath] });
    expect(first.backlog.map((b) => b.status)).toEqual(["open"]);

    writeFileSync(backlogPath, "- [x] [F1] Initial item\n- [ ] [F2] Added while queued\n", "utf8");
    const second = await readMiningInputs({ backlogPaths: [backlogPath] });
    expect(second.backlog.map((b) => [b.id, b.status])).toEqual([
      ["F1", "done"],
      ["F2", "open"],
    ]);
  });

  it("rejects symlinks, denied daemon secret files, and oversized backlog files (S9)", async () => {
    const dir = makeTempDir();
    const realFile = join(dir, "real.md");
    const linkFile = join(dir, "link.md");
    const tokenFile = join(dir, "ui-token");
    const hugeFile = join(dir, "huge.md");
    writeFileSync(realFile, "- [ ] [F1] Valid\n", "utf8");
    writeFileSync(tokenFile, "secret-ui-token", "utf8");
    writeFileSync(hugeFile, "x".repeat(FEATURE_MINING_BACKLOG_FILE_MAX_BYTES + 1024), "utf8");
    symlinkSync(realFile, linkFile);

    await expect(readMiningInputs({ backlogPaths: [linkFile] })).rejects.toThrow(LedgerRequestError);
    await expect(readMiningInputs({ backlogPaths: [tokenFile], deniedPaths: [tokenFile] })).rejects.toThrow(LedgerRequestError);
    await expect(readMiningInputs({ backlogPaths: [hugeFile] })).rejects.toThrow(LedgerRequestError);
  });

  it("recovers cleanly from corrupt prior state JSON and persists updated state atomically across restarts (S6, S9)", async () => {
    const dir = makeTempDir();
    const statePath = join(dir, "mining-state.json");
    writeFileSync(statePath, "{truncated-by-power-loss", "utf8");

    const loaded = await readMiningInputs({ statePath });
    expect(loaded.stateRecoveredFromCorrupt).toBe(true);
    expect(loaded.priorState).toEqual(EMPTY_FEATURE_MINING_STATE);

    const nextState: FeatureMiningState = {
      schemaVersion: 1,
      lastWindowEndMs: NOW_MS,
      observations: [],
      reported: [
        {
          fingerprint: "explicit_ask:batch-approve",
          title: "Batch approve cards",
          priority: "P1",
          reportedAt: NOW_MS,
          occurrencesAtReport: 3,
          status: "pending",
          cooldownUntil: NOW_MS + 7 * 86_400_000,
        },
      ],
    };
    await writeMiningStateAtomic({ statePath, state: nextState, nowMs: NOW_MS });
    expect(existsSync(statePath)).toBe(true);
    const reloaded = await readMiningInputs({ statePath });
    expect(reloaded.stateRecoveredFromCorrupt).toBe(false);
    expect(reloaded.priorState.reported[0]?.fingerprint).toBe("explicit_ask:batch-approve");

    const ac = new AbortController();
    ac.abort();
    await expect(writeMiningStateAtomic({ statePath, state: EMPTY_FEATURE_MINING_STATE, nowMs: NOW_MS, signal: ac.signal })).rejects.toThrow();
    expect(JSON.parse(readFileSync(statePath, "utf8")).reported[0].fingerprint).toBe("explicit_ask:batch-approve");
  });
});

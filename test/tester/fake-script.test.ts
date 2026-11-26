import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { BENCH_ASK_OPTIONS, BENCH_ASK_QUESTION, benchFakeScript, scenarioMarker } from "./fake-script.ts";

it("asks on both bench requests and never on their Router wakeups", () => {
  const dir = mkdtempSync(join(tmpdir(), "tester-ask-script-"));
  try {
    const script = join(dir, "script.json");
    const persona = join(dir, "persona.txt");
    writeFileSync(script, JSON.stringify(benchFakeScript()));
    writeFileSync(persona, scenarioMarker("ask"));
    const fake = fileURLToPath(new URL("../fake-claude/fake-claude.ts", import.meta.url));
    const wakeup = `【Router 拍板】关于「${BENCH_ASK_QUESTION}」\n定案：${BENCH_ASK_OPTIONS[0]}`;
    const asks = ["bench ask first", wakeup, "bench ask second", wakeup].map((content, index) => {
      const result = spawnSync(process.execPath, [fake, "--append-system-prompt-file", persona, index === 0 ? "--session-id" : "--resume", "bench-ask"], {
        cwd: dir,
        env: { PATH: dir, FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_STATE: dir },
        input: `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.includes("hub ask");
    });
    expect(asks).toEqual([true, false, true, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

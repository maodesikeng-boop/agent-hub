import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { waitForJsonLogEvent } from "./append-log.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "bellwood-append-log-"));
  dirs.push(dir);
  return join(dir, "events.jsonl");
}

describe("waitForJsonLogEvent & event-driven test stabilization (acceptance S6/S11)", () => {
  it("resolves immediately when a matching complete record already exists, and ignores partial lines until newline", async () => {
    const file = tempLog();
    writeFileSync(file, `${JSON.stringify({ event: "boot", id: 1 })}\n{"event":"ready"`, "utf8");
    const hit = await waitForJsonLogEvent<{ event: string; id?: number }>({
      file,
      match: (e) => e.event === "boot",
      timeoutMs: 2_000,
    });
    expect(hit).toEqual({ event: "boot", id: 1 });

    const pending = waitForJsonLogEvent<{ event: string }>({
      file,
      match: (e) => e.event === "ready",
      timeoutMs: 2_000,
    });
    queueMicrotask(() => appendFileSync(file, "}\n", "utf8"));
    expect(await pending).toEqual({ event: "ready" });
  });

  it("aborts immediately when signal aborts instead of waiting for timeoutMs", async () => {
    const file = tempLog();
    const controller = new AbortController();
    const pending = waitForJsonLogEvent<{ event: string }>({
      file,
      match: (e) => e.event === "never",
      timeoutMs: 10_000,
      signal: controller.signal,
      label: "never",
    });
    queueMicrotask(() => controller.abort(new Error("child exited early")));
    await expect(pending).rejects.toThrow(/child exited early|aborted/i);
  });

  it("ensures the three load-sensitive test files no longer rely on fragile fixed-time waits", () => {
    const acpTest = readFileSync(join(REPO_ROOT, "src/vendors/_common/acp/driver.test.ts"), "utf8");
    expect(acpTest).toContain("waitForJsonLogEvent");
    expect(acpTest).not.toMatch(/while\s*\(!h\.logs\(\)\.some/);

    const targetPortTest = readFileSync(join(REPO_ROOT, "src/daemon/router/target-port.test.ts"), "utf8");
    expect(targetPortTest).not.toContain("peerDigestTimeoutMs: 60");
    expect(targetPortTest).not.toContain("peerDispatchTimeoutMs: 80");

    const piTest = readFileSync(join(REPO_ROOT, "src/vendors/pi/composer-transcript-handover.test.ts"), "utf8");
    expect(piTest).not.toMatch(/timeoutMs:\s*3_000/);
    expect(piTest).not.toMatch(/vi\.waitFor\([\s\S]{0,120}timeout:\s*3_000/);
  });
});

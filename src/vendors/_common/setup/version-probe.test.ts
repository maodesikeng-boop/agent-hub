import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeTreeWithRetry } from "../../../daemon/platform/index.ts";
import { PROVIDER_VERSION_PROBE_RETRY_MS } from "../../../shared/index.ts";
import { runShortSubcommand } from "./file-helpers.ts";
import { createVendorVersionCache } from "./version-probe.ts";

vi.mock("./file-helpers.ts", () => ({ runShortSubcommand: vi.fn() }));

let cwd: string;
const run = vi.mocked(runShortSubcommand);
const output = (stdout: string) => ({ code: 0, stdout, stderr: "" });

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "bellwood-version-probe-"));
  run.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  return removeTreeWithRetry(cwd);
});

it("shares a probe for the same binary and discards its result if the binary changes", async () => {
  const bin = join(cwd, "agent");
  writeFileSync(bin, "old");
  let finish!: (value: ReturnType<typeof output>) => void;
  run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  run.mockResolvedValueOnce(output("1.2.4"));
  const cache = createVendorVersionCache();

  const first = cache.probe("cursor", bin, { cwd });
  const concurrent = cache.probe("cursor", bin, { cwd });
  expect(run).toHaveBeenCalledTimes(1);
  writeFileSync(join(cwd, "replacement"), "new");
  renameSync(join(cwd, "replacement"), bin);
  const replacement = cache.probe("cursor", bin, { cwd });
  finish(output("1.2.3"));

  await expect(first).resolves.toBeNull();
  await expect(concurrent).resolves.toBeNull();
  await expect(replacement).resolves.toBe("1.2.4");
  expect(cache.peek("cursor", bin)).toBe("1.2.4");
  expect(run).toHaveBeenCalledTimes(2);
});

it("backs off after a failed probe and lets explicit refresh retry immediately", async () => {
  const bin = join(cwd, "agent");
  writeFileSync(bin, "binary");
  run.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" });
  run.mockResolvedValueOnce(output("1.2.3"));
  const cache = createVendorVersionCache();

  await expect(cache.probe("cursor", bin, { cwd })).resolves.toBeNull();
  await expect(cache.probe("cursor", bin, { cwd })).resolves.toBeNull();
  expect(run).toHaveBeenCalledTimes(1);

  cache.invalidate("cursor");
  await expect(cache.probe("cursor", bin, { cwd })).resolves.toBe("1.2.3");
  expect(run).toHaveBeenCalledTimes(2);
});

it("retries a failed probe after the backoff expires", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(Date.now);
  const bin = join(cwd, "agent");
  writeFileSync(bin, "binary");
  run.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" });
  run.mockResolvedValueOnce(output("1.2.3"));
  const cache = createVendorVersionCache();

  await expect(cache.probe("cursor", bin, { cwd })).resolves.toBeNull();
  await vi.advanceTimersByTimeAsync(PROVIDER_VERSION_PROBE_RETRY_MS - 1);
  await expect(cache.probe("cursor", bin, { cwd })).resolves.toBeNull();
  expect(run).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(2);
  await expect(cache.probe("cursor", bin, { cwd })).resolves.toBe("1.2.3");
  expect(run).toHaveBeenCalledTimes(2);
});

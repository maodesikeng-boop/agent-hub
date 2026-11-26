import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_EXEC } from "../src/daemon/driver/write-scope.ts";
import { sandboxAllows } from "./sandbox-probes.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});

describe("test/sandbox-probes.ts", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("recognizes a denied sandbox_apply and keeps setuid ps refusals skippable", () => {
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("exit 71"), { status: 71, stderr: Buffer.from("sandbox-exec: sandbox_apply: Operation not permitted\n") });
      })
      .mockImplementationOnce(() => { throw Object.assign(new Error("spawn ps EPERM"), { code: "EPERM" }); });
    expect(sandboxAllows(SANDBOX_EXEC, [], {})).toBe(false);
    expect(sandboxAllows("ps", [], {})).toBe(false);
  });

  it.each([
    { label: "a different exit status", details: { status: 1, stderr: Buffer.from("Operation not permitted") } },
    { label: "a different diagnostic", details: { status: 71, stderr: Buffer.from("profile parse error") } },
    { label: "a subprocess permission error before launch", details: { code: "EACCES" } },
  ])("reports $label from the nested probe outside CI", ({ label, details }) => {
    const failure = Object.assign(new Error(label), details);
    vi.mocked(execFileSync).mockImplementation(() => { throw failure; });
    expect(() => sandboxAllows(SANDBOX_EXEC, [], {})).toThrow(failure);
    expect(sandboxAllows(SANDBOX_EXEC, [], { CI: "true" })).toBe(true);
  });

  it("surfaces missing commands locally and keeps CI tests running on unrelated failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-probes-"));
    dirs.push(dir);
    const notExecutable = join(dir, "tool");
    writeFileSync(notExecutable, "#!/bin/sh\n");
    chmodSync(notExecutable, 0o644);
    const missing = join(dir, "missing-tool");

    expect(sandboxAllows(process.execPath, ["-e", ""], {})).toBe(true);
    expect(() => sandboxAllows(missing, [], {})).toThrow(/ENOENT/);
    expect(sandboxAllows(missing, [], { CI: "true" })).toBe(true);
    if (process.platform !== "win32") expect(sandboxAllows(notExecutable, [], { CI: "true" })).toBe(false);
  });
});

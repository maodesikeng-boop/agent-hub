import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPermissionRefusal, sandboxAllows } from "./sandbox-probes.ts";

describe("test/sandbox-probes.ts", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("recognizes a refused exec and a refused sandbox_apply as permission refusals", () => {
    expect(isPermissionRefusal(Object.assign(new Error("spawn ps EPERM"), { code: "EPERM" }))).toBe(true);
    expect(isPermissionRefusal(Object.assign(new Error("exit 71"), { status: 71, stderr: Buffer.from("sandbox-exec: sandbox_apply: Operation not permitted\n") }))).toBe(true);
    expect(isPermissionRefusal(Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT" }))).toBe(false);
  });

  it("skips on a permission refusal everywhere, but on CI any other failure keeps the test running", () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-probes-"));
    dirs.push(dir);
    const notExecutable = join(dir, "tool");
    writeFileSync(notExecutable, "#!/bin/sh\n");
    chmodSync(notExecutable, 0o644);
    const missing = join(dir, "missing-tool");

    expect(sandboxAllows(process.execPath, ["-e", ""], {})).toBe(true);
    expect(sandboxAllows(missing, [], {})).toBe(false);
    expect(sandboxAllows(missing, [], { CI: "true" })).toBe(true);
    if (process.platform !== "win32") expect(sandboxAllows(notExecutable, [], { CI: "true" })).toBe(false);
  });
});

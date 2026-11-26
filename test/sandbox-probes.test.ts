import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_EXEC } from "../src/daemon/driver/write-scope.ts";
import { SANDBOX_SKIP_LOG_ENV, callingTestFile, sandboxAllows } from "./sandbox-probes.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});

const NESTED_SANDBOX_PROBE = /(?:SANDBOX_EXEC|(["'])\/usr\/bin\/sandbox-exec\1),\s*\[\s*(["'])-p\2,\s*(["'])\(version 1\)(?:\\n)?\(allow default\)\3/;
const PS_PROBE = /\[\s*(["'])-o\1,\s*(["'])pid=\2,\s*(["'])-p\3/;

function hasInlineProbe(source: string): boolean {
  return NESTED_SANDBOX_PROBE.test(source) || PS_PROBE.test(source);
}

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

  it("records the calling test file when a refusal skips tests, so pnpm test:related can list it", () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-probes-"));
    dirs.push(dir);
    const log = join(dir, "skips.txt");
    vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error("spawn ps EPERM"), { code: "EPERM" }); });
    expect(sandboxAllows("ps", [], {})).toBe(false);
    expect(existsSync(log)).toBe(false);
    expect(sandboxAllows("ps", [], { [SANDBOX_SKIP_LOG_ENV]: log })).toBe(false);
    expect(readFileSync(log, "utf8")).toBe("test/sandbox-probes.test.ts\n");
  });

  it("reads the test file from POSIX, file URL, and Windows stack frames, including paths with spaces", () => {
    const repo = new URL("..", import.meta.url);
    expect(callingTestFile(`Error\n    at probe (${new URL("test/sandbox-probes.ts", repo).pathname}:3:1)\n    at ${new URL("src/a/b.test.ts", repo).href}:9:5`)).toBe("src/a/b.test.ts");
    expect(callingTestFile("Error\n    at probe (/x/test/sandbox-probes.ts:3:1)")).toBeUndefined();
    expect(callingTestFile(undefined)).toBeUndefined();

    const posixRoot = "/Users/me/my repo/";
    expect(callingTestFile("Error\n    at /Users/me/my repo/src/a b.test.ts:4:2", posixRoot)).toBe("src/a b.test.ts");
    expect(callingTestFile("Error\n    at async run (/Users/me/my repo/src/c.test.tsx:4:2)", posixRoot)).toBe("src/c.test.tsx");
    expect(callingTestFile("Error\n    at file:///Users/me/my%20repo/src/d.test.ts:4:2", posixRoot)).toBe("src/d.test.ts");

    const windowsRoot = "C:\\Users\\me\\my repo\\";
    expect(callingTestFile("Error\n    at probe (C:\\Users\\me\\my repo\\src\\e.test.ts:7:3)", windowsRoot)).toBe("src/e.test.ts");
    expect(callingTestFile("Error\n    at C:\\Users\\me\\my repo\\src\\f.test.ts:7:3", windowsRoot)).toBe("src/f.test.ts");
    expect(callingTestFile("Error\n    at file:///C:/Users/me/my%20repo/src/g.test.ts:7:3", windowsRoot)).toBe("src/g.test.ts");
  });

  it.each([
    ["nested probe via the constant", 'canRun = sandbox(SANDBOX_EXEC, ["-p", "(version 1)\\n(allow default)", "/usr/bin/true"]);'],
    ["nested probe via a double-quoted path", 'spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]);'],
    ["nested probe via a single-quoted path", "spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']);"],
    ["ps probe", 'execFileSync("ps", ["-o", "pid=", "-p", String(process.pid)], { stdio: "ignore" });'],
    ["single-quoted ps probe", "execFileSync('ps', ['-o', 'pid=', '-p', String(process.pid)]);"],
  ])("flags an inline %s", (_label, source) => {
    expect(hasInlineProbe(source)).toBe(true);
  });

  it("leaves real sandbox-exec launches and shared probe calls alone", () => {
    expect(hasInlineProbe('spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", script]);')).toBe(false);
    expect(hasInlineProbe('({ command: "/usr/bin/sandbox-exec", args: ["-p", "profile", base.command] });')).toBe(false);
    expect(hasInlineProbe("const canRunPs = process.platform !== \"win32\" && sandboxAllowsPs();")).toBe(false);
  });

  it("keeps every nested sandbox and ps probe in this module so its skips reach the report", () => {
    const offenders: string[] = [];
    const repo = fileURLToPath(new URL("..", import.meta.url));
    for (const root of ["src", "scripts", "test"]) {
      for (const entry of readdirSync(join(repo, root), { recursive: true, encoding: "utf8" })) {
        const file = `${root}/${entry.split("\\").join("/")}`;
        if (!/\.test\.tsx?$/.test(file) || file === "test/sandbox-probes.test.ts") continue;
        if (hasInlineProbe(readFileSync(join(repo, file), "utf8"))) offenders.push(file);
      }
    }
    expect(offenders, "use sandboxAllowsNestedSandbox() or sandboxAllowsPs() from test/sandbox-probes.ts").toEqual([]);
  });
});

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxAllowsNestedSandbox } from "../../../test/sandbox-probes.ts";
import { osSandboxAvailable } from "../driver/write-scope.ts";
import { createWatchCommandRunner, watchSandboxLaunch } from "./launch.ts";
import type { WatchRunJob } from "./runner.ts";

const posixSandbox = (process.platform === "darwin" && sandboxAllowsNestedSandbox()) || (process.platform === "linux" && osSandboxAvailable("linux"));

describe("S5.8: watch commands run read-only with the data directory out of reach", () => {
  let root: string;
  let dataDir: string;
  let project: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-watch-")));
    dataDir = join(root, "data");
    project = join(root, "project");
    mkdirSync(join(dataDir, "state"), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(dataDir, "state", "secret.txt"), "top-secret-token");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const job = (command: string, extra: Partial<WatchRunJob> = {}): WatchRunJob => ({
    watchId: 3, run: 1, command, cwd: project, timeoutMs: 20_000, signal: new AbortController().signal, ...extra,
  });

  it("refuses to run a command when the sandbox cannot be built", async () => {
    const run = createWatchCommandRunner({ dataDir, stateDir: join(dataDir, "state"), tagNonce: "test", sandboxAvailable: () => false });
    const result = await run(job("echo ok"));
    expect(result).toMatchObject({ kind: "error" });
    expect(result.kind === "error" ? result.reason : "").toMatch(/沙箱/u);
  });

  it("macOS profile: everything is read-only except the private temp folder, and the data directory is unreadable", async () => {
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    const launch = await watchSandboxLaunch({ dataDir, stateDir: join(dataDir, "state"), tagNonce: "test", platform: "darwin", baseEnv: { SHELL: "/bin/sh" } }, { command: "gh pr checks 7", cwd: project }, tmp);
    expect(launch?.command).toBe("/usr/bin/sandbox-exec");
    const [flag, profile, ...rest] = launch!.args;
    expect(flag).toBe("-p");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain(`(allow file-write* (subpath "${tmp}"))`);
    expect(profile).not.toContain(`(allow file-write* (subpath "${project}"))`);
    expect(profile).toContain(`(deny file-read* (subpath "${dataDir}"))`);
    expect(rest).toEqual(["/bin/sh", "-c", "gh pr checks 7"]);
  });

  it("Linux arguments: the root is bound read-only, only the temp folder is writable, and the data directory is masked", async () => {
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    const launch = await watchSandboxLaunch({ dataDir, stateDir: join(dataDir, "state"), tagNonce: "test", platform: "linux", baseEnv: { SHELL: "/bin/sh" } }, { command: "true", cwd: project }, tmp);
    const args = launch!.args;
    expect(args.slice(args.indexOf("--ro-bind"), args.indexOf("--ro-bind") + 3)).toEqual(["--ro-bind", "/", "/"]);
    const binds = args.flatMap((arg, i) => (arg === "--bind" ? [args[i + 1]] : []));
    expect(binds).toEqual([tmp]);
    expect(args).not.toContain("--unshare-net");
    expect(args.join(" ")).toContain(dataDir);
    expect(args.slice(-3)).toEqual(["/bin/sh", "-c", "true"]);
  });

  describe.skipIf(!posixSandbox)("inside the OS sandbox", () => {
    const runner = () => createWatchCommandRunner({ dataDir, stateDir: join(dataDir, "state"), tagNonce: "test" });

    it("runs in the project folder and returns the exit code and the output tail", async () => {
      expect(await runner()(job("pwd; echo checks-green"))).toEqual({ kind: "exited", exitCode: 0, outputTail: `${project}\nchecks-green` });
      expect(await runner()(job("echo not-yet; exit 3"))).toMatchObject({ kind: "exited", exitCode: 3, outputTail: "not-yet" });
    });

    it("cannot write in the project folder", async () => {
      const result = await runner()(job("echo x > written.txt"));
      expect(result).toMatchObject({ kind: "exited" });
      expect(result.kind === "exited" ? result.exitCode : 0).not.toBe(0);
      expect(existsSync(join(project, "written.txt"))).toBe(false);
    });

    it("cannot read the data directory", async () => {
      const result = await runner()(job(`cat ${join(dataDir, "state", "secret.txt")}`));
      expect(result.kind === "exited" ? result.exitCode : 0).not.toBe(0);
      expect(result.outputTail).not.toContain("top-secret-token");
    });

    it("stops a command past its timeout and when aborted", async () => {
      expect(await runner()(job("sleep 30", { timeoutMs: 300 }))).toMatchObject({ kind: "timed_out" });
      const controller = new AbortController();
      const pending = runner()(job("sleep 30", { signal: controller.signal }));
      setTimeout(() => controller.abort(), 100);
      expect(await pending).toMatchObject({ kind: "stopped" });
    });
  });
});

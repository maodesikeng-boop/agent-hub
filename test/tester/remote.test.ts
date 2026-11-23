import { execFile, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FakeLedger } from "../../src/daemon/ui-server/fake-ledger.ts";
import { startUiServer } from "../../src/daemon/ui-server/server.ts";
import { createRemoteControl, remoteArgv, type SshSpawn } from "./remote.ts";

const execFileAsync = promisify(execFile);

const REMOTE_SCRIPT = fileURLToPath(new URL("./remote-command.sh", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tester-remote-"));
  dirs.push(dir);
  return dir;
}

describe("remoteArgv", () => {
  it("maps each command to its words", () => {
    expect(remoteArgv({ kind: "status" })).toEqual(["status"]);
    expect(remoteArgv({ kind: "start", mode: "fake" })).toEqual(["start", "fake"]);
    expect(remoteArgv({ kind: "stop" })).toEqual(["stop"]);
    expect(remoteArgv({ kind: "restart", mode: "real" })).toEqual(["restart", "real"]);
    expect(remoteArgv({ kind: "deploy", commit: "a".repeat(40) })).toEqual(["deploy", "a".repeat(40)]);
    expect(remoteArgv({ kind: "logs", lines: 200 })).toEqual(["logs", "200"]);
  });

  it("rejects a commit that is not 40 lowercase hex characters", () => {
    for (const commit of ["A".repeat(40), "a".repeat(39), `${"a".repeat(39)};`, "$(reboot)", "main"]) expect(() => remoteArgv({ kind: "deploy", commit }), commit).toThrow(RangeError);
  });

  it("rejects a line count outside 1..2000", () => {
    for (const lines of [0, 2001, 1.5, -1]) expect(() => remoteArgv({ kind: "logs", lines }), String(lines)).toThrow(RangeError);
    expect(() => remoteArgv({ kind: "start", mode: "evil" as "real" })).toThrow(RangeError);
  });
});

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  killed: string | null;
  kill(signal: string): boolean;
}

function fakeSsh(behave: (child: FakeChild) => void): { spawn: SshSpawn; calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> } {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: null as string | null }) as FakeChild;
    child.kill = (signal: string) => {
      child.killed = signal;
      setImmediate(() => child.emit("exit", null));
      return true;
    };
    setImmediate(() => behave(child));
    return child;
  }) as unknown as SshSpawn;
  return { spawn, calls };
}

describe("createRemoteControl", () => {
  it("runs ssh with the alias and the checked words, without a shell", async () => {
    const ssh = fakeSsh((child) => {
      child.stdout.end("active\ncommit abc\n");
      child.emit("exit", 0);
    });
    const control = createRemoteControl({ sshAlias: "bellwood-tester", timeoutMs: 1_000, spawn: ssh.spawn });
    expect(await control.status()).toBe("active\ncommit abc\n");
    await control.restart("fake");
    expect(ssh.calls.map((c) => [c.command, ...c.args])).toEqual([
      ["ssh", "-o", "BatchMode=yes", "-T", "bellwood-tester", "status"],
      ["ssh", "-o", "BatchMode=yes", "-T", "bellwood-tester", "restart", "fake"],
    ]);
    expect(ssh.calls[0]!.options.shell).toBe(false);
    await expect(control.deploy("not-a-sha")).rejects.toThrow(RangeError);
    expect(ssh.calls).toHaveLength(2);
  });

  it("rejects with the remote's stderr on a non-zero exit", async () => {
    const ssh = fakeSsh((child) => {
      child.stderr.end("unknown command\n");
      setImmediate(() => child.emit("exit", 2));
    });
    await expect(createRemoteControl({ sshAlias: "b", timeoutMs: 1_000, spawn: ssh.spawn }).stop()).rejects.toThrow(/exited 2: unknown command/);
  });

  it("rejects after timeoutMs and kills the ssh process", async () => {
    let child: FakeChild | null = null;
    const ssh = fakeSsh((c) => (child = c));
    await expect(createRemoteControl({ sshAlias: "b", timeoutMs: 50, spawn: ssh.spawn }).logs(10)).rejects.toThrow(/timed out after 0.05 s/);
    expect(child!.killed).toBe("SIGKILL");
  });
});

describe("remote-command.sh", () => {
  function setupRemoteStubs() {
    const root = scratch();
    const home = join(root, "home");
    const appDir = join(home, "agent-hub");
    const bin = join(home, ".local", "bin");
    const stubs = join(root, "stubs");
    mkdirSync(appDir, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(stubs, { recursive: true });
    mkdirSync(join(appDir, "scripts"), { recursive: true });
    mkdirSync(join(appDir, "test", "tester"), { recursive: true });
    mkdirSync(join(home, ".agent-hub", "state"), { recursive: true });
    writeFileSync(join(home, ".agent-hub", "state", "ui-token"), "stub-ui-token-0123456789abcdef\n");
    writeFileSync(join(appDir, ".deployed-sha"), `${"a".repeat(40)}\n`);
    writeFileSync(join(appDir, "scripts", "print-vendors.ts"), 'console.log("claude\\tclaude\\t\\t\\npi\\tpi\\t\\t");\n');
    writeFileSync(join(appDir, "test", "tester", "cli.ts"), 'console.log(JSON.stringify({ defaultTurn: { steps: [{ text: "ok" }] }, sessions: [] }));\n');
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho 2.0.0\n");
    chmodSync(join(bin, "claude"), 0o755);
    const logFile = join(root, "calls.log");
    const stub = (name: string, body: string) => {
      writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(stubs, name), 0o755);
    };
    stub("systemctl", `echo "systemctl $*" >> "${logFile}"\nif [ "$2" = "is-active" ]; then echo active; fi`);
    stub("journalctl", `echo "journalctl $*" >> "${logFile}"\necho "line 1"`);
    stub("curl", `echo "200"`);
    const nodeBin = join(stubs, "node");
    writeFileSync(nodeBin, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    chmodSync(nodeBin, 0o755);
    const run = (sshOriginal: string) =>
      spawnSync("bash", [REMOTE_SCRIPT], {
        encoding: "utf8",
        env: { HOME: home, PATH: `${stubs}:${bin}:/usr/bin:/bin`, SSH_ORIGINAL_COMMAND: sshOriginal, BELLWOOD_TESTER_APP_DIR: appDir },
      });
    return { home, appDir, logFile, run };
  }

  it("rejects unknown commands, wrong arity, out-of-range args, and shell metacharacters", () => {
    const { run } = setupRemoteStubs();
    for (const cmd of ["", "status; id", "deploy $(whoami)", "deploy main", "start maybe", "logs 0", "logs 2001", "status extra", "rm -rf /"]) {
      const res = run(cmd);
      expect(res.status, cmd).toBe(2);
    }
  });

  it("reports service, deployed commit, and per-vendor CLI state on status", () => {
    const { run } = setupRemoteStubs();
    const res = run("status");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("service active");
    expect(res.stdout).toContain(`commit ${"a".repeat(40)}`);
    expect(res.stdout).toContain("cli claude installed 2.0.0");
    expect(res.stdout).toContain("cli pi missing");
  });

  it("detects vendor CLIs installed in vendor-specific home bin directories", () => {
    const { home, appDir, run } = setupRemoteStubs();
    writeFileSync(
      join(appDir, "scripts", "print-vendors.ts"),
      'console.log("opencode\\topencode\\t\\t\\nkimi\\tkimi\\t\\t\\npi\\tpi\\t\\t");\n',
    );
    for (const [relDir, name, version] of [
      [".opencode/bin", "opencode", "opencode 1.2.3"],
      [".kimi-code/bin", "kimi", "kimi 0.9.0"],
      [".pi/bin", "pi", "pi 0.4.0"],
    ] as const) {
      const dir = join(home, relDir);
      mkdirSync(dir, { recursive: true });
      const exe = join(dir, name);
      writeFileSync(exe, `#!/bin/sh\necho '${version}'\n`);
      chmodSync(exe, 0o755);
    }
    const res = run("status");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("cli opencode installed opencode 1.2.3");
    expect(res.stdout).toContain("cli kimi installed kimi 0.9.0");
    expect(res.stdout).toContain("cli pi installed pi 0.4.0");
  });

  it("switches systemd mode env between fake and real", () => {
    const { home, run } = setupRemoteStubs();
    expect(run("restart fake").status).toBe(0);
    const fakeEnv = readFileSync(join(home, ".config", "systemd", "user", "bellwood-tester.mode.env"), "utf8");
    expect(fakeEnv).toContain("AGENT_HUB_CLAUDE_PATH=");
    expect(fakeEnv).toContain("FAKE_CLAUDE_SCRIPT=");
    expect(run("start real").status).toBe(0);
    expect(readFileSync(join(home, ".config", "systemd", "user", "bellwood-tester.mode.env"), "utf8")).toBe("");
  });

  it("forwards logs within the allowed line range", () => {
    const { logFile, run } = setupRemoteStubs();
    const logs = run("logs 25");
    expect(logs.status).toBe(0);
    expect(logs.stdout).toContain("line 1");
    expect(readFileSync(logFile, "utf8")).toContain("journalctl --user -u bellwood-tester -n 25 --no-pager");
  });

  it("authenticates /api/health via /auth?token=... against a real ui-server while rejecting unauthenticated /api/health", async () => {
    const root = scratch();
    const home = join(root, "home");
    const stubs = join(root, "stubs");
    const appDir = join(home, "agent-hub");
    const dataDir = join(root, "data");
    const altDataDir = join(root, "alt-data");
    const token = "real-ui-token-0123456789abcdef";
    mkdirSync(join(appDir, "test", "tester"), { recursive: true });
    mkdirSync(join(dataDir, "state"), { recursive: true });
    mkdirSync(join(altDataDir, "state"), { recursive: true });
    mkdirSync(stubs, { recursive: true });
    writeFileSync(join(appDir, "test", "tester", "cli.ts"), 'console.log("{}");\n');
    for (const [name, body] of [
      ["systemctl", "exit 0"],
      ["journalctl", "exit 0"],
    ] as const) {
      writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(stubs, name), 0o755);
    }

    const srv = await startUiServer({
      port: 0,
      token,
      ledger: new FakeLedger().asLedger(),
      uploadsDir: join(root, "uploads"),
      sentFilesDir: join(root, "sent-files"),
      staticDir: join(root, "missing-static"),
    });
    try {
      const bareHealth = await fetch(`http://127.0.0.1:${srv.port}/api/health`);
      expect(bareHealth.status).toBe(401);

      const baseEnv = {
        HOME: home,
        PATH: `${stubs}:/usr/bin:/bin`,
        BELLWOOD_TESTER_APP_DIR: appDir,
        BELLWOOD_TESTER_PORT: String(srv.port),
      };

      writeFileSync(join(dataDir, "state", "ui-token"), "wrong-ui-token-0123456789abcdef\n");
      const badRun = await execFileAsync("bash", [REMOTE_SCRIPT], {
        env: {
          ...baseEnv,
          SSH_ORIGINAL_COMMAND: "restart real",
          BELLWOOD_TESTER_DATA_DIR: dataDir,
          BELLWOOD_TESTER_HEALTH_TIMEOUT_S: "1",
        },
      }).then(
        () => ({ code: 0, stderr: "" }),
        (err: { code?: number; stderr?: string }) => ({ code: err.code ?? 1, stderr: err.stderr ?? "" }),
      );
      expect(badRun.code).toBe(1);
      expect(badRun.stderr).toContain("did not answer /api/health within 1 s");

      writeFileSync(join(dataDir, "state", "ui-token"), `${token}\n`);
      await execFileAsync("bash", [REMOTE_SCRIPT], {
        env: {
          ...baseEnv,
          SSH_ORIGINAL_COMMAND: "restart real",
          BELLWOOD_TESTER_DATA_DIR: dataDir,
          BELLWOOD_TESTER_HEALTH_TIMEOUT_S: "5",
        },
      });

      writeFileSync(join(altDataDir, "state", "ui-token"), `${token}\n`);
      await execFileAsync("bash", [REMOTE_SCRIPT], {
        env: {
          ...baseEnv,
          SSH_ORIGINAL_COMMAND: "start real",
          AGENT_HUB_HOME: altDataDir,
          BELLWOOD_TESTER_HEALTH_TIMEOUT_S: "5",
        },
      });
    } finally {
      await srv.close();
    }
  });
});

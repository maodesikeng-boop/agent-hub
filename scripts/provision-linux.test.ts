// Covers POSIX shell provisioning in scripts/provision-linux.sh across macOS Bash 3.2 and Linux.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TEST_TIMEOUT_MS } from "../src/shared/limits.ts";

const execFileAsync = promisify(execFile);
const PROVISION_SCRIPT = fileURLToPath(new URL("./provision-linux.sh", import.meta.url));
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const dirs: string[] = [];
let sharedStubs = "";

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  if (sharedStubs) rmSync(sharedStubs, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "provision-linux-test-"));
  dirs.push(dir);
  return dir;
}

function writeExe(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const SERVER_STUB_NAMES = [
  "dpkg",
  "loginctl",
  "curl",
  "ss",
  "free",
  "python3",
  "awk",
  "id",
  "getent",
  "sudo",
  "node",
  "pnpm",
  "systemctl",
  "npm",
] as const;

beforeAll(() => {
  sharedStubs = mkdtempSync(join(tmpdir(), "provision-linux-stubs-"));
  writeExe(sharedStubs, "dpkg", "exit 0");
  writeExe(sharedStubs, "loginctl", 'echo "Linger=yes"');
  writeExe(sharedStubs, "curl", 'echo "200"');
  writeExe(sharedStubs, "ss", "exit 0");
  writeExe(sharedStubs, "free", "exit 0");
  writeExe(
    sharedStubs,
    "python3",
    `case "$*" in
  *"['engines']['node']"*) echo ">=22" ;;
  *"['packageManager']"*) echo "pnpm@10.12.0" ;;
  *) exec /usr/bin/python3 "$@" ;;
esac`,
  );
  writeExe(
    sharedStubs,
    "awk",
    `case "$*" in
  *"/proc/swaps"*) echo "4194304"; exit 0 ;;
  *"/proc/"*"/status"*) echo "10 MB"; exit 0 ;;
esac
exec /usr/bin/awk "$@"`,
  );
  writeExe(
    sharedStubs,
    "id",
    `if [ -n "\${TEST_TARGET_USER:-}" ] && [ "\${1:-}" = "$TEST_TARGET_USER" ]; then echo "uid=1001($TEST_TARGET_USER)"; exit 0; fi
exec /usr/bin/id "$@"`,
  );
  writeExe(
    sharedStubs,
    "getent",
    `if [ "\${1:-}" = "passwd" ] && [ -n "\${TEST_TARGET_USER:-}" ] && [ "\${2:-}" = "$TEST_TARGET_USER" ]; then
  echo "$TEST_TARGET_USER:x:1001:1001::$TEST_TARGET_HOME:/bin/bash"
  exit 0
fi
exit 2`,
  );
  writeExe(
    sharedStubs,
    "sudo",
    `if [ "\${1:-}" = "-n" ] && [ "\${2:-}" = "true" ]; then exit 0; fi
echo "sudo:$*" >> "$TEST_LOG"
exec "$@"`,
  );
  writeExe(
    sharedStubs,
    "node",
    `if [ "\${1:-}" = "-v" ]; then echo "v22.15.0"; exit 0; fi
case "\${1:-}" in
  *print-vendors.ts)
    printf 'opencode\\topencode\\t\\topencode auth\\n'
    printf 'kimi\\tkimi\\t\\tkimi login\\n'
    exit 0
    ;;
esac
exec "$TEST_NODE_EXEC" "$@"`,
  );
  writeExe(
    sharedStubs,
    "pnpm",
    `if [ -n "\${TEST_LOG:-}" ]; then echo "pnpm-cwd:$(pwd -P)" >> "$TEST_LOG"; fi
if [ "\${1:-}" = "-v" ]; then echo "10.12.0"; exit 0; fi
exit 0`,
  );
  writeExe(
    sharedStubs,
    "systemctl",
    `if [ -n "\${TEST_LOG:-}" ]; then echo "systemctl:$*" >> "$TEST_LOG"; fi
case "$*" in
  *"show -p MainPID"*) echo "0" ;;
esac
exit 0`,
  );
  writeExe(sharedStubs, "npm", 'if [ -n "${TEST_LOG:-}" ]; then echo "npm:$*" >> "$TEST_LOG"; fi');
});

function linkServerStubs(home: string): string {
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of SERVER_STUB_NAMES) symlinkSync(join(sharedStubs, name), join(bin, name));
  return bin;
}

async function runProvision(
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(BASH, [PROVISION_SCRIPT, ...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
    });
    return { status: 0, stdout, stderr };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return { status: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

describe.skipIf(process.platform === "win32")("scripts/provision-linux.sh", () => {
  it("expands braced variables adjacent to Chinese punctuation under macOS /bin/bash UTF-8 nounset", async () => {
    const root = scratch();
    const stubs = join(root, "stubs");
    const logFile = join(root, "ssh.log");
    const repo = join(root, "repo");
    const sha = "1234567890abcdef1234567890abcdef12345678";
    mkdirSync(repo, { recursive: true });
    writeFileSync(logFile, "");

    writeExe(
      stubs,
      "git",
      `if [ "\${3:-}" = "rev-parse" ] && [ "\${4:-}" = "--show-toplevel" ]; then echo "${repo}"; exit 0; fi
if [ "\${3:-}" = "rev-parse" ] && [ "\${4:-}" = "--verify" ]; then echo "${sha}"; exit 0; fi
exit 1`,
    );
    writeExe(
      stubs,
      "ssh",
      `echo "ssh:$*" >> "${logFile}"
last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  "id -un") echo "ubuntu" ;;
  *"id -u bellwood-test"*) echo "1001" ;;
  *"getent passwd"*) echo "/home/bellwood-test" ;;
  *".deployed-sha"*) echo "${sha}" ;;
  *"bash -s --"*) cat >/dev/null ;;
esac
exit 0`,
    );

    const env = {
      ...process.env,
      LANG: "zh_CN.UTF-8",
      LC_ALL: "zh_CN.UTF-8",
      PATH: `${stubs}:${dirname(process.execPath)}:/usr/bin:/bin`,
    };

    const withAll = await runProvision(
      ["-i", "/tmp/key", "--ref", "HEAD", "--port", "4417", "--mesh-port", "4421", "--user", "bellwood-test", "--service", "bellwood-tester", "ubuntu@example"],
      { env },
    );
    expect(withAll.status, withAll.stderr).toBe(0);
    expect(withAll.stderr).not.toContain("unbound variable");
    expect(withAll.stdout).toContain("（用户 bellwood-test），端口 4417，mesh 4421，服务 bellwood-tester");
    expect(withAll.stdout).toContain("ssh -i /tmp/key -N -L 4417:127.0.0.1:4417 ubuntu@example");

    const minimal = await runProvision(["--ref", "HEAD", "--port", "4417", "ubuntu@example"], { env });
    expect(minimal.status, minimal.stderr).toBe(0);
    expect(minimal.stderr).not.toContain("unbound variable");
    expect(minimal.stdout).toContain("→ ubuntu@example，端口 4417，服务 agent-hub");
  });

  it("ignores private pnpm during --host-only --user and installs to the shared prefix", async () => {
    const root = scratch();
    const ubuntuHome = join(root, "home-ubuntu");
    const targetHome = join(root, "home-bellwood-test");
    const sysPrefix = join(root, "sys-local");
    const sysBin = join(sysPrefix, "bin");
    const privatePnpmDir = join(ubuntuHome, ".local", "share", "pnpm");
    const logFile = join(root, "host-only.log");
    mkdirSync(ubuntuHome, { recursive: true });
    mkdirSync(join(targetHome, "agent-hub"), { recursive: true });
    mkdirSync(sysBin, { recursive: true });
    writeFileSync(logFile, "");
    writeFileSync(
      join(targetHome, "agent-hub", "package.json"),
      JSON.stringify({ engines: { node: ">=22" }, packageManager: "pnpm@10.12.0" }),
    );

    const bin = linkServerStubs(ubuntuHome);
    writeExe(privatePnpmDir, "pnpm", 'echo "10.12.0"');

    const env = {
      ...process.env,
      HOME: ubuntuHome,
      USER: "ubuntu",
      LANG: "zh_CN.UTF-8",
      PATH: `${bin}:${privatePnpmDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      PROVISION_SYSTEM_BIN_DIRS: `${sysBin}:/bin`,
      PROVISION_SYSTEM_PREFIX: sysPrefix,
      TEST_TARGET_USER: "bellwood-test",
      TEST_TARGET_HOME: targetHome,
      TEST_LOG: logFile,
      TEST_NODE_EXEC: process.execPath,
    };

    const installRun = await runProvision(["--on-server", "--host-only", "--user", "bellwood-test", "--app-dir", "agent-hub"], { env });
    expect(installRun.status, installRun.stderr).toBe(0);
    expect(installRun.stdout).toContain("装 pnpm@10.12.0");
    expect(installRun.stdout).not.toContain("跳过：pnpm");
    expect(readFileSync(logFile, "utf8")).toContain(`npm:install -g --prefix ${sysPrefix} pnpm@10.12.0`);

    writeFileSync(logFile, "");
    writeExe(sysBin, "pnpm", 'echo "10.12.0"');
    const skipRun = await runProvision(["--on-server", "--host-only", "--user", "bellwood-test", "--app-dir", "agent-hub"], { env });
    expect(skipRun.status, skipRun.stderr).toBe(0);
    expect(skipRun.stdout).toContain("跳过：pnpm 10.12.0");
    expect(readFileSync(logFile, "utf8")).not.toContain("npm:install");
  }, TEST_TIMEOUT_MS * 2);

  it("changes to HOME at start of on_server and includes vendor CLI bin dirs in service and report PATH", async () => {
    const root = scratch();
    const startDir = join(root, "ubuntu-cwd");
    const targetHome = join(root, "bellwood-home");
    const appDir = join(targetHome, "agent-hub");
    const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const logFile = join(root, "server.log");
    mkdirSync(startDir, { recursive: true });
    mkdirSync(join(appDir, "dist", "web"), { recursive: true });
    mkdirSync(join(appDir, "node_modules"), { recursive: true });
    mkdirSync(join(appDir, "scripts"), { recursive: true });
    writeFileSync(logFile, "");
    writeFileSync(join(appDir, ".deployed-sha"), `${sha}\n`);
    writeFileSync(join(appDir, "scripts", "print-vendors.ts"), "");
    writeFileSync(
      join(appDir, "package.json"),
      JSON.stringify({ engines: { node: ">=22" }, packageManager: "pnpm@10.12.0" }),
    );

    linkServerStubs(targetHome);
    writeExe(join(targetHome, ".opencode", "bin"), "opencode", 'echo "opencode 1.2.3"');
    writeExe(join(targetHome, ".kimi-code", "bin"), "kimi", 'echo "kimi 0.9.0"');

    const res = await runProvision(
      ["--on-server", "--sha", sha, "--port", "4417", "--mesh-port", "4421", "--user", "bellwood-test", "--service", "bellwood-tester"],
      {
        cwd: startDir,
        env: {
          ...process.env,
          HOME: targetHome,
          USER: "bellwood-test",
          LANG: "zh_CN.UTF-8",
          PATH: "/usr/bin:/bin",
          TEST_TARGET_USER: "bellwood-test",
          TEST_TARGET_HOME: targetHome,
          TEST_LOG: logFile,
          TEST_NODE_EXEC: process.execPath,
        },
      },
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).not.toContain("unbound variable");
    expect(res.stdout).toContain("（mesh 端口 4421）");
    expect(res.stdout).toContain("opencode: opencode 1.2.3");
    expect(res.stdout).toContain("kimi: kimi 0.9.0");
    expect(res.stdout).not.toContain("未安装");

    expect(readFileSync(logFile, "utf8")).toContain(`pnpm-cwd:${realpathSync(targetHome)}`);

    const unit = readFileSync(join(targetHome, ".config", "systemd", "user", "bellwood-tester.service"), "utf8");
    expect(unit).toContain(
      `Environment=PATH=${targetHome}/.local/bin:${targetHome}/.opencode/bin:${targetHome}/.kimi-code/bin:${targetHome}/.pi/bin:${targetHome}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`,
    );
  }, TEST_TIMEOUT_MS * 2);
});

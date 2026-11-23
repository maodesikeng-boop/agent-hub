// Covers POSIX shell provisioning in scripts/provision-linux.sh across macOS Bash 3.2 and Linux.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PROVISION_SCRIPT = fileURLToPath(new URL("./provision-linux.sh", import.meta.url));
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

function setupServerStubs(home: string, opts: { targetHome?: string; targetUser?: string; logFile: string }): string {
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const targetHome = opts.targetHome ?? home;
  const targetUser = opts.targetUser ?? "bellwood-test";

  writeExe(bin, "dpkg", "exit 0");
  writeExe(bin, "loginctl", 'echo "Linger=yes"');
  writeExe(bin, "curl", 'echo "200"');
  writeExe(bin, "ss", "exit 0");
  writeExe(bin, "free", "exit 0");
  writeExe(
    bin,
    "python3",
    `case "$*" in
  *"['engines']['node']"*) echo ">=22" ;;
  *"['packageManager']"*) echo "pnpm@10.12.0" ;;
  *) exec /usr/bin/python3 "$@" ;;
esac`,
  );
  writeExe(
    bin,
    "awk",
    `case "$*" in
  *"/proc/swaps"*) echo "4194304"; exit 0 ;;
  *"/proc/"*"/status"*) echo "10 MB"; exit 0 ;;
esac
exec /usr/bin/awk "$@"`,
  );
  writeExe(
    bin,
    "id",
    `if [ "\${1:-}" = "${targetUser}" ]; then echo "uid=1001(${targetUser})"; exit 0; fi
exec /usr/bin/id "$@"`,
  );
  writeExe(
    bin,
    "getent",
    `if [ "\${1:-}" = "passwd" ] && [ "\${2:-}" = "${targetUser}" ]; then
  echo "${targetUser}:x:1001:1001::${targetHome}:/bin/bash"
  exit 0
fi
exit 2`,
  );
  writeExe(
    bin,
    "sudo",
    `if [ "\${1:-}" = "-n" ] && [ "\${2:-}" = "true" ]; then exit 0; fi
echo "sudo:$*" >> "${opts.logFile}"
exec "$@"`,
  );
  writeExe(
    bin,
    "node",
    `if [ "\${1:-}" = "-v" ]; then echo "v22.15.0"; exit 0; fi
case "\${1:-}" in
  *print-vendors.ts)
    printf 'opencode\\topencode\\t\\topencode auth\\n'
    printf 'kimi\\tkimi\\t\\tkimi login\\n'
    printf 'pi\\tpi\\t\\tpi\\n'
    exit 0
    ;;
esac
exec ${JSON.stringify(process.execPath)} "$@"`,
  );
  writeExe(
    bin,
    "pnpm",
    `echo "pnpm-cwd:$(pwd -P)" >> "${opts.logFile}"
if [ "\${1:-}" = "-v" ]; then echo "10.12.0"; exit 0; fi
exit 0`,
  );
  writeExe(
    bin,
    "systemctl",
    `echo "systemctl:$*" >> "${opts.logFile}"
case "$*" in
  *"show -p MainPID"*) echo "0" ;;
esac
exit 0`,
  );
  writeExe(bin, "npm", `echo "npm:$*" >> "${opts.logFile}"`);
  return bin;
}

describe.skipIf(process.platform === "win32")("scripts/provision-linux.sh", () => {
  it("expands braced variables adjacent to Chinese punctuation under macOS /bin/bash UTF-8 nounset", () => {
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

    const withAll = spawnSync(
      BASH,
      [
        PROVISION_SCRIPT,
        "-i",
        "/tmp/key",
        "--ref",
        "HEAD",
        "--port",
        "4417",
        "--mesh-port",
        "4421",
        "--user",
        "bellwood-test",
        "--service",
        "bellwood-tester",
        "ubuntu@example",
      ],
      { encoding: "utf8", env },
    );
    expect(withAll.status, withAll.stderr).toBe(0);
    expect(withAll.stderr).not.toContain("unbound variable");
    expect(withAll.stdout).toContain("（用户 bellwood-test），端口 4417，mesh 4421，服务 bellwood-tester");
    expect(withAll.stdout).toContain("ssh -i /tmp/key -N -L 4417:127.0.0.1:4417 ubuntu@example");

    const minimal = spawnSync(BASH, [PROVISION_SCRIPT, "--ref", "HEAD", "--port", "4417", "ubuntu@example"], {
      encoding: "utf8",
      env,
    });
    expect(minimal.status, minimal.stderr).toBe(0);
    expect(minimal.stderr).not.toContain("unbound variable");
    expect(minimal.stdout).toContain("→ ubuntu@example，端口 4417，服务 agent-hub");
  });

  it("ignores private pnpm during --host-only --user and installs to the shared prefix", () => {
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

    const bin = setupServerStubs(ubuntuHome, { targetHome, targetUser: "bellwood-test", logFile });
    writeExe(privatePnpmDir, "pnpm", 'echo "10.12.0"');

    const env = {
      ...process.env,
      HOME: ubuntuHome,
      USER: "ubuntu",
      LANG: "zh_CN.UTF-8",
      PATH: `${bin}:${privatePnpmDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      PROVISION_SYSTEM_BIN_DIRS: `${sysBin}:/bin`,
      PROVISION_SYSTEM_PREFIX: sysPrefix,
    };

    const installRun = spawnSync(
      BASH,
      [PROVISION_SCRIPT, "--on-server", "--host-only", "--user", "bellwood-test", "--app-dir", "agent-hub"],
      { encoding: "utf8", env },
    );
    expect(installRun.status, installRun.stderr).toBe(0);
    expect(installRun.stdout).toContain("装 pnpm@10.12.0");
    expect(installRun.stdout).not.toContain("跳过：pnpm");
    const log = readFileSync(logFile, "utf8");
    expect(log).toContain(`npm:install -g --prefix ${sysPrefix} pnpm@10.12.0`);

    writeFileSync(logFile, "");
    writeExe(sysBin, "pnpm", 'echo "10.12.0"');
    const skipRun = spawnSync(
      BASH,
      [PROVISION_SCRIPT, "--on-server", "--host-only", "--user", "bellwood-test", "--app-dir", "agent-hub"],
      { encoding: "utf8", env },
    );
    expect(skipRun.status, skipRun.stderr).toBe(0);
    expect(skipRun.stdout).toContain("跳过：pnpm 10.12.0");
    expect(readFileSync(logFile, "utf8")).not.toContain("npm:install");
  });

  it("changes to HOME at start of on_server and includes vendor CLI bin dirs in service and report PATH", () => {
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

    setupServerStubs(targetHome, { targetHome, targetUser: "bellwood-test", logFile });
    writeExe(join(targetHome, ".opencode", "bin"), "opencode", 'echo "opencode 1.2.3"');
    writeExe(join(targetHome, ".kimi-code", "bin"), "kimi", 'echo "kimi 0.9.0"');
    writeExe(join(targetHome, ".pi", "bin"), "pi", 'echo "pi 0.4.0"');

    const res = spawnSync(
      BASH,
      [
        PROVISION_SCRIPT,
        "--on-server",
        "--sha",
        sha,
        "--port",
        "4417",
        "--mesh-port",
        "4421",
        "--user",
        "bellwood-test",
        "--service",
        "bellwood-tester",
      ],
      {
        cwd: startDir,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: targetHome,
          USER: "bellwood-test",
          LANG: "zh_CN.UTF-8",
          PATH: "/usr/bin:/bin",
        },
      },
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).not.toContain("unbound variable");
    expect(res.stdout).toContain("（mesh 端口 4421）");
    expect(res.stdout).toContain("opencode: opencode 1.2.3");
    expect(res.stdout).toContain("kimi: kimi 0.9.0");
    expect(res.stdout).toContain("pi: pi 0.4.0");
    expect(res.stdout).not.toContain("未安装");

    expect(readFileSync(logFile, "utf8")).toContain(`pnpm-cwd:${realpathSync(targetHome)}`);

    const unit = readFileSync(join(targetHome, ".config", "systemd", "user", "bellwood-tester.service"), "utf8");
    expect(unit).toContain(
      `Environment=PATH=${targetHome}/.local/bin:${targetHome}/.opencode/bin:${targetHome}/.kimi-code/bin:${targetHome}/.pi/bin:${targetHome}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`,
    );
  });
});

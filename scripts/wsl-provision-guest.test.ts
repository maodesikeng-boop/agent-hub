import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VENDOR_PATHS } from "../src/vendors/paths-registry.ts";
import { VENDOR_LIST } from "../src/vendors/registry.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(THIS_DIR, "..");
const GUEST_SCRIPT = join(THIS_DIR, "wsl-provision-guest.sh");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeExecutable(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function resolveHostCommand(name: string): string {
  const dirs = ["/usr/bin", "/bin", ...(process.env.PATH ?? "").split(":").filter(Boolean)];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续查找下一个候选目录
    }
  }
  throw new Error(`找不到基础系统命令 ${name}`);
}

function populateIsolatedSysBin(sysBin: string, commands: readonly string[]): void {
  mkdirSync(sysBin, { recursive: true });
  for (const cmd of commands) {
    symlinkSync(resolveHostCommand(cmd), join(sysBin, cmd));
  }
}

function runGuest(args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const res = spawnSync("bash", [GUEST_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME ?? tmpdir(),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function compareSemverGe(have: string, need: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(have);
  const b = parse(need);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true;
}

function createFakeNodeTarXz(workDir: string, version: string, pnpmLogFile: string): { archivePath: string; sha256: string } {
  const pkgRoot = join(workDir, `node-v${version}-linux-x64`);
  const binDir = join(pkgRoot, "bin");
  mkdirSync(binDir, { recursive: true });

  writeExecutable(
    join(binDir, "node"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "-v" ] || [ "\${1:-}" = "--version" ]; then
  echo "v${version}"
  exit 0
fi
exec "${process.execPath}" "$@"
`,
  );

  writeExecutable(
    join(binDir, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
echo "npm $*" >> "${pnpmLogFile}"
prefix=""
pkg=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    *.tgz) pkg="$1"; shift ;;
    *) shift ;;
  esac
done
[ -f "$pkg" ] || { echo "npm: 只接受已校验的本地 tgz：$pkg" >&2; exit 1; }
ver="$(basename "$pkg" .tgz)"
ver="\${ver#pnpm-}"
mkdir -p "$prefix/bin"
cat > "$prefix/bin/pnpm" <<EOF
#!/usr/bin/env bash
if [ "\\\${1:-}" = "-v" ] || [ "\\\${1:-}" = "--version" ]; then
  echo "\${ver}"
  exit 0
fi
echo "fake-pnpm \\\${*}"
EOF
chmod 0755 "$prefix/bin/pnpm"
`,
  );

  writeExecutable(join(binDir, "npx"), "#!/usr/bin/env bash\necho npx\n");

  const archiveName = `node-v${version}-linux-x64.tar.xz`;
  const archivePath = join(workDir, archiveName);
  execFileSync("tar", ["-cJf", archivePath, "-C", workDir, `node-v${version}-linux-x64`]);
  const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  return { archivePath, sha256 };
}

/** 创建模拟真 bwrap 读写隔离语义的测试替身（使 macOS 与无特权环境也能测试 --self-test 的全部成功与失败分支）。 */
function writeFakeBwrap(binPath: string, mode: "enforcing" | "leaky" | "broken"): void {
  if (mode === "broken") {
    writeExecutable(binPath, "#!/usr/bin/env bash\necho 'setting up uid map: Permission denied' >&2\nexit 1\n");
    return;
  }

  writeExecutable(
    binPath,
    `#!/usr/bin/env bash
set -euo pipefail
ro_dirs=()
rw_dirs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --ro-bind) ro_dirs+=("$3"); shift 3 ;;
    --bind) rw_dirs+=("$3"); shift 3 ;;
    --dev-bind) shift 3 ;;
    --proc|--tmpfs|--perms|--unsetenv) shift 2 ;;
    --setenv) export "$2=$3"; shift 3 ;;
    --unshare-user|--disable-userns|--unshare-pid) shift ;;
    --) shift; break ;;
    *) shift ;;
  esac
done

if [ "\${1:-}" = "/bin/true" ]; then
  exit 0
fi

if [ "${mode}" = "enforcing" ] && [ "\${1:-}" = "/bin/sh" ] && [ "\${2:-}" = "-c" ]; then
  denied_target="\${5:-}"
  allowed_target="\${6:-}"
  # 模拟只读挂载拒绝写 state 目录（EROFS），同时放行被 --bind 覆盖的临时工作目录
  mkdir -p "$(dirname "$allowed_target")"
  printf 'ok' > "$allowed_target"
  exit 0
fi

exec "$@"
`,
  );
}

describe("wsl-provision-guest.sh 静态契约与插件化守卫", () => {
  it("锁定的 Node 与 pnpm 版本满足根 package.json 的 engines.node 与 packageManager 要求", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      packageManager: string;
      engines: { node: string };
    };
    const res = runGuest(["--print-constants"]);
    expect(res.status, res.stderr).toBe(0);
    const constants = JSON.parse(res.stdout) as {
      node_version: string;
      node_linux_x64_sha256: string;
      pnpm_version: string;
      pnpm_tarball_sha256: string;
    };

    const minNode = pkg.engines.node.replace(/^[>=^\s]+/, "");
    const expectedPnpm = pkg.packageManager.replace(/^pnpm@/, "").replace(/\+.*$/, "");

    expect(compareSemverGe(constants.node_version, minNode)).toBe(true);
    expect(constants.node_linux_x64_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(constants.pnpm_version).toBe(expectedPnpm);
    expect(constants.pnpm_tarball_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("wsl-provision-guest.sh 与 Rust 源码绝不硬编码任何厂商编号或 CLI 命令名", () => {
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const terms = [...new Set(VENDOR_LIST.flatMap((v) => [v.id, v.cli.command]))];
    const quotedVendorRe = new RegExp(`["'\`](${terms.map(escapeRe).join("|")})["'\`]`);

    const filesToCheck: string[] = [GUEST_SCRIPT];
    const rustSrcDir = join(REPO_ROOT, "apps", "windows", "crates", "fusa-wsl", "src");
    if (existsSync(rustSrcDir)) {
      for (const entry of readdirSync(rustSrcDir, { withFileTypes: true, recursive: true })) {
        if (entry.isFile() && entry.name.endsWith(".rs")) {
          filesToCheck.push(join(entry.parentPath, entry.name));
        }
      }
    }

    const hits: string[] = [];
    for (const file of filesToCheck) {
      const content = readFileSync(file, "utf8");
      // Rust 单测模块 #[cfg(test)] 以下不限制，生产代码与 shell 脚本全文严格扫描
      const prodPart = file.endsWith(".rs") ? content.split("#[cfg(test)]")[0]! : content;
      const lines = prodPart.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i]!.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
        if (quotedVendorRe.test(trimmed)) {
          hits.push(`${file}:${i + 1}: ${trimmed}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("wsl-provision-guest.sh --phase root（幂等系统初始化）", () => {
  it("非 root 身份运行 --phase root 时拒绝执行", () => {
    const res = runGuest(["--phase", "root"], { FUSA_EFFECTIVE_UID: "1000" });
    expect(res.status).not.toBe(0);
  });

  it("写入隔离 /etc/wsl.conf、创建无免密 sudo 的普通用户 fusa、安装缺失 apt 包并按条件配置 AppArmor（重跑幂等）", () => {
    const root = makeTempDir("fusa-wsl-root-");
    const fakeBin = join(root, "bin");
    const etcDir = join(root, "etc");
    const wslConf = join(etcDir, "wsl.conf");
    const sudoersFile = join(etcDir, "sudoers");
    const sudoersDir = join(etcDir, "sudoers.d");
    const apparmorDir = join(etcDir, "apparmor.d");
    const securityFs = join(root, "sys-apparmor");
    const userHome = join(root, "home", "fusa");
    const opsLog = join(root, "ops.log");
    const stateUserCreated = join(root, "user-created");
    const statePkgsInstalled = join(root, "pkgs-installed");

    mkdirSync(sudoersDir, { recursive: true });
    mkdirSync(apparmorDir, { recursive: true });
    mkdirSync(securityFs, { recursive: true });
    writeFileSync(sudoersFile, "root ALL=(ALL:ALL) ALL\n");
    // 预置一个残留的免密 sudoers 文件，验证 root 阶段会主动清除它
    writeFileSync(join(sudoersDir, "fusa"), "fusa ALL=(ALL) NOPASSWD:ALL\n");

    writeExecutable(
      join(fakeBin, "id"),
      `#!/usr/bin/env bash
if [ "\${1:-}" = "-u" ] && [ "\${2:-}" = "fusa" ]; then
  [ -f "${stateUserCreated}" ] && { echo 1000; exit 0; }
  exit 1
fi
exec /usr/bin/id "$@"
`,
    );

    writeExecutable(
      join(fakeBin, "useradd"),
      `#!/usr/bin/env bash
echo "useradd $*" >> "${opsLog}"
mkdir -p "${userHome}"
touch "${stateUserCreated}"
`,
    );

    writeExecutable(
      join(fakeBin, "chown"),
      `#!/usr/bin/env bash
echo "chown $*" >> "${opsLog}"
`,
    );

    writeExecutable(
      join(fakeBin, "gpasswd"),
      `#!/usr/bin/env bash
exit 0
`,
    );

    writeExecutable(
      join(fakeBin, "dpkg"),
      `#!/usr/bin/env bash
if [ -f "${statePkgsInstalled}" ]; then exit 0; fi
exit 1
`,
    );

    writeExecutable(
      join(fakeBin, "apt-get"),
      `#!/usr/bin/env bash
echo "apt-get $*" >> "${opsLog}"
if [ "\${1:-}" = "install" ]; then touch "${statePkgsInstalled}"; fi
`,
    );

    writeExecutable(
      join(fakeBin, "apparmor_parser"),
      `#!/usr/bin/env bash
echo "apparmor_parser $*" >> "${opsLog}"
`,
    );

    const env = {
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FUSA_EFFECTIVE_UID: "0",
      FUSA_WSL_USER: "fusa",
      FUSA_WSL_HOME: userHome,
      FUSA_WSL_CONF_PATH: wslConf,
      FUSA_SUDOERS_FILE: sudoersFile,
      FUSA_SUDOERS_DIR: sudoersDir,
      FUSA_APPARMOR_DIR: apparmorDir,
      FUSA_APPARMOR_SECURITYFS: securityFs,
    };

    const first = runGuest(["--phase", "root"], env);
    expect(first.status, first.stderr).toBe(0);

    expect(readFileSync(wslConf, "utf8")).toBe(
      ["[interop]", "enabled=false", "appendWindowsPath=false", "", "[automount]", "enabled=false", "", "[user]", "default=fusa", ""].join(
        "\n",
      ),
    );
    expect(existsSync(join(sudoersDir, "fusa"))).toBe(false);
    expect(readFileSync(join(apparmorDir, "bwrap"), "utf8")).toContain("profile bwrap /usr/bin/bwrap flags=(unconfined)");

    const firstLog = readFileSync(opsLog, "utf8");
    expect(firstLog).toContain("useradd -m -s /bin/bash fusa");
    expect(firstLog).toContain("apt-get install");
    expect(firstLog).toContain("bubblewrap");
    expect(firstLog).toContain("socat");
    expect(firstLog).toContain(`apparmor_parser -r ${join(apparmorDir, "bwrap")}`);

    // 第二次重跑验证完全幂等：不再调 useradd、apt-get，AppArmor profile 未变也不重跑
    writeFileSync(opsLog, "");
    const second = runGuest(["--phase", "root"], env);
    expect(second.status, second.stderr).toBe(0);
    const secondLog = readFileSync(opsLog, "utf8");
    expect(secondLog).not.toContain("useradd");
    expect(secondLog).not.toContain("apt-get");

    // 若 /etc/sudoers 主文件被人为写入 fusa NOPASSWD，root 阶段必须报错阻断
    writeFileSync(sudoersFile, "root ALL=(ALL:ALL) ALL\nfusa ALL=(ALL) NOPASSWD: ALL\n");
    const badSudo = runGuest(["--phase", "root"], env);
    expect(badSudo.status).not.toBe(0);
  });
});

describe.skipIf(process.platform === "win32")("wsl-provision-guest.sh --phase user（Node 24 SHA256 校验、pnpm 与目录幂等）", () => {
  it("拒绝以 root 运行，校验官方 SHA256（篡改即拒），安装 Node 与锁定版 pnpm，且重跑幂等跳过", () => {
    const root = makeTempDir("fusa-wsl-user-");
    const home = join(root, "home", "fusa");
    const distDir = join(root, "dist");
    const npmLog = join(root, "npm.log");
    mkdirSync(home, { recursive: true });
    mkdirSync(distDir, { recursive: true });

    const rootAttempt = runGuest(["--phase", "user"], { FUSA_EFFECTIVE_UID: "0", FUSA_WSL_HOME: home });
    expect(rootAttempt.status).not.toBe(0);

    const nodeVersion = "24.22.2";
    const { sha256 } = createFakeNodeTarXz(distDir, nodeVersion, npmLog);
    const pnpmTgz = join(distDir, "pnpm-10.34.5.tgz");
    writeFileSync(pnpmTgz, "fake-pnpm-tarball");
    const pnpmSha = createHash("sha256").update(readFileSync(pnpmTgz)).digest("hex");
    const baseEnv = {
      FUSA_EFFECTIVE_UID: "1000",
      FUSA_WSL_USER: "fusa",
      FUSA_WSL_HOME: home,
      FUSA_NODE_VERSION: nodeVersion,
      FUSA_NODE_DIST_BASE_URL: `file://${distDir}`,
      FUSA_NODE_ARCH_OVERRIDE: "x86_64",
      FUSA_PNPM_VERSION: "10.34.5",
      FUSA_PNPM_REGISTRY_BASE_URL: `file://${distDir}`,
      FUSA_PNPM_SHA256: pnpmSha,
    };

    // 1) SHA256 不匹配时必须拒绝安装且不留残余目录
    const badSha = runGuest(["--phase", "user"], {
      ...baseEnv,
      FUSA_NODE_SHA256: "0".repeat(64),
    });
    expect(badSha.status).not.toBe(0);
    expect(existsSync(join(home, ".local", "share", "fusa", "node", "bin", "node"))).toBe(false);

    // 1b) pnpm 官方包 SHA256 不匹配时拒绝安装（npm 根本不会被调用），也不留下 pnpm
    const badPnpm = runGuest(["--phase", "user"], {
      ...baseEnv,
      FUSA_NODE_SHA256: sha256,
      FUSA_PNPM_SHA256: "f".repeat(64),
    });
    expect(badPnpm.status).not.toBe(0);
    expect(badPnpm.stderr).toContain("SHA256 校验失败");
    expect(existsSync(join(home, ".local", "share", "fusa", "pnpm", "bin", "pnpm"))).toBe(false);
    expect(existsSync(npmLog) ? readFileSync(npmLog, "utf8") : "").toBe("");

    // 2) SHA256 匹配时正常解压安装 Node 与 pnpm@10.34.5，并建好目录结构
    const okRun = runGuest(["--phase", "user"], {
      ...baseEnv,
      FUSA_NODE_SHA256: sha256,
    });
    expect(okRun.status, okRun.stderr).toBe(0);
    expect(existsSync(join(home, "projects"))).toBe(true);
    expect(existsSync(join(home, ".local", "share", "fusa", "releases"))).toBe(true);
    expect(execFileSync(join(home, ".local", "share", "fusa", "node", "bin", "node"), ["-v"], { encoding: "utf8" }).trim()).toBe(
      `v${nodeVersion}`,
    );
    expect(execFileSync(join(home, ".local", "bin", "pnpm"), ["-v"], { encoding: "utf8" }).trim()).toBe("10.34.5");
    expect(readFileSync(npmLog, "utf8")).toContain("pnpm-10.34.5.tgz");

    // 3) 再次运行应完全跳过下载与 npm install（即使把 dist 源删掉也能幂等通过！）
    rmSync(distDir, { recursive: true, force: true });
    writeFileSync(npmLog, "");
    const secondRun = runGuest(["--phase", "user"], {
      ...baseEnv,
      FUSA_NODE_SHA256: sha256,
    });
    expect(secondRun.status, secondRun.stderr).toBe(0);
    expect(readFileSync(npmLog, "utf8")).toBe("");
  });
});

describe.skipIf(process.platform === "win32")("wsl-provision-guest.sh --self-test（隔离与沙箱门禁 JSON 错误码）", () => {
  function makeSelfTestFixture() {
    const root = makeTempDir("fusa-self-test-");
    const home = join(root, "home", "fusa");
    const binDir = join(root, "bin");
    const binfmtDir = join(root, "binfmt_misc");
    const mountinfoPath = join(root, "mountinfo");
    const bwrapBin = join(binDir, "bwrap");
    const sudoBin = join(binDir, "sudo");
    const winCmdBin = join(binDir, "fake-win-cmd.exe");

    mkdirSync(home, { recursive: true });
    mkdirSync(binfmtDir, { recursive: true });
    writeFileSync(
      mountinfoPath,
      "28 1 8:16 / / rw,relatime - ext4 /dev/sdb rw,discard,errors=remount-ro,data=ordered\n",
    );
    writeFakeBwrap(bwrapBin, "enforcing");
    // 默认 sudo -n true 返回失败（无免密 sudo）
    writeExecutable(sudoBin, "#!/usr/bin/env bash\nexit 1\n");
    // 默认无法启动 Windows 进程
    writeExecutable(winCmdBin, "#!/usr/bin/env bash\nexit 127\n");

    const env: Record<string, string> = {
      PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      FUSA_EFFECTIVE_UID: "1000",
      FUSA_WSL_USER: "fusa",
      FUSA_WSL_HOME: home,
      FUSA_BINFMT_DIR: binfmtDir,
      FUSA_MOUNTINFO_PATH: mountinfoPath,
      FUSA_BWRAP_BIN: bwrapBin,
      FUSA_SUDO_BIN: sudoBin,
      FUSA_SELF_TEST_WIN_CMD: winCmdBin,
    };

    return { root, home, binDir, binfmtDir, mountinfoPath, bwrapBin, sudoBin, winCmdBin, env };
  }

  it("隔离全部达标（含 WSLInterop 文件为 disabled）时返回退出码 0 与 ok=true JSON", () => {
    const fx = makeSelfTestFixture();
    writeFileSync(join(fx.binfmtDir, "WSLInterop"), "disabled\ninterpreter /init\n");

    const res = runGuest(["--self-test"], fx.env);
    expect(res.status, res.stderr).toBe(0);
    const report = JSON.parse(res.stdout) as {
      ok: boolean;
      worker_sandbox_ready: boolean;
      error_code: string | null;
      failures: unknown[];
    };
    expect(report).toMatchObject({
      ok: true,
      worker_sandbox_ready: true,
      error_code: null,
      failures: [],
    });
  });

  it("WSLInterop 或 WSLInterop-late 处于 enabled 时返回 interop_binfmt_enabled", () => {
    const fx = makeSelfTestFixture();
    writeFileSync(join(fx.binfmtDir, "WSLInterop-late"), "enabled\ninterpreter /init\n");

    const res = runGuest(["--self-test"], fx.env);
    expect(res.status).toBe(1);
    const report = JSON.parse(res.stdout) as { ok: boolean; worker_sandbox_ready: boolean; error_code: string };
    expect(report.ok).toBe(false);
    expect(report.worker_sandbox_ready).toBe(false);
    expect(report.error_code).toBe("interop_binfmt_enabled");
  });

  it("可启动 Windows 侧进程或残留存活 WSL_INTEROP socket 时返回 interop_process_launchable", () => {
    const fx = makeSelfTestFixture();
    writeExecutable(fx.winCmdBin, "#!/usr/bin/env bash\nexit 0\n");

    const res = runGuest(["--self-test"], fx.env);
    expect(res.status).toBe(1);
    const report = JSON.parse(res.stdout) as { ok: boolean; error_code: string };
    expect(report.ok).toBe(false);
    expect(report.error_code).toBe("interop_process_launchable");
  });

  it("PATH 混入 /mnt/c 时返回 windows_path_leaked", () => {
    const fx = makeSelfTestFixture();
    const res = runGuest(["--self-test"], {
      ...fx.env,
      PATH: `${fx.env.PATH}:/mnt/c/Windows/System32`,
    });
    expect(res.status).toBe(1);
    const report = JSON.parse(res.stdout) as { ok: boolean; error_code: string };
    expect(report.ok).toBe(false);
    expect(report.error_code).toBe("windows_path_leaked");
  });

  it("mountinfo 存在 drvfs 自动挂载时返回 windows_drvfs_mounted", () => {
    const fx = makeSelfTestFixture();
    writeFileSync(
      fx.mountinfoPath,
      "36 28 0:31 / /mnt/c rw,noatime - 9p drvfs rw,dirsync,aname=drvfs;path=C:\\;uid=1000;gid=1000\n",
    );
    const res = runGuest(["--self-test"], fx.env);
    expect(res.status).toBe(1);
    const report = JSON.parse(res.stdout) as { ok: boolean; error_code: string };
    expect(report.ok).toBe(false);
    expect(report.error_code).toBe("windows_drvfs_mounted");
  });

  it("普通用户具备免密 sudo 时返回 sudo_nopasswd_enabled", () => {
    const fx = makeSelfTestFixture();
    writeExecutable(fx.sudoBin, "#!/usr/bin/env bash\nexit 0\n");

    const res = runGuest(["--self-test"], fx.env);
    expect(res.status).toBe(1);
    const report = JSON.parse(res.stdout) as { ok: boolean; error_code: string };
    expect(report.ok).toBe(false);
    expect(report.error_code).toBe("sudo_nopasswd_enabled");
  });

  it("bwrap 无法启动时返回 bwrap_unavailable，绝不降级", () => {
    const fx = makeSelfTestFixture();
    writeFakeBwrap(fx.bwrapBin, "broken");

    const res = runGuest(["--self-test"], fx.env);
    expect(res.status).toBe(1);
    const report = JSON.parse(res.stdout) as { ok: boolean; worker_sandbox_ready: boolean; error_code: string };
    expect(report.ok).toBe(false);
    expect(report.worker_sandbox_ready).toBe(false);
    expect(report.error_code).toBe("bwrap_unavailable");
  });

  it("bwrap 未能拒写 ~/.agent-hub/state 时返回 bwrap_write_guard_failed", () => {
    const fx = makeSelfTestFixture();
    writeFakeBwrap(fx.bwrapBin, "leaky");

    const res = runGuest(["--self-test"], fx.env);
    expect(res.status).toBe(1);
    const report = JSON.parse(res.stdout) as { ok: boolean; worker_sandbox_ready: boolean; error_code: string };
    expect(report.ok).toBe(false);
    expect(report.worker_sandbox_ready).toBe(false);
    expect(report.error_code).toBe("bwrap_write_guard_failed");
  });
});

describe.skipIf(process.platform === "win32")("wsl-provision-guest.sh --vendors-json（复用注册表动态输出厂商引导元数据）", () => {
  it("动态读取 scripts/print-vendors.ts 并准确反映当前用户下各厂商 CLI 安装状态", () => {
    const root = makeTempDir("fusa-vendors-");
    const home = join(root, "home", "fusa");
    const localBin = join(home, ".local", "bin");
    const sysBin = join(root, "sys-bin");
    const hostNodeBinDir = join(root, "host-node-bin");
    mkdirSync(localBin, { recursive: true });
    mkdirSync(hostNodeBinDir, { recursive: true });
    populateIsolatedSysBin(sysBin, ["env", "bash", "dirname", "id"]);

    // 动态取注册表第一家厂商创建受控假 CLI，不在测试或脚本中硬编码具体厂商名
    const firstVendor = VENDOR_LIST[0]!;
    const fakeCliPath = join(localBin, firstVendor.cli.command);
    writeExecutable(fakeCliPath, "#!/usr/bin/env bash\necho 1.0.0\n");

    // 在宿主 node 同目录下放置第二家厂商的假 CLI，验证受控 PATH 与宿主机全局安装的 CLI 完全绝缘
    const hostNodeBin = join(hostNodeBinDir, "node");
    writeExecutable(hostNodeBin, `#!/usr/bin/env bash\nexec "${process.execPath}" "$@"\n`);
    const secondVendor = VENDOR_LIST[1]!;
    writeExecutable(join(hostNodeBinDir, secondVendor.cli.command), "#!/usr/bin/env bash\necho 9.9.9\n");

    const res = runGuest(["--vendors-json", "--app-dir", REPO_ROOT], {
      PATH: `${localBin}:${sysBin}`,
      HOME: home,
      FUSA_WSL_HOME: home,
      FUSA_NODE_BIN_OVERRIDE: hostNodeBin,
    });
    expect(res.status, res.stderr).toBe(0);

    const entries = JSON.parse(res.stdout) as Array<{
      id: string;
      command: string;
      install_command: string;
      login_command: string;
      installed: boolean;
      binary_path: string | null;
    }>;

    expect(entries.map((e) => e.id)).toEqual(VENDOR_LIST.map((v) => v.id));
    for (let i = 0; i < VENDOR_LIST.length; i++) {
      const spec = VENDOR_LIST[i]!;
      const paths = VENDOR_PATHS[spec.id];
      const got = entries[i]!;
      expect(got.command).toBe(spec.cli.command);
      expect(got.install_command).toBe(paths.installCommand ?? "");
      expect(got.login_command).toBe(paths.headlessLoginCommand ?? spec.cli.loginCommand);
      if (i === 0) {
        expect(got.installed).toBe(true);
        expect(got.binary_path).toBe(fakeCliPath);
      } else {
        expect(got.installed).toBe(false);
        expect(got.binary_path).toBeNull();
      }
    }
  });
});

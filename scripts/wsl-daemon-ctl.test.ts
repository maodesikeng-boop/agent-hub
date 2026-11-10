import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(THIS_DIR, "..");
const CTL_SCRIPT = join(THIS_DIR, "wsl-daemon-ctl.sh");

const tempDirs: string[] = [];
const spawnedChildren: ChildProcess[] = [];
const activeServers: Server[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000, stepMs = 40): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!(await predicate())) {
    throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
  }
}

afterEach(async () => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.pid && isPidAlive(child.pid)) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  for (const srv of activeServers.splice(0)) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCtl(args: string[], extraEnv: Record<string, string> = {}, input?: Buffer) {
  return spawnSync("bash", [CTL_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME ?? tmpdir(),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      ...extraEnv,
    },
    input,
  });
}

function runCtlAsync(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [CTL_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME ?? tmpdir(),
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => outChunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      });
    });
  });
}

describe("scripts/wsl-daemon-ctl.sh 受控起停与探活契约", () => {
  it("probe 探活：正常返回 200 JSON、拦截 307 重定向绝不自动跟随、不可达返回 000", async () => {
    let followedRedirect = false;
    let mode: "ok" | "redirect" = "ok";

    const server = createServer((req, res) => {
      if (req.url === "/evil-target") {
        followedRedirect = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ product: "fusa", protocolVersion: 1, instanceId: "spoofed" }));
        return;
      }
      if (mode === "redirect") {
        res.writeHead(307, { location: "/evil-target" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "unauthenticated", product: "fusa", protocolVersion: 1, instanceId: "inst-01" }));
    });
    activeServers.push(server);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;

    const okRes = await runCtlAsync(["probe", "--port", String(port), "--status-path", "/api/auth/status", "--timeout-ms", "500"]);
    expect(okRes.status).toBe(0);
    expect(okRes.stdout).toContain('"product":"fusa"');
    expect(okRes.stdout).toContain("__FUSA_HTTP_STATUS__:200");

    mode = "redirect";
    const redirRes = await runCtlAsync(["probe", "--port", String(port), "--status-path", "/api/auth/status", "--timeout-ms", "500"]);
    expect(redirRes.stdout).toContain("__FUSA_HTTP_STATUS__:307");
    expect(followedRedirect).toBe(false);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    activeServers.pop();

    const closedRes = await runCtlAsync(["probe", "--port", String(port), "--timeout-ms", "300"]);
    expect(closedRes.stdout).toContain("__FUSA_HTTP_STATUS__:000");
  });

  it("run + status + signal TERM：慢优雅关闭完成落盘清理并移除租约文件", async () => {
    const work = makeTempDir("fusa-ctl-grace-");
    const hubHome = join(work, "hub-home");
    const appDir = join(work, "app");
    const readyFile = join(work, "ready.txt");
    const markerFile = join(work, "graceful.txt");
    mkdirSync(appDir, { recursive: true });

    const entryFile = join(appDir, "entry.mjs");
    writeFileSync(
      entryFile,
      `
import { writeFileSync } from "node:fs";
setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  setTimeout(() => {
    writeFileSync(${JSON.stringify(markerFile)}, "graceful-done:" + process.pid);
    process.exit(0);
  }, 300);
});
writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));
`,
      "utf8",
    );

    const child = spawn(
      "bash",
      [
        CTL_SCRIPT,
        "run",
        "--run-id",
        "graceful-run-1",
        "--app-dir",
        appDir,
        "--port",
        "4317",
        "--home",
        hubHome,
        "--node",
        process.execPath,
        "--entry",
        "entry.mjs",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FUSA_WSL_HOME: work },
      },
    );
    spawnedChildren.push(child);

    let daemonPid = 0;
    await waitUntil(() => {
      if (!existsSync(readyFile)) return false;
      const st = runCtl(["status", "--run-id", "graceful-run-1", "--home", hubHome], { FUSA_WSL_HOME: work });
      if (st.status !== 0) return false;
      const parsed = JSON.parse(st.stdout.toString("utf8").trim()) as {
        found: boolean;
        leader_alive: boolean;
        pid: number | null;
      };
      if (parsed.found && parsed.leader_alive && parsed.pid) {
        daemonPid = parsed.pid;
        return true;
      }
      return false;
    });

    const termRes = runCtl(["signal", "--run-id", "graceful-run-1", "--signal", "TERM", "--home", hubHome], {
      FUSA_WSL_HOME: work,
    });
    expect(termRes.status).toBe(0);
    expect(JSON.parse(termRes.stdout.toString("utf8").trim()).signaled).toBe(true);

    await waitUntil(() => !isPidAlive(daemonPid), 5_000);
    expect(existsSync(markerFile)).toBe(true);
    expect(readFileSync(markerFile, "utf8")).toBe(`graceful-done:${daemonPid}`);

    const afterStatus = JSON.parse(
      runCtl(["status", "--run-id", "graceful-run-1", "--home", hubHome], { FUSA_WSL_HOME: work }).stdout
        .toString("utf8")
        .trim(),
    );
    expect(afterStatus.leader_alive).toBe(false);
    expect(afterStatus.group_alive).toBe(false);
  });

  it("signal KILL 仅清理本次自有进程组及子孙进程，绝不误杀外部无关 node 进程，且防 PID 复用误杀", async () => {
    const work = makeTempDir("fusa-ctl-kill-");
    const hubHome = join(work, "hub-home");
    const appDir = join(work, "app");
    const childPidFile = join(work, "grandchild.pid");
    mkdirSync(appDir, { recursive: true });

    // 启动一个完全无关的外部 node 进程，验证任何信号路径都绝不会波及它
    const externalNode = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    spawnedChildren.push(externalNode);
    const externalPid = externalNode.pid!;
    expect(isPidAlive(externalPid)).toBe(true);

    // 启动一个故意忽略 SIGTERM 且派生子进程的受控后台
    writeFileSync(
      join(appDir, "hung.mjs"),
      `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
const sub = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(childPidFile)}, String(sub.pid));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const hung = spawn(
      "bash",
      [
        CTL_SCRIPT,
        "run",
        "--run-id",
        "hung-run-2",
        "--app-dir",
        appDir,
        "--port",
        "4318",
        "--home",
        hubHome,
        "--node",
        process.execPath,
        "--entry",
        "hung.mjs",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FUSA_WSL_HOME: work },
      },
    );
    spawnedChildren.push(hung);

    await waitUntil(() => existsSync(childPidFile));
    const subPid = Number(readFileSync(childPidFile, "utf8").trim());
    expect(subPid).toBeGreaterThan(0);

    const stBefore = JSON.parse(
      runCtl(["status", "--run-id", "hung-run-2", "--home", hubHome], { FUSA_WSL_HOME: work }).stdout
        .toString("utf8")
        .trim(),
    ) as { pid: number; pgid: number; leader_alive: boolean };
    expect(stBefore.leader_alive).toBe(true);
    expect(stBefore.pgid).toBe(stBefore.pid);

    // 超时兜底发 KILL：必须同时清理主进程与同进程组子进程，而外部 node 进程毫发无损
    const killRes = runCtl(["signal", "--run-id", "hung-run-2", "--signal", "KILL", "--home", hubHome], {
      FUSA_WSL_HOME: work,
    });
    expect(killRes.status).toBe(0);

    await waitUntil(() => !isPidAlive(stBefore.pid) && !isPidAlive(subPid), 5_000);
    expect(isPidAlive(externalPid)).toBe(true);

    // 伪造 PID 复用场景：租约里的 pid/pgid 均指向存活的 externalPid，但 startTime 不匹配 -> 严禁发 TERM 或 KILL！
    mkdirSync(join(hubHome, "run"), { recursive: true });
    writeFileSync(
      join(hubHome, "run", "wsl-owned-reused-pid.json"),
      JSON.stringify({
        runId: "reused-pid",
        pid: externalPid,
        pgid: externalPid,
        startTime: "MISMATCHED_START_TIME_99999",
        port: 4317,
      }),
      "utf8",
    );
    const reuseTerm = JSON.parse(
      runCtl(["signal", "--run-id", "reused-pid", "--signal", "TERM", "--home", hubHome], {
        FUSA_WSL_HOME: work,
      }).stdout
        .toString("utf8")
        .trim(),
    );
    expect(reuseTerm.signaled).toBe(false);
    expect(isPidAlive(externalPid)).toBe(true);

    const reuseKill = JSON.parse(
      runCtl(["signal", "--run-id", "reused-pid", "--signal", "KILL", "--home", hubHome], {
        FUSA_WSL_HOME: work,
      }).stdout
        .toString("utf8")
        .trim(),
    );
    expect(reuseKill.signaled).toBe(false);
    expect(isPidAlive(externalPid)).toBe(true);
  });

  it("Linux /proc 精确元数据解析：comm 含空格括号、僵尸进程过滤、UID 隔离与 starttime 防复用", () => {
    const work = makeTempDir("fusa-ctl-procfs-");
    const fakeProc = join(work, "proc");
    const hubHome = join(work, "hub-home");
    mkdirSync(join(fakeProc, "self"), { recursive: true });
    mkdirSync(join(hubHome, "run"), { recursive: true });

    // /proc/<pid>/stat 格式：pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice num_threads itrealvalue starttime ...
    // after ") " 的第 1 列是 state，第 3 列是 pgrp，第 20 列是 starttime
    const makeStatLine = (pid: number, comm: string, state: string, pgid: number, startTicks: number) => {
      const fieldsAfterComm = [
        state, // 1: state (col 3)
        "1",   // 2: ppid (col 4)
        String(pgid), // 3: pgrp (col 5)
        String(pgid), // 4: session (col 6)
        "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", // 5..15: tty_nr..cstime (cols 7..17, 11 fields)
        "20", "0", "1", "0", // 16..19: priority, nice, num_threads, itrealvalue (cols 18..21)
        String(startTicks), // 20: starttime (overall column 22)
        "100000", "500",
      ];
      return `${pid} (${comm}) ${fieldsAfterComm.join(" ")}\n`;
    };
    writeFileSync(join(fakeProc, "self", "stat"), makeStatLine(100, "bash", "R", 100, 10), "utf8");

    // 进程 4200：comm 中包含空格和右括号，状态 S，pgid=4200，starttime=88000，uid=1000
    mkdirSync(join(fakeProc, "4200"), { recursive: true });
    writeFileSync(join(fakeProc, "4200", "stat"), makeStatLine(4200, "node (fusa main)", "S", 4200, 88000), "utf8");
    writeFileSync(join(fakeProc, "4200", "status"), "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n", "utf8");

    writeFileSync(
      join(hubHome, "run", "wsl-owned-proc-ok.json"),
      JSON.stringify({ runId: "proc-ok", pid: 4200, pgid: 4200, startTime: "88000", port: 4317 }),
      "utf8",
    );

    const okSt = JSON.parse(
      runCtl(["status", "--run-id", "proc-ok", "--home", hubHome], {
        FUSA_PROC_ROOT: fakeProc,
        FUSA_EFFECTIVE_UID: "1000",
      }).stdout
        .toString("utf8")
        .trim(),
    );
    expect(okSt).toEqual({ found: true, leader_alive: true, group_alive: true, pid: 4200, pgid: 4200 });

    // 变为僵尸进程 Z 后不再算存活
    writeFileSync(join(fakeProc, "4200", "stat"), makeStatLine(4200, "node (fusa main)", "Z", 4200, 88000), "utf8");
    const zombieSt = JSON.parse(
      runCtl(["status", "--run-id", "proc-ok", "--home", hubHome], {
        FUSA_PROC_ROOT: fakeProc,
        FUSA_EFFECTIVE_UID: "1000",
      }).stdout
        .toString("utf8")
        .trim(),
    );
    expect(zombieSt.leader_alive).toBe(false);
    expect(zombieSt.group_alive).toBe(false);
  });

  it("deploy-release：从 stdin 解压发布包并原子更新 current 软链接（支持幂等复用）", () => {
    const work = makeTempDir("fusa-ctl-deploy-");
    const srcPkg = join(work, "pkg-src");
    const releasesDir = join(work, "releases");
    mkdirSync(join(srcPkg, "src", "daemon"), { recursive: true });
    mkdirSync(join(srcPkg, "migrations"), { recursive: true });
    writeFileSync(join(srcPkg, "src", "daemon", "main.ts"), "// daemon entry\n", "utf8");
    writeFileSync(join(srcPkg, "migrations", "0001_init.sql"), "CREATE TABLE init_guard (id INTEGER PRIMARY KEY);\n", "utf8");

    const tarPath = join(work, "bundle.tar.gz");
    execFileSync("tar", ["-czf", tarPath, "-C", srcPkg, "."]);
    const tarBytes = readFileSync(tarPath);

    const first = runCtl(
      ["deploy-release", "--version", "0.1.0", "--releases-dir", releasesDir, "--skip-install"],
      { FUSA_WSL_HOME: work },
      tarBytes,
    );
    expect(first.status).toBe(0);
    const firstJson = JSON.parse(first.stdout.toString("utf8").trim());
    expect(firstJson.deployed).toBe(true);
    expect(firstJson.reused).toBe(false);
    expect(existsSync(join(releasesDir, "current", "src", "daemon", "main.ts"))).toBe(true);
    expect(existsSync(join(releasesDir, "current", "migrations", "0001_init.sql"))).toBe(true);

    // 同一版本再次调用直接幂等复用，无需再次读 stdin
    const second = runCtl(["deploy-release", "--version", "0.1.0", "--releases-dir", releasesDir, "--skip-install"], {
      FUSA_WSL_HOME: work,
    });
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout.toString("utf8").trim()).reused).toBe(true);

    // 拒绝含路径穿越的版本号
    const traversal = runCtl(["deploy-release", "--version", "../evil", "--releases-dir", releasesDir, "--skip-install"], {
      FUSA_WSL_HOME: work,
    });
    expect(traversal.status).not.toBe(0);
  });

  it("deploy-release：缺少非空 migrations 目录时失败报错且不更新 current 软链接", () => {
    const work = makeTempDir("fusa-ctl-deploy-missing-migrations-");
    const releasesDir = join(work, "releases");

    // 1) 全新部署缺少 migrations：失败且不创建 current 软链接
    const noMigrationsPkg = join(work, "pkg-no-migrations");
    mkdirSync(join(noMigrationsPkg, "src", "daemon"), { recursive: true });
    writeFileSync(join(noMigrationsPkg, "src", "daemon", "main.ts"), "// daemon entry\n", "utf8");
    const noMigrationsTar = join(work, "no-migrations.tar.gz");
    execFileSync("tar", ["-czf", noMigrationsTar, "-C", noMigrationsPkg, "."]);

    const freshFail = runCtl(
      ["deploy-release", "--version", "0.1.0", "--releases-dir", releasesDir, "--skip-install"],
      { FUSA_WSL_HOME: work },
      readFileSync(noMigrationsTar),
    );
    expect(freshFail.status).not.toBe(0);
    expect(freshFail.stderr.toString("utf8")).toContain("migrations");
    expect(existsSync(join(releasesDir, "0.1.0"))).toBe(false);
    expect(existsSync(join(releasesDir, "current"))).toBe(false);

    // 2) 先部署合法 0.1.0，再传入缺少或空 migrations 的 0.2.0：必须报错且 current 保持指向 0.1.0
    const validPkg = join(work, "pkg-valid");
    mkdirSync(join(validPkg, "src", "daemon"), { recursive: true });
    mkdirSync(join(validPkg, "migrations"), { recursive: true });
    writeFileSync(join(validPkg, "src", "daemon", "main.ts"), "// v0.1.0\n", "utf8");
    writeFileSync(join(validPkg, "migrations", "0001_init.sql"), "SELECT 1;\n", "utf8");
    const validTar = join(work, "valid.tar.gz");
    execFileSync("tar", ["-czf", validTar, "-C", validPkg, "."]);

    const okDeploy = runCtl(
      ["deploy-release", "--version", "0.1.0", "--releases-dir", releasesDir, "--skip-install"],
      { FUSA_WSL_HOME: work },
      readFileSync(validTar),
    );
    expect(okDeploy.status).toBe(0);
    const v010Real = realpathSync(join(releasesDir, "0.1.0"));
    expect(realpathSync(join(releasesDir, "current"))).toBe(v010Real);

    const upgradeMissing = runCtl(
      ["deploy-release", "--version", "0.2.0", "--releases-dir", releasesDir, "--skip-install"],
      { FUSA_WSL_HOME: work },
      readFileSync(noMigrationsTar),
    );
    expect(upgradeMissing.status).not.toBe(0);
    expect(upgradeMissing.stderr.toString("utf8")).toContain("migrations");
    expect(existsSync(join(releasesDir, "0.2.0"))).toBe(false);
    expect(realpathSync(join(releasesDir, "current"))).toBe(v010Real);

    // 3) 空 migrations 目录同样拦截，且残缺版本目录不允许被幂等复用跳过校验
    const emptyMigrationsPkg = join(work, "pkg-empty-migrations");
    mkdirSync(join(emptyMigrationsPkg, "src", "daemon"), { recursive: true });
    mkdirSync(join(emptyMigrationsPkg, "migrations"), { recursive: true });
    writeFileSync(join(emptyMigrationsPkg, "src", "daemon", "main.ts"), "// v0.2.1\n", "utf8");
    const emptyMigrationsTar = join(work, "empty-migrations.tar.gz");
    execFileSync("tar", ["-czf", emptyMigrationsTar, "-C", emptyMigrationsPkg, "."]);

    const upgradeEmpty = runCtl(
      ["deploy-release", "--version", "0.2.1", "--releases-dir", releasesDir, "--skip-install"],
      { FUSA_WSL_HOME: work },
      readFileSync(emptyMigrationsTar),
    );
    expect(upgradeEmpty.status).not.toBe(0);
    expect(upgradeEmpty.stderr.toString("utf8")).toContain("migrations");
    expect(realpathSync(join(releasesDir, "current"))).toBe(v010Real);

    // 人工模拟一个缺 migrations 的残缺已存在目录 0.3.0，验证不会误触发 reused:true
    mkdirSync(join(releasesDir, "0.3.0", "src", "daemon"), { recursive: true });
    writeFileSync(join(releasesDir, "0.3.0", "src", "daemon", "main.ts"), "// incomplete\n", "utf8");
    const incompleteReuse = runCtl(
      ["deploy-release", "--version", "0.3.0", "--releases-dir", releasesDir, "--skip-install"],
      { FUSA_WSL_HOME: work },
      readFileSync(noMigrationsTar),
    );
    expect(incompleteReuse.status).not.toBe(0);
    expect(realpathSync(join(releasesDir, "current"))).toBe(v010Real);
  });
});

chmodSync(CTL_SCRIPT, 0o755);

// Linux 真机 bubblewrap (bwrap) 集成测试（docs/linux-sandbox-design.md 第 7 节）：
// 覆盖普通 Worker 写范围强制、只读 Worker 全盘只读与敏感文件/目录遮蔽、SIGINT 穿透内层 CLI 与退出码透传、
// 进程退出/强杀/cleanupStale 清空 PID namespace 与新进程组孤儿进程。
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { forceKill, isAlive, signalChild, signalTarget, termGroupAfterExit } from "./process.ts";
import { FAKE_CLAUDE, makeHarness, realSleep, type Harness } from "./test-helpers.ts";
import {
  osSandboxAvailable,
  scanSecretGlobs,
  wrapInOsSandbox,
  wrapInReadonlyOsSandbox,
} from "./write-scope.ts";

/** 在宿主机 /proc 下递归列出 rootPid 的所有后代真实 PID（含新进程组的子孙）。 */
function hostDescendantsOf(rootPid: number): number[] {
  const result: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    let raw = "";
    try {
      raw = readFileSync(`/proc/${cur}/task/${cur}/children`, "utf8").trim();
    } catch {
      continue;
    }
    if (raw === "") continue;
    for (const tok of raw.split(/\s+/)) {
      const pid = Number(tok);
      if (!Number.isInteger(pid) || pid <= 1 || seen.has(pid)) continue;
      seen.add(pid);
      result.push(pid);
      queue.push(pid);
    }
  }
  return result;
}

async function goneWithin(pid: number, ms = 3_000): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    if (!isAlive(pid)) return true;
    await realSleep(25);
  }
  return !isAlive(pid);
}

describe.runIf(process.platform === "linux" && osSandboxAvailable("linux"))("真 bwrap（Linux OS 沙箱集成测试）", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ah-bwrap-int-")));
  const leftovers: number[] = [];
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
    for (const pid of leftovers.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已退出
      }
    }
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("普通 Worker：worktree 与 /tmp 与 /dev/null 可写；state/ 四种写方式均被拒；/proc 隔离外部进程；/run/user/<uid> 为 0700 空 tmpfs；unshare -U 失败", () => {
    const dataDir = join(root, "home");
    const own = join(dataDir, "worktrees", "1", "2");
    const otherWt = join(dataDir, "worktrees", "1", "3");
    const stateDir = join(dataDir, "state");
    for (const d of [own, otherWt, stateDir]) mkdirSync(d, { recursive: true });
    symlinkSync(stateDir, join(own, "state-link"));

    const uid = process.getuid!();
    const hostPid = process.pid;
    const script = [
      // 1) 四种方式尝试写 state/：直接重定向、变量拼路径、node 脚本写、软链接绕过
      'echo x > "$D/state/direct" 2>/dev/null && echo DIRECT_WROTE',
      'S="$D/state"; touch "$S/via_var" 2>/dev/null && echo VAR_WROTE',
      `${JSON.stringify(process.execPath)} -e 'try { require("fs").writeFileSync(process.env.D + "/state/via_node", "x"); console.log("NODE_WROTE"); } catch {}'`,
      'touch "$O/state-link/via_symlink" 2>/dev/null && echo SYMLINK_WROTE',
      // 2) 数据目录根与别的 worktree 禁写
      'mkdir "$D/shots" 2>/dev/null && echo SHOTS_WROTE',
      'echo x > "$D/worktrees/1/3/t" 2>/dev/null && echo OTHER_WT_WROTE',
      // 3) 自己的 worktree、/tmp、/dev/null 可写
      'echo ok > "$O/a.txt" && mkdir -p "$O/sub" && echo ok > "$O/sub/b.txt" && echo ok > "$TMPDIR/tmp-ok" && echo ok > /dev/null',
      // 4) /proc 隔离：看不到宿主机测试进程，/proc 下数字目录极少
      `test ! -e /proc/${hostPid}/environ && echo PROC_ISOLATED`,
      // 5) /run/user/<uid> 是 0700 空 tmpfs
      `test -z "$(ls -A /run/user/${uid})" && test "$(stat -c %a /run/user/${uid})" = "700" && echo RUN_USER_ISOLATED`,
      // 6) --disable-userns：沙箱内不能再建 user namespace
      'if unshare -U true 2>/dev/null; then echo UNSHARE_OK; else echo UNSHARE_BLOCKED; fi',
    ].join("; ");

    const run = wrapInOsSandbox({ command: "/bin/sh", args: ["-c", script] }, { dataDir, writableDirs: [own] }, "linux");
    expect(run.osSandboxed).toBe(true);
    const out = execFileSync(run.command, run.args, {
      env: { ...process.env, D: dataDir, O: own, TMPDIR: root },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });

    expect(out.trim().split("\n")).toEqual(["PROC_ISOLATED", "RUN_USER_ISOLATED", "UNSHARE_BLOCKED"]);
    for (const f of ["direct", "via_var", "via_node", "via_symlink"]) {
      expect(existsSync(join(stateDir, f)), f).toBe(false);
    }
    expect(existsSync(join(dataDir, "shots"))).toBe(false);
    expect(existsSync(join(otherWt, "t"))).toBe(false);
    expect(existsSync(join(own, "a.txt"))).toBe(true);
    expect(existsSync(join(own, "sub", "b.txt"))).toBe(true);
    expect(existsSync(join(root, "tmp-ok"))).toBe(true);
  });

  it("只读 Worker：除 tmpDir、writableDirs、已存在匹配 writableFileGlobs 外全盘禁写；敏感目录与敏感文件（含 scanSecretGlobs 扫出的 .env）禁读", () => {
    const roRoot = join(root, "ro");
    const work = join(roRoot, "work");
    const tmp = join(roRoot, "tmp");
    const runtime = join(roRoot, "runtime");
    const binDir = join(roRoot, "bin");
    const secretDir = join(roRoot, ".ssh");
    for (const d of [work, tmp, runtime, binDir, secretDir]) mkdirSync(d, { recursive: true });

    const noteFile = join(work, "note.txt");
    const envFile = join(work, ".env");
    const envLocalFile = join(work, ".env.local");
    const sshKey = join(secretDir, "id_rsa");
    const tokenFile = join(roRoot, "ui-token");
    const agentapi = join(binDir, "agentapi-wrapper");
    const otherBin = join(binDir, "webm_encoder");
    writeFileSync(noteFile, "PUBLIC_NOTE");
    writeFileSync(envFile, "SECRET_ENV=1");
    writeFileSync(envLocalFile, "SECRET_LOCAL=2");
    writeFileSync(sshKey, "PRIVATE_KEY");
    writeFileSync(tokenFile, "UI_TOKEN");
    writeFileSync(agentapi, "old");
    writeFileSync(otherBin, "old");

    const scanned = scanSecretGlobs([work], ["**/.env", "**/.env.*"]);
    expect(scanned.sort()).toEqual([envFile, envLocalFile].sort());

    const script = [
      // 写工作目录与非白名单二进制均失败
      'echo x > "$W/w1.txt" 2>/dev/null; touch "$W/w2.txt" 2>/dev/null; mkdir "$W/sub" 2>/dev/null',
      'echo x > "$B/webm_encoder" 2>/dev/null && echo WEBM_WROTE',
      // 写 tmpDir、runtime、白名单可写文件成功
      'echo ok > "$TMPDIR/t.txt" && echo ok > "$R/r.txt" && echo updated > "$B/agentapi-wrapper"',
      // 敏感目录被 --tmpfs 遮空，敏感文件被 /dev/null 遮空（内容为空）
      'test ! -e "$S/id_rsa" && test -z "$(ls -A "$S")" && echo SSH_MASKED',
      'test -z "$(cat "$W/.env")" && test -z "$(cat "$W/.env.local")" && test -z "$(cat "$T")" && echo FILES_MASKED',
      'cat "$W/note.txt"',
    ].join("; ");

    const run = wrapInReadonlyOsSandbox(
      { command: "/bin/sh", args: ["-c", script] },
      {
        tmpDir: tmp,
        writableDirs: [runtime],
        writableFileGlobs: [join(binDir, "agentapi*")],
        writableFileRegexes: [],
        secretPaths: [secretDir, tokenFile, ...scanned],
        secretGlobs: ["**/.env", "**/.env.*"],
      },
      "linux",
    );
    expect(run.osSandboxed).toBe(true);
    const out = execFileSync(run.command, run.args, {
      env: { ...process.env, W: work, R: runtime, B: binDir, S: secretDir, T: tokenFile, TMPDIR: tmp },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });

    expect(out.trim().split("\n")).toEqual(["SSH_MASKED", "FILES_MASKED", "PUBLIC_NOTE"]);
    expect(existsSync(join(work, "w1.txt"))).toBe(false);
    expect(existsSync(join(work, "w2.txt"))).toBe(false);
    expect(existsSync(join(work, "sub"))).toBe(false);
    expect(readFileSync(otherBin, "utf8")).toBe("old");
    expect(readFileSync(agentapi, "utf8")).toBe("updated\n");
    expect(existsSync(join(tmp, "t.txt"))).toBe(true);
    expect(existsSync(join(runtime, "r.txt"))).toBe(true);
  });

  it("SIGINT 穿透 bwrap 送达内层 CLI 且退出码原样透传（不变成 143）", async () => {
    const dataDir = join(root, "sig-home");
    const own = join(dataDir, "wt");
    mkdirSync(own, { recursive: true });
    const readyFile = join(own, "ready");
    const cliScript = `
      const { writeFileSync } = require("node:fs");
      process.on("SIGINT", () => process.exit(7));
      writeFileSync(${JSON.stringify(readyFile)}, "1");
      setInterval(() => {}, 1000);
    `;
    const wrapped = wrapInOsSandbox({ command: process.execPath, args: ["-e", cliScript] }, { dataDir, writableDirs: [own] }, "linux");
    const child = spawn(wrapped.command, wrapped.args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    leftovers.push(child.pid!);

    while (!existsSync(readyFile)) await realSleep(20);
    const targetPid = signalTarget(child.pid!, "linux");
    expect(targetPid).not.toBeNull();
    expect(targetPid).not.toBe(child.pid);

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    signalChild(child, "SIGINT", "linux");
    const res = await exitPromise;
    expect(res).toEqual({ code: 7, signal: null });
  });

  it("进程清理：内层 CLI 起 detached 新进程组后台子进程，正常退出调 termGroupAfterExit 或强杀调 forceKill 后宿主机 0 残留", async () => {
    for (const mode of ["graceful", "forceKill"] as const) {
      const dataDir = join(root, `clean-${mode}`);
      const own = join(dataDir, "wt");
      mkdirSync(own, { recursive: true });
      const readyFile = join(own, "ready");
      const cliScript = `
        const { spawn } = require("node:child_process");
        const { writeFileSync } = require("node:fs");
        const bg = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
        bg.unref();
        writeFileSync(${JSON.stringify(readyFile)}, String(bg.pid));
        setInterval(() => {}, 1000);
      `;
      const wrapped = wrapInOsSandbox({ command: process.execPath, args: ["-e", cliScript] }, { dataDir, writableDirs: [own] }, "linux");
      const child = spawn(wrapped.command, wrapped.args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
      const bwrapPid = child.pid!;
      leftovers.push(bwrapPid);

      while (!existsSync(readyFile)) await realSleep(20);
      // 等宿主机 /proc 树里出现 [I, C, W] 三个后代进程
      let descendants: number[] = [];
      for (let i = 0; i < 50; i++) {
        descendants = hostDescendantsOf(bwrapPid);
        if (descendants.length >= 3) break;
        await realSleep(20);
      }
      expect(descendants.length).toBeGreaterThanOrEqual(3);
      for (const p of descendants) leftovers.push(p);

      if (mode === "graceful") {
        const exitPromise = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        signalChild(child, "SIGINT", "linux");
        await exitPromise;
        termGroupAfterExit(child);
      } else {
        await forceKill(child);
      }

      expect(await goneWithin(bwrapPid)).toBe(true);
      for (const p of descendants) {
        expect(await goneWithin(p), `mode=${mode} pid=${p}`).toBe(true);
      }
    }
  });

  it("驱动层集成（ClaudeDriver + 真 bwrap）：Worker 会话写范围受限、interrupt 与 cleanupStale 穿透 bwrap 并清空新进程组子进程", async () => {
    h = makeHarness({
      driver: { interruptGraceMs: 300 },
      script: {
        turns: [
          {
            steps: [{ spawnChild: { sleepSec: 30, detached: true } }, { text: "done" }],
          },
        ],
        defaultTurn: {
          steps: [{ spawnChild: { sleepSec: 30, detached: true } }, { text: "done" }],
        },
      },
    });
    const dataDir = join(realpathSync.native(h.dir), "home");
    const cwd = join(dataDir, "worktrees", "1", "2");
    mkdirSync(cwd, { recursive: true });
    const probe = join(dataDir, "probe.txt");
    h.launch.env = { FAKE_CLAUDE_PROBE: probe };
    h.launch.writeScope = { dataDir, writableDirs: [cwd] };

    const s = h.addSession({ role: "worker", cwd });
    await h.driver.send(s.id, { messageIds: [1], source: "user", text: "hi" });
    const ended = await h.waitFor("turn.ended");
    expect(ended.ok).toBe(true);
    // Linux bwrap 下数据目录只读挂载（EROFS），Worker 写不进 probe.txt
    expect(h.log().find((e) => e.kind === "probe")).toMatchObject({ ok: false });
    expect(existsSync(probe)).toBe(false);
    await h.driver.shutdown();

    // cleanupStale：模拟残留的 bwrap Worker 进程（含新进程组子进程），验证优雅 SIGINT + termGroupAfterExit 清理干净
    const straySessionId = "stray-linux-bwrap-session";
    const strayWrapped = wrapInOsSandbox(
      { command: FAKE_CLAUDE, args: ["-p", "--session-id", straySessionId] },
      { dataDir, writableDirs: [cwd] },
      "linux",
    );
    const stray: ChildProcess = spawn(strayWrapped.command, strayWrapped.args, {
      env: {
        ...process.env,
        FAKE_CLAUDE_LOG: join(h.dir, "fake-claude.log"),
        FAKE_CLAUDE_SCRIPT: join(h.dir, "script.json"),
        FAKE_CLAUDE_STATE: h.dir,
      },
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    });
    const strayPid = stray.pid!;
    leftovers.push(strayPid);
    stray.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }) + "\n");

    let strayDescendants: number[] = [];
    for (let i = 0; i < 100; i++) {
      strayDescendants = hostDescendantsOf(strayPid);
      if (strayDescendants.length >= 3) break;
      await realSleep(25);
    }
    expect(strayDescendants.length).toBeGreaterThanOrEqual(3);
    for (const p of strayDescendants) leftovers.push(p);

    const s2 = h.addSession({ role: "worker", cwd, vendorSessionId: straySessionId, status: "running", pid: strayPid });
    await h.driver.cleanupStale();
    expect(await goneWithin(strayPid)).toBe(true);
    for (const p of strayDescendants) {
      expect(await goneWithin(p)).toBe(true);
    }
    expect(h.store.get(s2.id)).toMatchObject({ pid: null, status: "idle" });
  });
});

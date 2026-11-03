// 强制结束杀到 claude 的所有后代（冒烟 S10c）：真 claude 的 Bash 工具把命令放进它自己的新进程组，
// 只按 claude 的进程组杀会把命令留成孤儿。这里先单测“给一张进程表，算出要杀什么”，再用假 claude 起一个
// 放在新进程组里的子进程，走一遍驱动层每条 SIGKILL 的路径。
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PS_TIMEOUT_MS } from "../../shared/index.ts";
import { forceKill, forceKillTree, killTargets, parsePs, type PsRow } from "./process.ts";
import { FAKE_CLAUDE, makeHarness, realSleep, type Harness } from "./test-helpers.ts";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

describe("parsePs", () => {
  it("每行 pid ppid pgid，前面有空格对齐；空行和认不出的行跳过", () => {
    const out = "    1     0     1\n  200   100   200\n\n  abc\n 301   300   300  \n";
    expect(parsePs(out)).toEqual([
      { pid: 1, ppid: 0, pgid: 1 },
      { pid: 200, ppid: 100, pgid: 200 },
      { pid: 301, ppid: 300, pgid: 300 },
    ]);
  });
});

describe("killTargets（负数 = 进程组，正数 = 单个进程）", () => {
  // 守护进程 100（组 100）起了 claude 200（detached，组 200）；claude 同组的子进程 210；
  // Bash 工具：zsh 300 在新组 300，下面 sleep 301 同组；sleep 301 又起了 302 放进新组 302。不相干的 400。
  const rows: PsRow[] = [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 100, ppid: 1, pgid: 100 },
    { pid: 200, ppid: 100, pgid: 200 },
    { pid: 210, ppid: 200, pgid: 200 },
    { pid: 300, ppid: 200, pgid: 300 },
    { pid: 301, ppid: 300, pgid: 300 },
    { pid: 302, ppid: 301, pgid: 302 },
    { pid: 400, ppid: 1, pgid: 400 },
  ];

  it("冒烟 S10c 的进程链：claude 的组加上每个后代所在的组，各一次", () => {
    expect(killTargets(rows, 200, 100)).toEqual([-200, -300, -302]);
  });

  it("claude 已经不在表里：什么都不杀", () => {
    expect(killTargets(rows, 999, 100)).toEqual([]);
  });

  it("claude 不是组长（不是我们 detached 起的）：它自己和同组的后代按单个进程杀，后代自己开的组照样按组杀", () => {
    const shared: PsRow[] = [
      { pid: 100, ppid: 1, pgid: 100 },
      { pid: 200, ppid: 100, pgid: 100 },
      { pid: 210, ppid: 200, pgid: 100 },
      { pid: 300, ppid: 200, pgid: 300 },
    ];
    expect(killTargets(shared, 200, null)).toEqual([200, 210, -300]);
  });

  it("后代在守护进程自己的组里、或者组号 ≤ 1：只杀那个进程，不按组杀", () => {
    const odd: PsRow[] = [
      { pid: 200, ppid: 100, pgid: 200 },
      { pid: 300, ppid: 200, pgid: 100 },
      { pid: 301, ppid: 200, pgid: 1 },
    ];
    expect(killTargets(odd, 200, 100)).toEqual([-200, 300, 301]);
  });

  it("进程表里有环（ps 两次读之间进程号被复用）：不死循环", () => {
    const loop: PsRow[] = [
      { pid: 200, ppid: 300, pgid: 200 },
      { pid: 300, ppid: 200, pgid: 300 },
    ];
    expect(killTargets(loop, 200, null)).toEqual([-200, -300]);
  });
});

// --- 用假 claude 走驱动层的每条 SIGKILL 路径 ---

let h: Harness | undefined;
const leftovers: number[] = [];
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  for (const pid of leftovers.splice(0)) signal(pid, "SIGKILL");
});

function harness(...args: Parameters<typeof makeHarness>): Harness {
  h = makeHarness(...args);
  return h;
}

const user = (id: number, text: string) => ({ messageIds: [id], source: "user" as const, text });
const detachedSleep = { spawnChild: { sleepSec: 30, detached: true } };

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // 已经不在了
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function goneWithin(pid: number, ms = 3_000): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    if (!alive(pid)) return true;
    await realSleep(25);
  }
  return !alive(pid);
}

/** 等假 claude 记下它起的睡眠子进程，确认它在自己的新进程组里。 */
async function detachedChild(t: Harness): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const e = t.log().find((x) => x.kind === "child");
    if (e?.kind === "child") {
      leftovers.push(e.childPid);
      expect(await pgidOf(e.childPid)).toBe(e.childPid);
      return e.childPid;
    }
    await realSleep(25);
  }
  throw new Error("fake claude never spawned its child");
}

function pgidOf(pid: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const ps = spawn("ps", ["-o", "pgid=", "-p", String(pid)]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("error", reject);
    ps.on("close", () => resolve(Number(out.trim())));
  });
}

describe("强制结束：claude 起在新进程组里的子进程也要没了", () => {
  it("关机超过宽限期", async () => {
    const t = harness({
      driver: { shutdownGraceMs: 200 },
      script: { ignoreSigint: true, turns: [{ steps: [detachedSleep, { sleepMs: 30_000 }] }] },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const child = await detachedChild(t);
    await t.driver.shutdown();
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "shutdown", signal: "SIGKILL" });
    expect(await goneWithin(child)).toBe(true);
  });

  it("启动超时", async () => {
    const t = harness({ driver: { startTimeoutMs: 3_000 }, script: { noInit: true, spawnChildOnStart: { sleepSec: 30, detached: true } } });
    const s = t.addSession();
    const sending = t.driver.send(s.id, user(1, "hi")).catch((e: unknown) => e);
    const child = await detachedChild(t);
    expect(await sending).toMatchObject({ code: "start_timeout" });
    expect(await goneWithin(child)).toBe(true);
  });

  it("关标准输入、SIGINT 都不退，最后一步 SIGKILL", async () => {
    const t = harness({
      driver: { idleCloseMs: 50, interruptGraceMs: 150 },
      script: { ignoreStdinEnd: true, ignoreSigint: true, turns: [{ steps: [detachedSleep, { text: "ok" }] }] },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const child = await detachedChild(t);
    await t.waitFor("session.exited");
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "idle", signal: "SIGKILL" });
    expect(await goneWithin(child)).toBe(true);
  });

  it("清理残留：SIGINT 不退，SIGKILL", async () => {
    const t = harness({
      driver: { interruptGraceMs: 200 },
      script: { ignoreSigint: true, turns: [{ steps: [detachedSleep, { sleepMs: 30_000 }] }] },
    });
    const s = t.addSession({ status: "running" });
    const stray: ChildProcess = spawn(FAKE_CLAUDE, ["-p", "--session-id", s.vendorSessionId], {
      env: { ...process.env, FAKE_CLAUDE_LOG: join(t.dir, "fake-claude.log"), FAKE_CLAUDE_SCRIPT: join(t.dir, "script.json"), FAKE_CLAUDE_STATE: t.dir },
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    });
    if (stray.pid) leftovers.push(stray.pid);
    stray.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }) + "\n");
    const child = await detachedChild(t);
    t.store.update(s.id, { pid: stray.pid! });
    await t.driver.cleanupStale();
    expect(await goneWithin(stray.pid!)).toBe(true);
    expect(await goneWithin(child)).toBe(true);
  });
});

// --- ps 出毛病、守护进程中途退出：停住的进程最后一定被 SIGKILL ---

/** 起一个放在自己新进程组里的 sleep（像被 SIGSTOP 住之后等着挨杀的那种），返回它的进程号。 */
function detachedSleep120(): number {
  const child = spawn("sleep", ["120"], { stdio: "ignore", detached: true });
  child.unref();
  leftovers.push(child.pid!);
  return child.pid!;
}

/** 进程状态（ps 的 stat 列，比如 S、T）；不在了返回空串。 */
function statOf(pid: number): Promise<string> {
  return new Promise((resolve) => {
    const ps = spawn("/bin/ps", ["-o", "stat=", "-p", String(pid)]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => resolve(out.trim()));
  });
}

/** 临时把 PATH 换成只有一个假 ps 的目录（body 是 sh 脚本）。 */
function fakePs(body: string): () => void {
  const dir = mkdtempSync(join(tmpdir(), "fake-ps-"));
  writeFileSync(join(dir, "ps"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, "ps"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  return () => {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  };
}

describe("forceKillTree 的兜底", () => {
  it("ps 跑不了（退出码 1）：退回只杀它的组，组里的进程都没了", async () => {
    const pid = detachedSleep120();
    const restore = fakePs("exit 1");
    try {
      await forceKillTree(pid, true);
    } finally {
      restore();
    }
    expect(await goneWithin(pid)).toBe(true);
  });

  it("ps 卡住不返回：超时之内发了 SIGKILL，不留停住的进程", async () => {
    const pid = detachedSleep120();
    const restore = fakePs("exec sleep 60");
    const t0 = Date.now();
    try {
      await forceKillTree(pid, true);
    } finally {
      restore();
    }
    expect(Date.now() - t0).toBeLessThan(PS_TIMEOUT_MS * 3);
    expect(await goneWithin(pid)).toBe(true);
    expect(await statOf(pid)).toBe("");
  });

  it("等 ps 的时候守护进程 process.exit：退出时同步补 SIGKILL，不留停住的进程", async () => {
    const pid = detachedSleep120();
    const dir = mkdtempSync(join(tmpdir(), "fake-ps-"));
    writeFileSync(join(dir, "ps"), "#!/bin/sh\nexec sleep 60\n");
    chmodSync(join(dir, "ps"), 0o755);
    const processTs = new URL("./process.ts", import.meta.url).pathname;
    const script = `import { forceKillTree } from ${JSON.stringify(processTs)};
void forceKillTree(${pid}, true);
setTimeout(() => process.exit(0), 200);`;
    try {
      await new Promise<void>((resolve, reject) => {
        const node = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdio: "inherit" });
        node.on("error", reject);
        node.on("exit", () => resolve());
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await goneWithin(pid)).toBe(true);
  });

  it("进程号 ≤ 1：什么信号都不发", async () => {
    const spy = vi.spyOn(process, "kill");
    try {
      await forceKillTree(0, true);
      await forceKillTree(1, true);
      await forceKillTree(-1, false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("同一个 child 并发调两次 forceKill：第二次复用进行中的那一次", async () => {
    const child = spawn("sleep", ["120"], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    leftovers.push(child.pid!);
    await new Promise((resolve) => child.once("spawn", resolve));
    const first = forceKill(child);
    expect(forceKill(child)).toBe(first);
    await first;
    expect(await goneWithin(child.pid!)).toBe(true);
  });
});

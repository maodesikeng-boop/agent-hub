// ssh 监督（docs/hub-tunnel-design.md 第 6 节，实现块 C）：用假 ssh（test-fake-ssh.mjs，按剧本退出码 / stderr 退出）测
// 状态分类、退避、提前重连、停止时杀子进程。定时器和时钟由测试注入：退避等多久看登记的定时器，不真的等。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TUNNEL_BACKOFF_MAX_MS, TUNNEL_BACKOFF_MIN_MS, TUNNEL_STABLE_MS } from "../../shared/limits.ts";
import type { TunnelState } from "../../shared/tunnel.ts";
import { createTunnelSupervisor, killStaleSsh, type TunnelSupervisor } from "./supervisor.ts";

const FAKE_SSH = fileURLToPath(new URL("./test-fake-ssh.mjs", import.meta.url));
const CONNECTED = "debug1: remote forward success for: listen 4401, connect /tmp/peer.sock:-2";
const REFUSED = "ssh: connect to host 203.0.113.10 port 22: Connection refused";

type Step = { stderr?: string[]; exit?: number; hang?: boolean; ignoreTerm?: boolean };

let dir: string;
let plan: string;
let clock: number;
let timers: Array<{ ms: number; fn: () => void; cancelled: boolean; fired: boolean }>;
const supervisors: TunnelSupervisor[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-tunnel-sup-"));
  plan = join(dir, "plan.json");
  clock = 1_000_000;
  timers = [];
});
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.stop()));
  for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

function setPlan(steps: Step[]) {
  writeFileSync(plan, JSON.stringify(steps));
}
const spawns = () => (existsSync(`${plan}.count`) ? Number(readFileSync(`${plan}.count`, "utf8")) : 0);
const pids = () => (existsSync(`${plan}.pids`) ? readFileSync(`${plan}.pids`, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const pending = () => timers.filter((t) => !t.cancelled && !t.fired);
function fire() {
  const [t] = pending();
  if (t === undefined) throw new Error("没有等着的定时器");
  t.fired = true;
  t.fn();
}

function supervisor(extra: { pidFile?: string } = {}) {
  const s = createTunnelSupervisor({
    command: FAKE_SSH,
    args: [plan],
    now: () => clock,
    schedule: (ms, fn) => {
      const t = { ms, fn, cancelled: false, fired: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    stopGraceMs: 300,
    ...extra,
  });
  supervisors.push(s);
  return s;
}

/** 等到状态变成 state（子进程事件推动，不轮询）。 */
function until(s: TunnelSupervisor, state: TunnelState): Promise<void> {
  if (s.status().state === state) return Promise.resolve();
  return new Promise((resolve) => {
    const off = s.onChange((status) => {
      if (status.state !== state) return;
      off();
      resolve();
    });
  });
}

/** 等子进程第 n 次被启动并真的跑起来（进程号写进了 .pids）。 */
async function spawned(n: number) {
  while (pids().length < n) await new Promise((r) => setTimeout(r, 10));
}

describe.skipIf(process.platform === "win32")("状态分类", () => {
  it("看到 remote forward success 才算 connected；之前是 connecting", async () => {
    setPlan([{ stderr: ["debug1: Authenticated to x ([1.2.3.4]:22) using \"publickey\".", CONNECTED], hang: true }]);
    const s = supervisor();
    const seen: TunnelState[] = [];
    s.onChange((st) => seen.push(st.state));
    s.start();
    expect(s.status().state).toBe("connecting");
    await until(s, "connected");
    expect(seen).toEqual(["connecting", "connected"]);
    expect(s.status()).toMatchObject({ state: "connected", since: clock, retryAt: null });
  });

  it("Permission denied → auth_failed，不自动重试；原因留着", async () => {
    setPlan([{ stderr: ["debug1: Offering public key", "agenthub-tunnel@h: Permission denied (publickey)."], exit: 255 }]);
    const s = supervisor();
    s.start();
    await until(s, "auth_failed");
    expect(s.status()).toMatchObject({ state: "auth_failed", retryAt: null, detail: "agenthub-tunnel@h: Permission denied (publickey)." });
    expect(pending()).toEqual([]);
    expect(spawns()).toBe(1);
  });

  it("主机公钥变了 / 认不出 → hostkey_mismatch，不自动重试", async () => {
    for (const stderr of [
      ["@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@", "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @", "Host key verification failed."],
      ["No ED25519 host key is known for agent-hub-hub and you have requested strict checking.", "Host key verification failed."],
    ]) {
      rmSync(`${plan}.count`, { force: true });
      setPlan([{ stderr, exit: 255 }]);
      const s = supervisor();
      s.start();
      await until(s, "hostkey_mismatch");
      expect(pending()).toEqual([]);
      await s.stop();
    }
  });

  it("别的失败（连不上、东京旧连接还占着端口）→ retrying，带下次时间和原因", async () => {
    setPlan([{ stderr: ["Error: remote port forwarding failed for listen port 4401"], exit: 255 }]);
    const s = supervisor();
    s.start();
    await until(s, "retrying");
    expect(s.status()).toMatchObject({
      state: "retrying",
      retryAt: clock + TUNNEL_BACKOFF_MIN_MS,
      detail: "Error: remote port forwarding failed for listen port 4401",
    });
  });

  it("ssh 本身起不来（找不到程序）也是 retrying", async () => {
    const s = createTunnelSupervisor({ command: join(dir, "no-such-ssh"), args: [], now: () => clock, schedule: (ms, fn) => (timers.push({ ms, fn, cancelled: false, fired: false }), () => {}) });
    supervisors.push(s);
    s.start();
    await until(s, "retrying");
    expect(s.status().detail).toMatch(/ENOENT|no-such-ssh/);
  });
});

describe.skipIf(process.platform === "win32")("退避", () => {
  it("1→2→4…→60 秒封顶；定时器到了才重连", async () => {
    setPlan([{ stderr: [REFUSED], exit: 255 }]);
    const s = supervisor();
    s.start();
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      await until(s, "retrying");
      expect(spawns()).toBe(i + 1);
      const [t] = pending();
      delays.push(t!.ms);
      fire();
      expect(s.status().state).toBe("connecting");
    }
    expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60].map((x) => x * 1000));
    expect(TUNNEL_BACKOFF_MIN_MS).toBe(1_000);
    expect(TUNNEL_BACKOFF_MAX_MS).toBe(60_000);
  });

  it("连上稳定 60 秒后断开：退避从 1 秒重新算；不到 60 秒断开接着翻倍", async () => {
    setPlan([{ stderr: [REFUSED], exit: 255 }, { stderr: [REFUSED], exit: 255 }, { stderr: [CONNECTED], hang: true }, { stderr: [CONNECTED], hang: true }, { stderr: [REFUSED], exit: 255 }]);
    const s = supervisor();
    s.start();
    await until(s, "retrying");
    fire(); // 1 秒
    await until(s, "retrying");
    expect(pending()[0]!.ms).toBe(2_000);
    fire();
    await until(s, "connected");
    // 连上不到 60 秒就断：接着翻倍
    process.kill(pids()[2]!, "SIGTERM");
    await until(s, "retrying");
    expect(pending()[0]!.ms).toBe(4_000);
    fire();
    await until(s, "connected");
    clock += TUNNEL_STABLE_MS;
    process.kill(pids()[3]!, "SIGTERM");
    await until(s, "retrying");
    expect(pending()[0]!.ms).toBe(1_000);
  });
});

describe.skipIf(process.platform === "win32")("提前重连（给转发用：/d/<中心> 连不上时调）", () => {
  it("在等退避：取消定时器、马上连；同一个退避周期里只提前一次", async () => {
    setPlan([{ stderr: [REFUSED], exit: 255 }]);
    const s = supervisor();
    s.start();
    await until(s, "retrying");
    const [t] = pending();
    expect(s.reconnectNow()).toBe(true);
    expect(t!.cancelled).toBe(true);
    expect(s.status().state).toBe("connecting");
    await spawned(2);
    await until(s, "retrying");
    // 第二个失败的请求：不再提前，等退避
    expect(s.reconnectNow()).toBe(false);
    expect(pending()).toHaveLength(1);
    expect(spawns()).toBe(2);
  });

  it("显示连着但其实已断（比如刚睡醒）：杀掉旧的马上重连，不等退避；稳定连上 60 秒后又能提前一次", async () => {
    setPlan([{ stderr: [CONNECTED], hang: true }]);
    const s = supervisor();
    s.start();
    await until(s, "connected");
    expect(s.reconnectNow()).toBe(true);
    await spawned(2);
    await until(s, "connected");
    expect(alive(pids()[0]!)).toBe(false);
    expect(pending()).toEqual([]);
    // 同一周期：不再提前
    expect(s.reconnectNow()).toBe(false);
    clock += TUNNEL_STABLE_MS;
    expect(s.reconnectNow()).toBe(true);
    await spawned(3);
    await until(s, "connected");
    expect(s.reconnectNow()).toBe(false);
  });

  it("正在连、鉴权失败、主机公钥不对时不提前", async () => {
    setPlan([{ stderr: ["u@h: Permission denied (publickey)."], exit: 255 }]);
    const s = supervisor();
    s.start();
    expect(s.reconnectNow()).toBe(false);
    await until(s, "auth_failed");
    expect(s.reconnectNow()).toBe(false);
    expect(spawns()).toBe(1);
  });

  it("retry()：用户点重试，鉴权失败后也重新连，退避清零", async () => {
    setPlan([{ stderr: ["u@h: Permission denied (publickey)."], exit: 255 }, { stderr: [REFUSED], exit: 255 }]);
    const s = supervisor();
    s.start();
    await until(s, "auth_failed");
    s.retry();
    expect(s.status().state).toBe("connecting");
    await until(s, "retrying");
    expect(pending()[0]!.ms).toBe(TUNNEL_BACKOFF_MIN_MS);
  });
});

describe.skipIf(process.platform === "win32")("停止", () => {
  it("杀掉子进程；之后不再重连、不再报状态", async () => {
    setPlan([{ stderr: [CONNECTED], hang: true }]);
    const s = supervisor();
    s.start();
    await until(s, "connected");
    const pid = pids()[0]!;
    let changes = 0;
    s.onChange(() => changes++);
    await s.stop();
    expect(alive(pid)).toBe(false);
    expect(pending()).toEqual([]);
    expect(changes).toBe(0);
    expect(spawns()).toBe(1);
  });

  it("子进程不理 SIGTERM：过了宽限时间 SIGKILL", async () => {
    setPlan([{ stderr: [CONNECTED], hang: true, ignoreTerm: true }]);
    const s = supervisor();
    s.start();
    await until(s, "connected");
    const pid = pids()[0]!;
    await s.stop();
    expect(alive(pid)).toBe(false);
  });

  it("在等退避时停：取消定时器", async () => {
    setPlan([{ stderr: [REFUSED], exit: 255 }]);
    const s = supervisor();
    s.start();
    await until(s, "retrying");
    const [t] = pending();
    await s.stop();
    expect(t!.cancelled).toBe(true);
  });

  it("进程号文件：起了写、退了删；上次守护进程被强杀留下的 ssh，下次启动时按文件杀掉（只杀命令行对得上的）", async () => {
    const pidFile = join(dir, "ssh.pid");
    setPlan([{ stderr: [CONNECTED], hang: true }]);
    const s = supervisor({ pidFile });
    s.start();
    await until(s, "connected");
    expect(Number(readFileSync(pidFile, "utf8"))).toBe(pids()[0]);
    await s.stop();
    expect(existsSync(pidFile)).toBe(false);

    // 留下的：命令行里有标记（钥匙文件路径）的才杀；沙箱里 ps 被禁时宁可不杀也不超时泄漏
    const canRunPs = (() => {
      try {
        execFileSync("ps", ["-o", "pid=", "-p", String(process.pid)], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();
    const orphan = spawn(process.execPath, [FAKE_SSH, plan], { stdio: "ignore" });
    const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    try {
      await spawned(2);
      writeFileSync(pidFile, String(stranger.pid));
      await killStaleSsh(pidFile, plan);
      expect(alive(stranger.pid!)).toBe(true);
      writeFileSync(pidFile, String(orphan.pid));
      await killStaleSsh(pidFile, plan);
      if (canRunPs) {
        await new Promise((r) => orphan.once("exit", r));
        expect(alive(orphan.pid!)).toBe(false);
      } else {
        expect(alive(orphan.pid!)).toBe(true);
      }
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      orphan.kill("SIGKILL");
      stranger.kill("SIGKILL");
    }
    // 文件不在、进程早没了：什么都不做
    await killStaleSsh(pidFile, plan);
  });
});

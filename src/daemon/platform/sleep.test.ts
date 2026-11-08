// 有活在跑时不让 Mac 睡（caffeinate）：按活跃会话数起停 /usr/bin/caffeinate -i -w <pid>，归零后等宽限期再结束。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLEEP_INHIBIT_GRACE_MS } from "../../shared/index.ts";
import {
  MACOS_CAFFEINATE_BIN,
  SLEEP_INHIBIT_COMMANDS,
  createSleepInhibitor,
  type SleepInhibitProcess,
} from "./index.ts";

interface FakeProc {
  command: string;
  args: string[];
  killed: number;
  exit(): void;
}

function createFakeSpawner() {
  const spawned: FakeProc[] = [];
  const spawn = (command: string, args: string[]): SleepInhibitProcess => {
    let onExitListener: (() => void) | undefined;
    const proc: FakeProc = {
      command,
      args,
      killed: 0,
      exit: () => onExitListener?.(),
    };
    spawned.push(proc);
    return {
      kill() {
        proc.killed++;
      },
      onExit(listener) {
        onExitListener = listener;
      },
    };
  };
  return { spawned, spawn };
}

describe("防闲置睡眠（caffeinate）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("启动参数包含 -i -w <守护进程 pid>，路径常量集中定义；非 darwin 平台不起进程", () => {
    expect(MACOS_CAFFEINATE_BIN).toBe("/usr/bin/caffeinate");
    expect(SLEEP_INHIBIT_COMMANDS.darwin).toEqual({
      command: "/usr/bin/caffeinate",
      args: expect.any(Function),
    });
    expect(SLEEP_INHIBIT_COMMANDS.linux).toBeUndefined();

    const mac = createFakeSpawner();
    const darwinInhibitor = createSleepInhibitor({
      platform: "darwin",
      daemonPid: 42424,
      spawn: mac.spawn,
    });
    darwinInhibitor.acquire();
    expect(mac.spawned).toHaveLength(1);
    expect(mac.spawned[0]?.command).toBe("/usr/bin/caffeinate");
    expect(mac.spawned[0]?.args).toEqual(["-i", "-w", "42424"]);
    darwinInhibitor.stop();

    const linux = createFakeSpawner();
    const linuxInhibitor = createSleepInhibitor({
      platform: "linux",
      daemonPid: 42424,
      spawn: linux.spawn,
    });
    linuxInhibitor.acquire();
    expect(linuxInhibitor.activeCount()).toBe(1);
    expect(linux.spawned).toHaveLength(0);
    linuxInhibitor.release();
    vi.advanceTimersByTime(SLEEP_INHIBIT_GRACE_MS * 2);
    expect(linux.spawned).toHaveLength(0);
  });

  it("活跃会话数 0→1 起一个，1→2 不再起第二个", () => {
    const { spawned, spawn } = createFakeSpawner();
    const inhibitor = createSleepInhibitor({ platform: "darwin", daemonPid: 1001, spawn });

    expect(inhibitor.activeCount()).toBe(0);
    expect(spawned).toHaveLength(0);

    inhibitor.acquire();
    expect(inhibitor.activeCount()).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.killed).toBe(0);

    inhibitor.acquire();
    expect(inhibitor.activeCount()).toBe(2);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.killed).toBe(0);
  });

  it("2→1 不结束，1→0 后等宽限期（120_000 ms）到才结束", () => {
    expect(SLEEP_INHIBIT_GRACE_MS).toBe(120_000);
    const { spawned, spawn } = createFakeSpawner();
    const inhibitor = createSleepInhibitor({ platform: "darwin", daemonPid: 1001, spawn });

    inhibitor.acquire();
    inhibitor.acquire();
    expect(inhibitor.activeCount()).toBe(2);

    // 2 → 1：不结束，也不进宽限期
    inhibitor.release();
    expect(inhibitor.activeCount()).toBe(1);
    vi.advanceTimersByTime(SLEEP_INHIBIT_GRACE_MS * 2);
    expect(spawned[0]?.killed).toBe(0);

    // 1 → 0：宽限期到之前不结束，到点才结束
    inhibitor.release();
    expect(inhibitor.activeCount()).toBe(0);
    vi.advanceTimersByTime(SLEEP_INHIBIT_GRACE_MS - 1);
    expect(spawned[0]?.killed).toBe(0);

    vi.advanceTimersByTime(1);
    expect(spawned[0]?.killed).toBe(1);
  });

  it("宽限期内又从 0→1 忙起来：取消定时器、不重起进程", () => {
    const { spawned, spawn } = createFakeSpawner();
    const inhibitor = createSleepInhibitor({ platform: "darwin", daemonPid: 1001, spawn });

    inhibitor.acquire();
    expect(spawned).toHaveLength(1);

    // 1 → 0 进入宽限期，过了半程又 0 → 1
    inhibitor.release();
    vi.advanceTimersByTime(SLEEP_INHIBIT_GRACE_MS / 2);
    expect(spawned[0]?.killed).toBe(0);

    inhibitor.acquire();
    expect(inhibitor.activeCount()).toBe(1);
    expect(spawned).toHaveLength(1);

    // 再过完原来的宽限期，因为定时器已取消，进程依然活着
    vi.advanceTimersByTime(SLEEP_INHIBIT_GRACE_MS * 2);
    expect(spawned[0]?.killed).toBe(0);

    // 再次 1 → 0，等满新的宽限期才结束
    inhibitor.release();
    vi.advanceTimersByTime(SLEEP_INHIBIT_GRACE_MS - 1);
    expect(spawned[0]?.killed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(spawned[0]?.killed).toBe(1);
  });

  it("关机（stop / dispose）时立即结束进程并清定时器", () => {
    const { spawned, spawn } = createFakeSpawner();
    const inhibitor = createSleepInhibitor({ platform: "darwin", daemonPid: 1001, spawn });

    // 在跑时关机：立即结束进程
    inhibitor.acquire();
    expect(spawned).toHaveLength(1);
    inhibitor.stop();
    expect(spawned[0]?.killed).toBe(1);
    expect(inhibitor.activeCount()).toBe(0);

    // 关机后再有状态变化也不再起进程
    inhibitor.acquire();
    expect(spawned).toHaveLength(1);

    // 宽限期内关机（dispose）：立即结束进程并清掉定时器（到期不会二次 kill）
    const second = createFakeSpawner();
    const inhibitor2 = createSleepInhibitor({ platform: "darwin", daemonPid: 1002, spawn: second.spawn });
    inhibitor2.acquire();
    inhibitor2.release();
    expect(second.spawned[0]?.killed).toBe(0);
    inhibitor2.dispose();
    expect(second.spawned[0]?.killed).toBe(1);
    vi.advanceTimersByTime(SLEEP_INHIBIT_GRACE_MS * 2);
    expect(second.spawned[0]?.killed).toBe(1);
  });

  it("靠会话状态变化事件驱动（onSessionStatus）：同一会话重复忙事件不重复计数，项目经理和 Worker 一起计数", () => {
    const { spawned, spawn } = createFakeSpawner();
    const inhibitor = createSleepInhibitor({ platform: "darwin", daemonPid: 1001, spawn });

    // 空闲事件在 0 时无动作
    inhibitor.onSessionStatus({ sessionId: 1, activity: "idle" });
    expect(inhibitor.activeCount()).toBe(0);
    expect(spawned).toHaveLength(0);

    // 会话 1（项目经理）开始干活：0 → 1，起进程；同一轮内连续推 working / stopping 不重复加
    inhibitor.onSessionStatus({ sessionId: 1, activity: "working" });
    inhibitor.onSessionStatus({ sessionId: 1, activity: "working" });
    inhibitor.onSessionStatus({ sessionId: 1, activity: "stopping" });
    expect(inhibitor.activeCount()).toBe(1);
    expect(spawned).toHaveLength(1);

    // 会话 2（Worker）开始准备 / 干活 / 等后台命令：1 → 2，不起第二个
    inhibitor.onSessionStatus({ sessionId: 2, activity: "preparing" });
    inhibitor.onSessionStatus({ sessionId: 2, activity: "working" });
    inhibitor.onSessionStatus({ sessionId: 2, activity: "background" });
    expect(inhibitor.activeCount()).toBe(2);
    expect(spawned).toHaveLength(1);

    // 会话 1 回到空闲：2 → 1；重复推 idle 不多减
    inhibitor.onSessionStatus({ sessionId: 1, activity: "idle" });
    inhibitor.onSessionStatus({ sessionId: 1, activity: "idle" });
    expect(inhibitor.activeCount()).toBe(1);
    expect(spawned[0]?.killed).toBe(0);

    // 会话 2 回到空闲：1 → 0，等宽限期后结束
    inhibitor.onSessionStatus({ sessionId: 2, activity: "idle" });
    expect(inhibitor.activeCount()).toBe(0);
    expect(spawned[0]?.killed).toBe(0);
    vi.advanceTimersByTime(SLEEP_INHIBIT_GRACE_MS);
    expect(spawned[0]?.killed).toBe(1);
  });

  it("进程自己意外退出后，下一次从 0→1 会重新拉起", () => {
    const { spawned, spawn } = createFakeSpawner();
    const inhibitor = createSleepInhibitor({ platform: "darwin", daemonPid: 1001, spawn });

    inhibitor.acquire();
    expect(spawned).toHaveLength(1);
    spawned[0]?.exit();

    inhibitor.release();
    inhibitor.acquire();
    expect(spawned).toHaveLength(2);
  });
});

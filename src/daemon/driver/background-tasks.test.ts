// 会话里有后台任务时不算闲着（background-tasks.ts + src/vendors/claude/driver.ts 的 #armIdle、#onBackgroundTasksChanged）：
// 用假 claude 发 system/background_tasks_changed。事件的真实形状见 docs/m0-report.md“后台任务事件”。
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_TASKS_HOLD_MAX_MS, IDLE_CLOSE_MS, RELAUNCH_NOTE, backgroundTasksKilledNote } from "../../shared/index.ts";
import type { FakeTurn } from "../../../test/fake-claude/fake-claude.ts";
import { BackgroundTasks, idleDelayMs } from "./background-tasks.ts";
import { makeHarness, realSleep, type Harness } from "./test-helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const user = (id: number, text: string) => ({ messageIds: [id], source: "user" as const, text });
/** 空闲关闭 150 ms；有后台任务时兜底 1200 ms。 */
const IDLE = 150;
const HOLD = 1200;
const timers = { idleCloseMs: IDLE, backgroundHoldMaxMs: HOLD };

function harness(turns: FakeTurn[], driver: Record<string, number> = timers): Harness {
  h = makeHarness({ script: { turns }, driver });
  return h;
}

/** 一轮：回一句，然后按时间发后台任务事件（从 result 起算）。 */
const turnWith = (backgroundTasksAfter: FakeTurn["backgroundTasksAfter"], extra: Partial<FakeTurn> = {}): FakeTurn => ({
  steps: [{ text: "好" }],
  backgroundTasksAfter,
  ...extra,
});

describe("BackgroundTasks", () => {
  it("每次整个换成事件里的名单：重复的 task_id 算一个，ambient、残缺的条目不算", () => {
    const t = new BackgroundTasks();
    expect(t.replace([{ task_id: "a" }, { task_id: "a" }, { task_id: "b", ambient: true }, { task_id: "" }, { nope: 1 }, null, "x", { task_id: 7 }])).toBe(true);
    expect(t.count).toBe(1);
    expect(t.replace([{ task_id: "c" }, { task_id: "d" }])).toBe(true);
    expect(t.count).toBe(2);
    expect(t.replace([])).toBe(true);
    expect(t.active).toBe(false);
  });

  it("tasks 不是数组：当没收到，记的不动", () => {
    const t = new BackgroundTasks();
    t.replace([{ task_id: "a" }]);
    for (const bad of [undefined, null, "a", 1, {}]) expect(t.replace(bad)).toBe(false);
    expect(t.count).toBe(1);
    t.clear();
    expect(t.count).toBe(0);
  });

  it("空闲时长：没任务是 idleCloseMs，有任务是兜底上限（不会比 idleCloseMs 短）；默认值兜底远大于空闲", () => {
    const t = new BackgroundTasks();
    expect(idleDelayMs(t, 100, 5000)).toBe(100);
    t.replace([{ task_id: "a" }]);
    expect(idleDelayMs(t, 100, 5000)).toBe(5000);
    expect(idleDelayMs(t, 100, 50)).toBe(100);
    expect(BACKGROUND_TASKS_HOLD_MAX_MS).toBeGreaterThan(IDLE_CLOSE_MS);
  });
});

describe("background.changed 事件（账本给 hub worker show 用）", () => {
  it("名单变了就发一个，带现在还在跑的个数；tasks 不是数组的不发", async () => {
    const t = harness([turnWith([{ afterMs: 20, tasks: ["a"] }, { afterMs: 60, tasks: ["a", "b"] }, { afterMs: 100, tasks: [] }])]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    await t.waitFor("turn.ended");
    await t.waitFor("background.changed", (e) => e.count === 0, 1);
    expect(t.of("background.changed").map((e) => e.count)).toEqual([1, 2, 0]);
  });
});

describe("有后台任务时空闲计时不触发", () => {
  it("一轮结束时还有任务（轮内发的）：过了好几个 idleCloseMs 进程还在，没有 session.exited", async () => {
    const t = harness([{ steps: [{ backgroundTasks: ["a"] }, { text: "已放后台" }] }]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "跑一个后台任务"));
    await t.waitFor("turn.ended");
    await realSleep(IDLE * 4);
    expect(t.of("session.exited")).toEqual([]);
    expect(t.driver.isRunning(s.id)).toBe(true);
  });

  it("一轮结束后空闲计时已经在走，这时来了任务：计时停掉，换成兜底", async () => {
    const t = harness([turnWith([{ afterMs: IDLE / 3, tasks: ["a"] }])]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    await t.waitFor("turn.ended");
    await realSleep(IDLE * 4);
    expect(t.of("session.exited")).toEqual([]);
  });

  it("有任务期间还能照常收发消息，一轮结束后仍不关", async () => {
    const t = harness([{ steps: [{ backgroundTasks: ["a"] }, { text: "一" }] }, { steps: [{ text: "二" }] }]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    await realSleep(IDLE * 2);
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    await realSleep(IDLE * 3);
    expect(t.of("session.exited")).toEqual([]);
  });
});

describe("任务清零以后再闲够时间才关", () => {
  it("清零后 idleCloseMs 才关：不早于它，也不拖到兜底", async () => {
    const CLEAR = 400;
    const t = harness([turnWith([{ afterMs: 50, tasks: ["a"] }, { afterMs: CLEAR, tasks: [] }])]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    const ended = await t.waitFor("turn.ended");
    await realSleep(CLEAR - 50);
    expect(t.of("session.exited")).toEqual([]); // 清零前一直不关
    const exited = await t.waitFor("session.exited");
    expect(exited).toMatchObject({ reason: "idle", exitCode: 0 });
    // 清零在 result 后 CLEAR ms，再闲 IDLE 才关（留一点计时误差）
    expect(exited.at - ended.at).toBeGreaterThanOrEqual(CLEAR + IDLE - 60);
    expect(exited.at - ended.at).toBeLessThan(HOLD);
  });

  it("任务数先增后减（2 → 1 → 0）：还剩一个就不关，清零才开始计时", async () => {
    const t = harness([turnWith([
      { afterMs: 20, tasks: ["a"] },
      { afterMs: 60, tasks: ["a", "b"] },
      { afterMs: 300, tasks: ["b"] },
      { afterMs: 700, tasks: [] },
    ])]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    const ended = await t.waitFor("turn.ended");
    await realSleep(600);
    expect(t.of("session.exited")).toEqual([]);
    const exited = await t.waitFor("session.exited");
    expect(exited.at - ended.at).toBeGreaterThanOrEqual(700 + IDLE - 60);
  });

  it("重复的事件：同样的名单发几遍，既不多算也不提前关；清零一次就够", async () => {
    const t = harness([turnWith([
      { afterMs: 20, tasks: ["a", "a"] },
      { afterMs: 60, tasks: ["a"] },
      { afterMs: 100, tasks: ["a"] },
      { afterMs: 500, tasks: [] },
      { afterMs: 520, tasks: [] },
    ])]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    const ended = await t.waitFor("turn.ended");
    await realSleep(450);
    expect(t.of("session.exited")).toEqual([]);
    const exited = await t.waitFor("session.exited");
    expect(exited.at - ended.at).toBeGreaterThanOrEqual(500 + IDLE - 60);
    expect(t.of("driver.error")).toEqual([]);
  });

  it("事件里的名单和我们记的对不上：以事件为准（换成新的名单，不靠增减）", async () => {
    // 我们记的是 a、b；之后事件只说 c（a、b 的结束事件丢了）→ 记成 c；再清零才关
    const t = harness([turnWith([
      { afterMs: 20, tasks: ["a", "b"] },
      { afterMs: 80, tasks: ["c"] },
      { afterMs: 500, tasks: [] },
    ])]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    const ended = await t.waitFor("turn.ended");
    await realSleep(450);
    expect(t.of("session.exited")).toEqual([]);
    const exited = await t.waitFor("session.exited");
    expect(exited.at - ended.at).toBeGreaterThanOrEqual(500 + IDLE - 60);
  });

  it("名单里只有 ambient 的任务：不算后台任务，照常按 idleCloseMs 关", async () => {
    const t = harness([turnWith([{ afterMs: 10, tasks: [{ task_id: "w", task_type: "local_bash", description: "watcher", ambient: true }] }])]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    const ended = await t.waitFor("turn.ended");
    const exited = await t.waitFor("session.exited");
    expect(exited.reason).toBe("idle");
    expect(exited.at - ended.at).toBeLessThan(HOLD / 2);
  });

  it("残缺的事件（没有 tasks 数组）：忽略，记的不动，不报错", async () => {
    const t = harness([turnWith([{ afterMs: 20, tasks: ["a"] }, { afterMs: 60, tasks: "malformed" }])]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    await t.waitFor("turn.ended");
    await realSleep(IDLE * 4);
    expect(t.of("session.exited")).toEqual([]);
    expect(t.of("driver.error")).toEqual([]);
  });

  it("任务结束后 claude 自己开的一轮：先清零再开轮（真 claude 的顺序），这一轮跑完才开始算空闲", async () => {
    const t = harness([
      turnWith([{ afterMs: 20, tasks: ["a"] }, { afterMs: 300, tasks: [] }], {
        selfTurn: { steps: [{ sleepMs: 400 }, { text: "后台好了" }], afterMs: 305 },
      }),
    ]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    await t.waitFor("turn.ended", () => true, 2); // 自己开的那一轮
    const ended = t.of("turn.ended")[1]!;
    expect(ended.messageIds).toEqual([]);
    expect(t.of("agent.text").map((e) => e.text)).toEqual(["好", "后台好了"]);
    const exited = await t.waitFor("session.exited");
    expect(exited.reason).toBe("idle");
    expect(exited.at - ended.at).toBeGreaterThanOrEqual(IDLE - 40);
  });
});

describe("兜底上限", () => {
  it("任务一直不结束：到 backgroundHoldMaxMs 照常空闲关闭，记一条日志", async () => {
    const logs: string[] = [];
    const t = harness([{ steps: [{ backgroundTasks: ["stuck"] }, { text: "放后台了" }] }], { ...timers, backgroundHoldMaxMs: 500, log: ((l: string) => logs.push(l)) as never });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    const ended = await t.waitFor("turn.ended");
    await realSleep(350);
    expect(t.of("session.exited")).toEqual([]);
    const exited = await t.waitFor("session.exited");
    expect(exited).toMatchObject({ reason: "idle" });
    expect(exited.at - ended.at).toBeGreaterThanOrEqual(500 - 60);
    expect(logs.some((l) => l.includes("后台任务还有 1 个没结束"))).toBe(true);
  });

  it("名单一直在变（仍有任务）不重置兜底：从这一轮结束起算", async () => {
    const t = harness(
      [turnWith([
        { afterMs: 20, tasks: ["a"] },
        { afterMs: 200, tasks: ["a", "b"] },
        { afterMs: 400, tasks: ["b"] },
      ])],
      { ...timers, backgroundHoldMaxMs: 600 },
    );
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    const ended = await t.waitFor("turn.ended");
    const exited = await t.waitFor("session.exited");
    expect(exited.at - ended.at).toBeLessThan(600 + 250);
  });
});

describe("进程退出时状态清掉", () => {
  it("崩溃：下一个进程没有任务，照常按 idleCloseMs 关（不带着旧的后台任务）", async () => {
    const t = harness(
      [{ steps: [{ backgroundTasks: ["a"] }, { exit: 1 }] }, { steps: [{ text: "新进程" }] }],
      { idleCloseMs: IDLE, backgroundHoldMaxMs: 60_000 },
    );
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x")).catch(() => {});
    await t.waitFor("session.exited");
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "crash" });
    await t.driver.send(s.id, user(2, "再来"));
    const ended = await t.waitFor("turn.ended");
    const exited = await t.waitFor("session.exited", (e) => e.reason === "idle");
    expect(exited.at - ended.at).toBeLessThan(2000);
  });

  it("停止（interrupt）：进程退出后状态清掉，下一个进程照常按 idleCloseMs 关", async () => {
    // ignoreControl：不回应打断，等 interruptGraceMs 后 SIGINT，进程退出
    h = makeHarness({
      script: { ignoreControl: true, turns: [{ steps: [{ backgroundTasks: ["a"] }, { sleepMs: 20_000 }] }, { steps: [{ text: "新进程" }] }] },
      driver: { idleCloseMs: IDLE, backgroundHoldMaxMs: 60_000, interruptGraceMs: 200 },
    });
    const t = h;
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    await t.waitFor("message.processing");
    await realSleep(100);
    await t.driver.interrupt(s.id);
    await t.waitFor("session.exited");
    await t.driver.send(s.id, user(2, "再来"));
    const ended = await t.waitFor("turn.ended", (e) => e.messageIds.includes(2));
    const exited = await t.waitFor("session.exited", (e) => e.reason === "idle");
    expect(exited.at - ended.at).toBeLessThan(2000);
  });

  it("end：有任务也能结束，进程退出", async () => {
    const t = harness([{ steps: [{ backgroundTasks: ["a"] }, { text: "x" }] }], { idleCloseMs: IDLE, backgroundHoldMaxMs: 60_000 });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    await t.waitFor("turn.ended");
    await t.driver.end(s.id);
    expect(t.of("session.exited").at(-1)).toMatchObject({ reason: "idle" });
    expect(t.driver.isRunning(s.id)).toBe(false);
  });

  it("关机：有任务也马上关，不等兜底", async () => {
    const t = harness([{ steps: [{ backgroundTasks: ["a"] }, { text: "x" }] }], { idleCloseMs: IDLE, backgroundHoldMaxMs: 60_000 });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    await t.waitFor("turn.ended");
    const began = Date.now();
    await t.driver.shutdown();
    expect(Date.now() - began).toBeLessThan(5000);
    expect(t.of("session.exited").at(-1)).toMatchObject({ reason: "shutdown" });
    expect(t.of("driver.error")).toEqual([]);
  });
});

describe("关进程会结束后台任务：下一条消息前告诉 agent（只一次）", () => {
  it("说明的文字：列出任务描述，超过 5 个只列前 5 个，描述太长截断", () => {
    expect(backgroundTasksKilledNote("relaunch", ["等 CI"])).toBe("【系统】为了让新设置生效重启了，正在跑的 1 个后台任务（等 CI）被结束了，需要的话重新启动。");
    const many = backgroundTasksKilledNote("hold_max", ["a", "b", "c", "d", "e", "f", "g"]);
    expect(many).toContain("7 个后台任务（a；b；c；d；e；等共 7 个）");
    expect(many).toContain("后台任务太久没结束");
    expect(backgroundTasksKilledNote("relaunch", ["x".repeat(200)])).toContain(`${"x".repeat(80)}…`);
    expect(backgroundTasksKilledNote("relaunch", [""])).toContain("（没有描述）");
  });

  it("有后台任务时设置变了重启：下一条消息前有说明，之后的不再有；没有后台任务的重启没有这句", async () => {
    const t = harness([{ steps: [{ backgroundTasks: [{ task_id: "ci", description: "等 CI 跑完" }] }, { text: "一" }] }, { steps: [{ text: "二" }] }, { steps: [{ text: "三" }] }], {
      idleCloseMs: 60_000,
      backgroundHoldMaxMs: 60_000,
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    t.launch.fingerprint = "v2";
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    await t.driver.send(s.id, user(3, "三"));
    await t.waitFor("turn.ended", undefined, 3);
    const killed = backgroundTasksKilledNote("relaunch", ["等 CI 跑完"]);
    expect(t.stdinTexts()).toEqual(["一", `${RELAUNCH_NOTE}\n\n${killed}\n\n二`, "三"]);
    // 新进程不带旧名单：它空闲时按 idleCloseMs 算，不是兜底
    expect(t.of("session.exited").map((e) => e.reason)).toEqual(["idle"]);
  });

  it("兜底到点关闭后再发消息：同样带说明，只一次", async () => {
    const t = harness([{ steps: [{ backgroundTasks: [{ task_id: "x", description: "卡死的任务" }] }, { text: "一" }] }, { steps: [{ text: "二" }] }, { steps: [{ text: "三" }] }], {
      idleCloseMs: 100,
      backgroundHoldMaxMs: 300,
      log: (() => {}) as never,
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("session.exited");
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    await t.waitFor("session.exited", undefined, 2);
    await t.driver.send(s.id, user(3, "三"));
    await t.waitFor("turn.ended", undefined, 3);
    expect(t.stdinTexts()).toEqual(["一", `${backgroundTasksKilledNote("hold_max", ["卡死的任务"])}\n\n二`, "三"]);
  });

  it("没有后台任务的空闲关闭：下一条消息前没有这句", async () => {
    const t = harness([{ steps: [{ text: "一" }] }, { steps: [{ text: "二" }] }]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("session.exited");
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.stdinTexts()).toEqual(["一", "二"]);
  });
});

describe("边角", () => {
  it("claude 自己开的一轮一直跑过了兜底时长：不在它跑的时候关；它结束后兜底重新算，到点才关并带说明", async () => {
    const t = harness(
      [
        { steps: [{ backgroundTasks: [{ task_id: "a", description: "还在等" }] }, { text: "一" }], selfTurn: { steps: [{ sleepMs: 700 }, { text: "自己开的" }], afterMs: 100 } },
        { steps: [{ text: "二" }] },
      ],
      { idleCloseMs: 100, backgroundHoldMaxMs: 300, log: (() => {}) as never },
    );
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended", () => true, 2);
    const selfEnded = t.of("turn.ended")[1]!;
    expect(t.of("session.exited")).toEqual([]); // 自己开的一轮跑了 700 ms，比兜底 300 ms 长，没被关
    const exited = await t.waitFor("session.exited");
    expect(exited.reason).toBe("idle");
    expect(exited.at - selfEnded.at).toBeGreaterThanOrEqual(300 - 60);
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 3);
    expect(t.stdinTexts()).toEqual(["一", `${backgroundTasksKilledNote("hold_max", ["还在等"])}\n\n二`]);
  });

  it("正在关闭（proc.closing）时收到 background_tasks_changed：记下来不报错、不重新计时；退出后新进程不带它", async () => {
    // 空闲关闭后 claude 不理标准输入关闭，拖到 SIGINT 才退；这期间来了一条名单
    h = makeHarness({
      script: { ignoreStdinEnd: true, turns: [turnWith([{ afterMs: 300, tasks: ["late"] }]), { steps: [{ text: "二" }] }] },
      driver: { idleCloseMs: 100, backgroundHoldMaxMs: 60_000, interruptGraceMs: 400 },
    });
    const t = h;
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    await t.waitFor("session.exited");
    expect(t.of("driver.error")).toEqual([]);
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "idle" });
    await t.driver.send(s.id, user(2, "二"));
    const ended = await t.waitFor("turn.ended", undefined, 2);
    // 新进程的名单是空的：空闲按 idleCloseMs 关，不是 60 秒兜底；也没有“后台任务被结束”的说明（关的时候名单是空的）
    const exited = await t.waitFor("session.exited", undefined, 2);
    expect(exited.at - ended.at).toBeLessThan(2000);
    expect(t.stdinTexts()).toEqual(["一", "二"]);
  });
});

describe("每个会话自己的兜底（LaunchFiles.backgroundHoldMaxMs，Worker 用）", () => {
  it("给了就按它关，不按驱动层的默认", async () => {
    const t = harness([{ steps: [{ backgroundTasks: ["stuck"] }, { text: "放后台了" }] }], { ...timers, backgroundHoldMaxMs: 60_000 });
    t.launch.backgroundHoldMaxMs = 400;
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    const ended = await t.waitFor("turn.ended");
    const exited = await t.waitFor("session.exited");
    expect(exited).toMatchObject({ reason: "idle" });
    expect(exited.at - ended.at).toBeGreaterThanOrEqual(400 - 60);
    expect(exited.at - ended.at).toBeLessThan(5000);
  });
});

describe("空闲、只剩后台任务时停止：关掉进程（后台任务一起停）", () => {
  it("session.exited 是 interrupt；下一条消息前说明后台任务因为停止被结束了，只一次", async () => {
    const t = harness([{ steps: [{ backgroundTasks: [{ task_id: "ci", description: "等 CI" }] }, { text: "放后台了" }] }, { steps: [{ text: "二" }] }, { steps: [{ text: "三" }] }], {
      idleCloseMs: 60_000,
      backgroundHoldMaxMs: 60_000,
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    await t.driver.interrupt(s.id);
    const exited = await t.waitFor("session.exited");
    expect(exited).toMatchObject({ reason: "interrupt", messageIds: [] });
    expect(t.driver.isRunning(s.id)).toBe(false);
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    await t.driver.send(s.id, user(3, "三"));
    await t.waitFor("turn.ended", undefined, 3);
    expect(t.stdinTexts()).toEqual(["一", `${backgroundTasksKilledNote("stopped", ["等 CI"])}\n\n二`, "三"]);
  });

  it("空闲、没有后台任务：停止什么也不做", async () => {
    const t = harness([{ steps: [{ text: "好" }] }], { idleCloseMs: 60_000, backgroundHoldMaxMs: 60_000 });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    await t.driver.interrupt(s.id);
    await realSleep(100);
    expect(t.of("session.exited")).toEqual([]);
    expect(t.driver.isRunning(s.id)).toBe(true);
  });
});

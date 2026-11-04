// 驱动层 M2：m2-plan 第 4 节“W3 驱动层 + 提示词 + 假 claude”测试表里驱动层的那几条，外加第 6 节第 4 条的进程组。
// 提示词那几条在 src/daemon/prompt.test.ts，假 claude 自己的在 test/fake-claude/fake-claude.test.ts。
import { ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DriverError, RELAUNCH_NOTE, type AgentSessionPatch } from "../../shared/index.ts";
import { FAKE_CLAUDE, makeHarness, realSleep, slowTurn, waitUntil, type Harness } from "./test-helpers.ts";

let h: Harness | undefined;
/** 测试里起的、要在最后确保结束的进程号。 */
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

/** 最多等 ms 毫秒，看它是不是不在了（被杀的孙进程由 launchd 收尸，要一小会儿）。 */
async function goneWithin(pid: number, ms = 10_000): Promise<boolean> {
  return waitUntil("process to be gone", () => (alive(pid) ? undefined : true), ms).catch(() => false);
}

/** 等假 claude 记下它起的睡眠子进程。 */
async function childPid(t: Harness): Promise<number> {
  const pid = await waitUntil("fake claude to spawn its child", () => {
    const e = t.log().find((x) => x.kind === "child");
    return e?.kind === "child" ? e.childPid : undefined;
  });
  leftovers.push(pid);
  return pid;
}

/** 等假 claude 起来：它记下命令行的同一个同步段里就装好了 SIGINT 处理，所以这之后再发 SIGINT 才是被“处理”而不是被默认动作杀掉。 */
const fakeClaudeStarted = (t: Harness, count = 1) =>
  waitUntil("fake claude to start", () => (t.argvs().length >= count ? true : undefined));

/** 包住 store.update：第一个满足 pred 的 patch 写进去之后调一次 fn（只调一次）。 */
function onPatch(t: Harness, pred: (p: AgentSessionPatch) => boolean, fn: () => void): void {
  const update = t.store.update.bind(t.store);
  let fired = false;
  t.store.update = (id, patch) => {
    const row = update(id, patch);
    if (!fired && pred(patch)) {
      fired = true;
      fn();
    }
    return row;
  };
}

/** 下一个带 pid（不是 null）的 patch 之后调 fn：进程刚 spawn 好，还没往里写东西。 */
const onFirstPid = (t: Harness, fn: () => void) => onPatch(t, (p) => p.pid !== undefined && p.pid !== null, fn);

const kinds = (t: Harness) => t.log().map((e) => `${e.kind}:${e.pid}`);
const pids = (t: Harness) => [...new Set(t.log().flatMap((e) => (e.kind === "argv" ? [e.pid] : [])))];
const signals = (t: Harness) => t.log().flatMap((e) => (e.kind === "signal" ? [e.signal] : []));

describe("每次启动的环境变量", () => {
  it("LaunchFiles.env 进到 claude 的环境里：HUB_TOKEN、HUB_SOCK，PATH 整个换成给的（给的目录在最前面）", async () => {
    const t = harness();
    const path = `${join(t.dir, "run", "bin")}:${process.env.PATH}`;
    t.launch.env = { HUB_TOKEN: "token-a", HUB_SOCK: "/private/tmp/hub.sock", PATH: path };
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    const [env] = t.envs(s.id);
    expect(env).toMatchObject({ HUB_TOKEN: "token-a", HUB_SOCK: "/private/tmp/hub.sock", PATH: path });
    expect(env!.PATH!.split(":")[0]).toBe(join(t.dir, "run", "bin"));
  });

  it("每个会话用自己的：两个会话的令牌不串", async () => {
    const t = harness();
    const a = t.addSession();
    const b = t.addSession();
    t.launch.perSession.set(a.id, { env: { HUB_TOKEN: "token-a" } });
    t.launch.perSession.set(b.id, { env: { HUB_TOKEN: "token-b" } });
    await Promise.all([t.driver.send(a.id, user(1, "a")), t.driver.send(b.id, user(2, "b"))]);
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.envs(a.id).map((e) => e.HUB_TOKEN)).toEqual(["token-a"]);
    expect(t.envs(b.id).map((e) => e.HUB_TOKEN)).toEqual(["token-b"]);
  });

  it("合并顺序：守护进程的环境 < DriverOptions.env < LaunchFiles.env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-hub-driver-"));
    try {
      const fake = { FAKE_CLAUDE_LOG: join(dir, "fake-claude.log"), FAKE_CLAUDE_SCRIPT: join(dir, "script.json"), FAKE_CLAUDE_STATE: dir };
      const t = harness({ dir, driver: { env: { ...fake, CLAUDE_CONFIG_DIR: "/shared", HUB_SOCK: "/from-driver" } } });
      t.launch.env = { HUB_SOCK: "/from-launch" };
      const s = t.addSession();
      await t.driver.send(s.id, user(1, "hi"));
      await t.waitFor("turn.ended");
      expect(t.envs(s.id)[0]).toMatchObject({ CLAUDE_CONFIG_DIR: "/shared", HUB_SOCK: "/from-launch" });
      await t.cleanup();
      h = undefined;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("空闲退出后再起：还是同一个会话的令牌（prepareLaunch 给什么就用什么）", async () => {
    const t = harness({ driver: { idleCloseMs: 50 } });
    t.launch.env = { HUB_TOKEN: "token-a" };
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("session.exited");
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.envs(s.id).map((e) => e.HUB_TOKEN)).toEqual(["token-a", "token-a"]);
  });
});

describe("设置文件", () => {
  it("prepareLaunch 给了 settingsFile：参数里有 --settings <文件>", async () => {
    const t = harness();
    t.launch.settings = true;
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const [argv] = t.argvs();
    expect(argv![argv!.indexOf("--settings") + 1]).toBe(join(t.dir, "launch", String(s.id), "settings.json"));
  });

  it("没给：参数里没有 --settings", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    expect(t.argvs()[0]).not.toContain("--settings");
  });
});

describe("两轮之间重启", () => {
  it("一轮结束后 fingerprint 变了：先关标准输入、等它退出，再 --resume 起新的，然后才写这条（前面拼 RELAUNCH_NOTE）", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    t.launch.fingerprint = "v2";
    await expect(t.driver.send(s.id, user(2, "二"))).resolves.toEqual({ kind: "written" });
    await t.waitFor("turn.ended", undefined, 2);

    const [first, second] = pids(t);
    expect(second).toBeDefined();
    // 旧进程：标准输入关了、退出了，之后新进程才起来，新进程才收到“二”
    const order = kinds(t);
    expect(order.indexOf(`stdin_closed:${first}`)).toBeLessThan(order.indexOf(`exit:${first}`));
    expect(order.indexOf(`exit:${first}`)).toBeLessThan(order.indexOf(`argv:${second}`));
    expect(t.argvs()[1]).toContain("--resume");
    expect(t.argvs()[1]![t.argvs()[1]!.indexOf("--resume") + 1]).toBe(s.vendorSessionId);
    expect(t.stdinTexts()).toEqual(["一", `${RELAUNCH_NOTE}\n\n二`]);
    // 旧进程按空闲关闭退出，不带消息；消息不丢、不重复
    expect(t.of("session.exited")).toEqual([expect.objectContaining({ reason: "idle", messageIds: [], hadResult: true })]);
    expect(t.of("message.delivered").map((e) => e.messageIds)).toEqual([[1], [2]]);
    expect(t.of("turn.ended").map((e) => [e.messageIds, e.ok])).toEqual([
      [[1], true],
      [[2], true],
    ]);
    expect(t.of("session.started").map((e) => e.resumed)).toEqual([false, true]);
    // 重启用的是比较时调的那次 prepareLaunch：一共两次（第一次启动、写“二”之前），不调第三次
    expect(t.prepareCalls.get(s.id)).toBe(2);
    expect(t.store.get(s.id)).toMatchObject({ status: "running", pid: second });
  });

  it.each([
    ["addDirs", (t: Harness, id: number) => t.store.set(id, { addDirs: ["/tmp/agent-hub-extra"] }), ["--add-dir", "/tmp/agent-hub-extra"]],
    ["model", (t: Harness, id: number) => t.store.set(id, { model: "opus" }), ["--model", "opus"]],
  ] as const)("会话那一行的 %s 变了：也重启，新参数带上", async (_name, change, expected) => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    change(t, s.id);
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(pids(t)).toHaveLength(2);
    const argv = t.argvs()[1]!;
    expect(argv[argv.indexOf(expected[0]) + 1]).toBe(expected[1]);
    expect(t.stdinTexts()[1]).toBe(`${RELAUNCH_NOTE}\n\n二`);
  });

  it("会话那一行的 cwd 变了：也重启，新进程在新目录里", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    const cwd = join(t.dir, "elsewhere");
    mkdirSync(cwd);
    t.store.set(s.id, { cwd });
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    const argvEntries = t.log().filter((e) => e.kind === "argv");
    expect(argvEntries).toHaveLength(2);
    expect(argvEntries[1]!.kind === "argv" && argvEntries[1]!.cwd).toContain("elsewhere");
  });

  it("只有 env 变了：不重启", async () => {
    const t = harness();
    t.launch.env = { HUB_TOKEN: "a" };
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    t.launch.env = { HUB_TOKEN: "b" };
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(pids(t)).toHaveLength(1);
  });

  it("重启期间又来一条：排队，重启后下一轮照常写，不再重启", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    t.launch.fingerprint = "v2";
    const second = t.driver.send(s.id, user(2, "二"));
    // 系统消息不和用户的拼，单独一轮，看得出它是在重启之后的下一轮写的
    const third = await t.driver.send(s.id, { messageIds: [3], source: "system", text: "【系统】三" });
    expect(third).toEqual({ kind: "queued" });
    await expect(second).resolves.toEqual({ kind: "written" });
    await t.waitFor("turn.ended", undefined, 3);
    expect(pids(t)).toHaveLength(2);
    // “三”不带 RELAUNCH_NOTE：只有重启后第一条带
    expect(t.stdinTexts()).toEqual(["一", `${RELAUNCH_NOTE}\n\n二`, "【系统】三"]);
  });

  it("比较时 prepareLaunch 出错：不重启，照旧写进现在的进程，留一条 internal_error", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    t.launch.fail = true;
    await expect(t.driver.send(s.id, user(2, "二"))).resolves.toEqual({ kind: "written" });
    await t.waitFor("turn.ended", undefined, 2);
    expect(pids(t)).toHaveLength(1);
    expect(t.stdinTexts()).toEqual(["一", "二"]);
    expect(t.of("driver.error")).toEqual([expect.objectContaining({ code: "internal_error" })]);
  });

  it("重启时新进程起不来：抛可重试的错，消息没写；修好后再发照常写，RELAUNCH_NOTE 还在", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    t.launch.fingerprint = "v2";
    t.store.set(s.id, { cwd: join(t.dir, "does-not-exist") });
    await expect(t.driver.send(s.id, user(2, "二"))).rejects.toMatchObject({ code: "spawn_failed", retryable: true });
    expect(t.of("message.delivered").map((e) => e.messageIds)).toEqual([[1]]);
    t.store.set(s.id, { cwd: s.cwd });
    await expect(t.driver.send(s.id, user(2, "二"))).resolves.toEqual({ kind: "written" });
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.stdinTexts()).toEqual(["一", `${RELAUNCH_NOTE}\n\n二`]);
  });
});

describe("没变不重启", () => {
  it("fingerprint 不变连发两轮：同一个进程，第二条不带 RELAUNCH_NOTE", async () => {
    const t = harness();
    t.launch.fingerprint = "same";
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(pids(t)).toHaveLength(1);
    expect(t.stdinTexts()).toEqual(["一", "二"]);
    expect(t.of("session.exited")).toEqual([]);
  });

  it("init 报回来的模型只放在 session.started 里，不写会话那一行：不算变了", async () => {
    const t = harness({ script: { model: "claude-test-model" } });
    const s = t.addSession({ model: null });
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    expect(t.of("session.started")[0]).toMatchObject({ model: "claude-test-model" });
    expect(t.store.get(s.id)?.model).toBeNull();
    expect(t.store.patches.some((p) => "model" in p.patch)).toBe(false);
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(pids(t)).toHaveLength(1);
  });
});

describe("model 那一列只是配置的模型", () => {
  it("配置成别名 opus：跑一轮后那一列还是 opus，重启时传的仍是 --model opus", async () => {
    const t = harness({ script: { model: "claude-opus-5-5" } });
    const s = t.addSession({ model: "opus" });
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    expect(t.of("session.started")[0]).toMatchObject({ model: "claude-opus-5-5" });
    expect(t.store.get(s.id)?.model).toBe("opus");
    t.launch.fingerprint = "v2";
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    const argvs = t.argvs();
    expect(argvs).toHaveLength(2);
    for (const argv of argvs) expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
    expect(t.store.get(s.id)?.model).toBe("opus");
  });

  it("spawn 到 init 之间改了模型：改动不丢，下一轮之前按新模型重启", async () => {
    const t = harness({ script: { model: "claude-opus-5-5" } });
    const s = t.addSession({ model: "opus" });
    onFirstPid(t, () => t.store.set(s.id, { model: "sonnet" }));
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    expect(t.store.get(s.id)?.model).toBe("sonnet");
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(pids(t)).toHaveLength(2);
    const argv = t.argvs()[1]!;
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(t.stdinTexts()).toEqual(["一", `${RELAUNCH_NOTE}\n\n二`]);
  });
});

describe("忙时变了", () => {
  it("一轮中 fingerprint 变了：这一轮不打断，结束后再重启，再写排着的那条", async () => {
    const t = harness({ script: { turns: [slowTurn(600, "一的回复")] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("message.processing");
    t.launch.fingerprint = "v2";
    await expect(t.driver.send(s.id, user(2, "二"))).resolves.toEqual({ kind: "queued" });
    await t.waitFor("turn.ended", (e) => e.messageIds[0] === 2);
    expect(t.of("turn.ended")[0]).toMatchObject({ messageIds: [1], ok: true, interrupted: false });
    expect(signals(t)).toEqual([]);
    expect(t.log().filter((e) => e.kind === "stdin" && JSON.parse(e.line).type === "control_request")).toEqual([]);
    expect(pids(t)).toHaveLength(2);
    expect(t.stdinTexts()).toEqual(["一", `${RELAUNCH_NOTE}\n\n二`]);
    expect(t.argvs()[1]).toContain("--resume");
  });
});

describe("结束会话", () => {
  it("一轮中调 end：之后的 send 马上抛 session_ended，不排队；等 result 后关标准输入，状态 ended", async () => {
    const t = harness({ script: { turns: [slowTurn(600)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await expect(t.driver.send(s.id, user(2, "排着的"))).resolves.toEqual({ kind: "queued" });
    await t.waitFor("message.processing");
    // turn.ended 出来的那一刻，标准输入还没关
    let closedBeforeTurnEnded: boolean | undefined;
    t.driver.onEvent((_id, e) => {
      if (e.type === "turn.ended") closedBeforeTurnEnded = t.log().some((x) => x.kind === "stdin_closed");
    });
    let ended = false;
    const ending = t.driver.end(s.id).then(() => (ended = true));
    const error = await t.driver.send(s.id, user(3, "end 之后")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriverError);
    expect(error).toMatchObject({ code: "session_ended", retryable: false });
    expect(ended).toBe(false);
    await expect(t.driver.start(s.id)).rejects.toMatchObject({ code: "session_ended" });
    await ending;
    // 这一轮正常回完，没打断
    expect(t.of("turn.ended")).toEqual([expect.objectContaining({ messageIds: [1], ok: true, interrupted: false })]);
    expect(signals(t)).toEqual([]);
    expect(t.log().some((e) => e.kind === "stdin_closed")).toBe(true);
    expect(closedBeforeTurnEnded).toBe(false);
    expect(t.of("session.exited")).toEqual([expect.objectContaining({ reason: "idle", messageIds: [] })]);
    // 待发队列里的丢掉，没写
    expect(t.stdinTexts()).toEqual(["一"]);
    expect(t.store.get(s.id)).toMatchObject({ status: "ended", pid: null });
    // 再 end 直接 resolve；再 send 还是 session_ended
    await t.driver.end(s.id);
    await expect(t.driver.send(s.id, user(4, "x"))).rejects.toMatchObject({ code: "session_ended" });
    expect(pids(t)).toHaveLength(1);
  });

  it("end 同步地标“正在结束”：和 send 在同一个同步段里也拒绝", async () => {
    const t = harness();
    const s = t.addSession();
    const ending = t.driver.end(s.id);
    const sending = t.driver.send(s.id, user(1, "hi"));
    await expect(sending).rejects.toMatchObject({ code: "session_ended" });
    await ending;
    expect(t.argvs()).toEqual([]);
  });

  it("send 刚开始起进程（还在 prepareLaunch）就 end：不起进程，这次 send 抛 session_ended，消息没写", async () => {
    const t = harness();
    const s = t.addSession();
    const sending = t.driver.send(s.id, user(1, "一"));
    const ending = t.driver.end(s.id);
    await expect(sending).rejects.toMatchObject({ code: "session_ended" });
    await ending;
    expect(t.argvs()).toEqual([]);
    expect(t.of("message.delivered")).toEqual([]);
    expect(t.store.get(s.id)).toMatchObject({ status: "ended", pid: null });
  });
});

describe("end 撞上起进程、崩溃、重启", () => {
  it("首次启动：spawn 之后、写消息之前 end：send 抛 session_ended，什么都没写进进程", async () => {
    const t = harness();
    const s = t.addSession();
    let ending: Promise<void> | undefined;
    onFirstPid(t, () => (ending = t.driver.end(s.id)));
    await expect(t.driver.send(s.id, user(1, "一"))).rejects.toMatchObject({ code: "session_ended" });
    await ending;
    expect(t.argvs()).toHaveLength(1);
    expect(t.stdinTexts()).toEqual([]);
    expect(t.of("message.delivered")).toEqual([]);
    expect(t.store.get(s.id)).toMatchObject({ status: "ended", pid: null });
  });

  it("两轮之间重启：新进程 spawn 之后、写消息之前 end：send 抛 session_ended，新进程什么都没收到", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    t.launch.fingerprint = "v2";
    let ending: Promise<void> | undefined;
    onFirstPid(t, () => (ending = t.driver.end(s.id)));
    await expect(t.driver.send(s.id, user(2, "二"))).rejects.toMatchObject({ code: "session_ended" });
    await ending;
    expect(pids(t)).toHaveLength(2);
    expect(t.stdinTexts()).toEqual(["一"]);
    expect(t.of("message.delivered").map((e) => e.messageIds)).toEqual([[1]]);
    expect(t.store.get(s.id)).toMatchObject({ status: "ended", pid: null });
  });

  it("两轮之间重启：旧进程刚退出就 end：send 抛 session_ended，不起新进程", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    t.launch.fingerprint = "v2";
    let ending: Promise<void> | undefined;
    onPatch(t, (p) => p.pid === null, () => (ending = t.driver.end(s.id)));
    await expect(t.driver.send(s.id, user(2, "二"))).rejects.toMatchObject({ code: "session_ended" });
    await ending;
    expect(pids(t)).toHaveLength(1);
    expect(t.stdinTexts()).toEqual(["一"]);
    expect(t.store.get(s.id)).toMatchObject({ status: "ended", pid: null });
  });

  it("start() 只起进程、正在起的时候 end：start 抛 session_ended，进程被关掉，最后 ended", async () => {
    const t = harness({ driver: { idleCloseMs: 50 } });
    const s = t.addSession();
    let ending: Promise<void> | undefined;
    onFirstPid(t, () => (ending = t.driver.end(s.id)));
    await expect(t.driver.start(s.id)).rejects.toMatchObject({ code: "session_ended" });
    await ending;
    expect(t.of("session.exited")).toEqual([expect.objectContaining({ reason: "idle", messageIds: [] })]);
    expect(t.stdinTexts()).toEqual([]);
    await realSleep(150);
    expect(t.store.get(s.id)).toMatchObject({ status: "ended", pid: null });
    expect(t.of("session.exited")).toHaveLength(1);
  });

  it("一轮中 end，这一轮进程崩溃：end 照样完成（ended），不重启，崩溃那一轮的消息随 session.exited(crash) 带出", async () => {
    const t = harness({ script: { turns: [{ steps: [{ sleepMs: 300 }, { exit: 1 }] }] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("message.processing");
    await t.driver.end(s.id);
    expect(t.of("session.exited")).toEqual([expect.objectContaining({ reason: "crash", messageIds: [1], hadResult: false })]);
    expect(t.of("turn.ended")).toEqual([]);
    expect(pids(t)).toHaveLength(1);
    expect(t.store.get(s.id)).toMatchObject({ status: "ended", pid: null });
    await expect(t.driver.send(s.id, user(2, "二"))).rejects.toMatchObject({ code: "session_ended" });
  });
});

describe("关机撞上起进程", () => {
  it("两轮之间重启：新进程 spawn 之后、写消息之前关机：send 抛可重试的错，新进程什么都没收到", async () => {
    // 关机先发的那一下 SIGINT 吞掉：新进程还活着，真写了东西它就会记下来；宽限期到了再按进程组 SIGKILL
    const realKill = ChildProcess.prototype.kill;
    const spy = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess, sig?: NodeJS.Signals | number) {
      return sig === "SIGINT" ? true : realKill.call(this, sig);
    });
    try {
      // 宽限期要长过新进程启动（node 加载假 claude）的时间：到点按进程组 SIGKILL 时它得已经记下了命令行，下面才数得到第二个进程。
      // 机器忙时启动要一两秒，所以不能是几百毫秒
      const t = harness({ driver: { shutdownGraceMs: 4_000 } });
      const s = t.addSession();
      await t.driver.send(s.id, user(1, "一"));
      await t.waitFor("turn.ended");
      t.launch.fingerprint = "v2";
      let stopping: Promise<void> | undefined;
      onFirstPid(t, () => (stopping = t.driver.shutdown()));
      await expect(t.driver.send(s.id, user(2, "二"))).rejects.toMatchObject({ code: "spawn_failed", retryable: true });
      await stopping;
      expect(pids(t)).toHaveLength(2);
      expect(t.stdinTexts()).toEqual(["一"]);
      expect(t.of("message.delivered").map((e) => e.messageIds)).toEqual([[1]]);
      expect(t.store.get(s.id)?.pid).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("#spawn 等 spawn 事件的这段时间里关机：按进程组 SIGKILL 刚起的进程", async () => {
    const kills: Array<[number, string | number | undefined]> = [];
    const realKill = process.kill.bind(process);
    const spy = vi.spyOn(process, "kill").mockImplementation((pid: number, sig?: string | number) => {
      kills.push([pid, sig]);
      return realKill(pid, sig);
    });
    try {
      let driverRef: Harness["driver"] | undefined;
      const t = harness({
        driver: {
          prepareLaunch: async (session) => {
            const dir = join(h!.dir, "launch", String(session.id));
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "prompt.md"), "你是项目经理。");
            writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
            return {
              promptFile: join(dir, "prompt.md"),
              mcpConfigFile: join(dir, "mcp.json"),
              fingerprint: "",
              // 拼环境变量（spawn 之前）时排一个 nextTick 关机：它在 spawn 事件之前跑
              get env() {
                process.nextTick(() => void driverRef!.shutdown());
                return {};
              },
            };
          },
        },
      });
      driverRef = t.driver;
      const s = t.addSession();
      await expect(t.driver.send(s.id, user(1, "一"))).rejects.toMatchObject({ code: "spawn_failed" });
      expect(kills.some(([pid, sig]) => pid < 0 && sig === "SIGKILL")).toBe(true);
      expect(t.store.get(s.id)?.pid ?? null).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("孤儿子进程", () => {
  it("end 之后：剧本起的睡眠子进程也不在了（确认 claude 退出后给它原来的进程组补一个 SIGTERM）", async () => {
    const t = harness({ script: { turns: [{ steps: [{ spawnChild: { sleepSec: 30 } }, { text: "ok" }] }] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const child = await childPid(t);
    await t.waitFor("turn.ended");
    expect(alive(child)).toBe(true);
    await t.driver.end(s.id);
    expect(await goneWithin(child)).toBe(true);
    expect(signals(t)).toEqual([]);
  });

  it("两轮之间重启之后：旧进程起的睡眠子进程也不在了", async () => {
    const t = harness({ script: { turns: [{ steps: [{ spawnChild: { sleepSec: 30 } }, { text: "ok" }] }] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    const child = await childPid(t);
    await t.waitFor("turn.ended");
    t.launch.fingerprint = "v2";
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(await goneWithin(child)).toBe(true);
  });

  it("空闲关闭之后：睡眠子进程也不在了", async () => {
    const t = harness({ driver: { idleCloseMs: 50 }, script: { turns: [{ steps: [{ spawnChild: { sleepSec: 30 } }, { text: "ok" }] }] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const child = await childPid(t);
    await t.waitFor("session.exited");
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "idle", signal: null });
    expect(await goneWithin(child)).toBe(true);
  });
});

describe("空闲退出、崩溃后重新起进程", () => {
  it("空闲退出后设置变了再发：照常起新进程，不加 RELAUNCH_NOTE", async () => {
    const t = harness({ driver: { idleCloseMs: 50 } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("session.exited");
    t.launch.fingerprint = "v2";
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.stdinTexts()).toEqual(["一", "二"]);
  });
});

describe("会话日志的权限", () => {
  it("logs/ 和 logs/sessions/ 是 0700，会话日志文件是 0600", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(join(t.dir, "logs"))).toBe(0o700);
    expect(mode(join(t.dir, "logs", "sessions"))).toBe(0o700);
    expect(mode(join(t.dir, "logs", "sessions", `${s.id}.jsonl`))).toBe(0o600);
  });
});

describe("结束没在跑的", () => {
  it("没有进程的会话调 end：直接 ended，不启动进程，不出事件", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.end(s.id);
    expect(t.argvs()).toEqual([]);
    expect(t.events).toEqual([]);
    expect(t.store.get(s.id)).toMatchObject({ status: "ended", pid: null });
    expect(t.prepareCalls.get(s.id)).toBeUndefined();
  });

  it("进程空闲着：关标准输入、等它退出（session.exited idle），然后 ended", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    await t.driver.end(s.id);
    expect(t.of("session.exited")).toEqual([expect.objectContaining({ reason: "idle", messageIds: [] })]);
    expect(t.store.get(s.id)).toMatchObject({ status: "ended", pid: null });
    expect(signals(t)).toEqual([]);
  });

  it("库里已经是 ended 的会话（上次守护进程结束的）：send、start 抛 session_ended，不调 prepareLaunch；end 直接 resolve", async () => {
    const t = harness();
    const s = t.addSession({ status: "ended" });
    await expect(t.driver.send(s.id, user(1, "hi"))).rejects.toMatchObject({ code: "session_ended" });
    await expect(t.driver.start(s.id)).rejects.toMatchObject({ code: "session_ended" });
    await t.driver.end(s.id);
    expect(t.prepareCalls.get(s.id)).toBeUndefined();
    expect(t.argvs()).toEqual([]);
  });

  it("prepareLaunch 抛 DriverError(session_ended)（令牌已作废）：原样抛出，不包成可重试的 spawn_failed；不起进程", async () => {
    const t = harness({
      driver: {
        prepareLaunch: async (session) => {
          throw new DriverError("session_ended", `session ${session.id} token was revoked`);
        },
      },
    });
    const s = t.addSession();
    await expect(t.driver.send(s.id, user(1, "hi"))).rejects.toMatchObject({ code: "session_ended", retryable: false });
    await expect(t.driver.start(s.id)).rejects.toMatchObject({ code: "session_ended", retryable: false });
    expect(t.argvs()).toEqual([]);
  });

  it("空闲关闭的定时器不会在 ended 之后把状态改回 idle", async () => {
    const t = harness({ driver: { idleCloseMs: 50 } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    await t.driver.end(s.id);
    await realSleep(150);
    expect(t.store.get(s.id)).toMatchObject({ status: "ended" });
    expect(t.of("session.exited")).toHaveLength(1);
  });
});

describe("同时跑", () => {
  it("三个会话同时发：三个进程同时在跑，事件各归各的会话", async () => {
    const t = harness({ script: { defaultTurn: { steps: [{ sleepMs: 2_000 }, { text: "回复" }] } } });
    const sessions = [t.addSession(), t.addSession(), t.addSession()];
    await Promise.all(sessions.map((s, i) => t.driver.send(s.id, user(100 + i, `第 ${i} 个`))));
    await t.waitFor("turn.ended", undefined, 3);
    expect(pids(t)).toHaveLength(3);
    // 三个都起来了，第一个才结束：同时在跑
    const firstEnd = t.events.findIndex((e) => e.event.type === "turn.ended");
    expect(t.events.slice(0, firstEnd).filter((e) => e.event.type === "session.started")).toHaveLength(3);
    sessions.forEach((s, i) => {
      const mine = t.events.filter((e) => e.sessionId === s.id).map((e) => e.event);
      expect(mine.filter((e) => e.type === "turn.ended")).toEqual([expect.objectContaining({ messageIds: [100 + i], ok: true })]);
      expect(mine.filter((e) => e.type === "message.delivered")).toEqual([expect.objectContaining({ messageIds: [100 + i] })]);
      expect(mine.filter((e) => e.type === "agent.text")).toHaveLength(1);
      expect(t.envs(s.id)).toHaveLength(1);
    });
  });
});

describe("假 claude 跑命令", () => {
  it("剧本 { bash: \"echo hi\" }：驱动层出一个 agent.tool（Bash），命令拿到这个会话的 HUB_TOKEN", async () => {
    const t = harness({ script: { turns: [{ steps: [{ bash: "echo hi" }, { bash: 'echo "$HUB_TOKEN"' }, { text: "跑完了" }] }] } });
    t.launch.env = { HUB_TOKEN: "token-for-bash" };
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "跑一下"));
    await t.waitFor("turn.ended");
    expect(t.of("agent.tool")).toEqual([
      expect.objectContaining({ name: "Bash", input: { command: "echo hi" } }),
      expect.objectContaining({ name: "Bash", input: { command: 'echo "$HUB_TOKEN"' } }),
    ]);
    expect(t.log().flatMap((e) => (e.kind === "bash" ? [e.output] : []))).toEqual(["hi", "token-for-bash"]);
    expect(t.of("agent.text").map((e) => e.text)).toEqual(["跑完了"]);
  });
});

describe("进程组", () => {
  it("关机超时强制结束：整个进程组 SIGKILL，claude 起的睡眠子进程也不在了", async () => {
    const t = harness({
      driver: { shutdownGraceMs: 200 },
      script: { ignoreSigint: true, turns: [{ steps: [{ spawnChild: { sleepSec: 30 } }, { sleepMs: 30_000 }] }] },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const child = await childPid(t);
    expect(alive(child)).toBe(true);
    await t.driver.shutdown();
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "shutdown", signal: "SIGKILL" });
    expect(await goneWithin(child)).toBe(true);
  });

  it("启动超时强制结束：也按进程组", async () => {
    // 启动超时要长过假 claude 起子进程的时间，不然子进程还没起来就被超时杀了（机器忙时 node 加载假 claude 要一两秒）
    const t = harness({ driver: { startTimeoutMs: 8_000 }, script: { noInit: true, spawnChildOnStart: 30 } });
    const s = t.addSession();
    const sending = t.driver.send(s.id, user(1, "hi")).catch((e: unknown) => e);
    const child = await childPid(t);
    expect(alive(child)).toBe(true);
    expect(await sending).toMatchObject({ code: "start_timeout" });
    expect(await goneWithin(child)).toBe(true);
  });

  it("空闲关闭升级到 SIGKILL：也按进程组", async () => {
    const t = harness({
      driver: { idleCloseMs: 50, interruptGraceMs: 150 },
      script: { ignoreStdinEnd: true, ignoreSigint: true, turns: [{ steps: [{ spawnChild: { sleepSec: 30 } }, { text: "ok" }] }] },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const child = await childPid(t);
    await t.waitFor("session.exited");
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "idle", signal: "SIGKILL" });
    expect(await goneWithin(child)).toBe(true);
  });

  it("正常停止仍然只给 claude 本身发 SIGINT：子进程不受这一下影响", async () => {
    const t = harness({ script: { turns: [{ steps: [{ spawnChild: { sleepSec: 30 } }, { sleepMs: 30_000 }] }] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const child = await childPid(t);
    await t.driver.shutdown();
    expect(signals(t)).toEqual(["SIGINT"]);
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "shutdown", signal: null, exitCode: 0 });
    await realSleep(100);
    expect(alive(child)).toBe(true);
  });

  it("claude 在自己的进程组里（detached）：进程组号就是它自己的 pid", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const pid = t.store.get(s.id)!.pid!;
    const pgid = await psField(pid, "pgid");
    expect(pgid).toBe(String(pid));
  });

  describe("cleanupStale", () => {
    const strayClaude = (t: Harness, sessionId: string, detached: boolean): ChildProcess => {
      const child = spawn(FAKE_CLAUDE, ["-p", "--session-id", sessionId], {
        env: { ...process.env, FAKE_CLAUDE_LOG: join(t.dir, "fake-claude.log"), FAKE_CLAUDE_SCRIPT: join(t.dir, "script.json"), FAKE_CLAUDE_STATE: t.dir },
        stdio: ["pipe", "ignore", "ignore"],
        detached,
      });
      if (child.pid) leftovers.push(child.pid);
      return child;
    };
    const line = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";

    it("核对过命令行、进程组是它自己的：SIGINT 不退就给整个进程组 SIGKILL，子进程也不在了", async () => {
      const t = harness({
        driver: { interruptGraceMs: 200 },
        script: { ignoreSigint: true, turns: [{ steps: [{ spawnChild: { sleepSec: 30 } }, { sleepMs: 30_000 }] }] },
      });
      const s = t.addSession({ status: "running" });
      const stray = strayClaude(t, s.vendorSessionId, true);
      stray.stdin!.write(line("hi"));
      const child = await childPid(t);
      t.store.update(s.id, { pid: stray.pid! });
      await t.driver.cleanupStale();
      expect(signals(t)).toEqual(["SIGINT"]);
      expect(await goneWithin(stray.pid!)).toBe(true);
      expect(await goneWithin(child)).toBe(true);
      expect(t.store.get(s.id)).toMatchObject({ pid: null, status: "idle" });
    });

    it("不是进程组长（不是我们 detached 起的）：只杀它本身，不按进程组（免得杀到同组的别的进程）", async () => {
      const t = harness({ driver: { interruptGraceMs: 200 }, script: { ignoreSigint: true } });
      const s = t.addSession({ status: "running" });
      const stray = strayClaude(t, s.vendorSessionId, false);
      await fakeClaudeStarted(t);
      t.store.update(s.id, { pid: stray.pid! });
      await t.driver.cleanupStale();
      expect(await goneWithin(stray.pid!)).toBe(true);
      // 测试进程自己（和它同组）还活着，能走到这一行就说明没被按组杀
      expect(stray.signalCode).toBe("SIGKILL");
    });

    it("pid 指到别的会话的 claude（比如别的数据目录的守护进程起的，或进程号被复用）：不碰它，只把这一行的 pid 置空", async () => {
      const t = harness({ script: { ignoreSigint: true } });
      const s = t.addSession({ status: "running" });
      const other = strayClaude(t, "another-daemon-session", true);
      other.stdin!.write(line("hi"));
      await fakeClaudeStarted(t);
      expect(t.argvs()).toHaveLength(1);
      t.store.update(s.id, { pid: other.pid! });
      await t.driver.cleanupStale();
      expect(alive(other.pid!)).toBe(true);
      expect(signals(t)).toEqual([]);
      expect(t.store.get(s.id)).toMatchObject({ pid: null, status: "idle" });
    });

    it("已经 ended 的那一行：pid 置空，状态保持 ended", async () => {
      const t = harness();
      const s = t.addSession({ status: "ended", pid: 999_999 });
      await t.driver.cleanupStale();
      expect(t.store.get(s.id)).toMatchObject({ pid: null, status: "ended" });
    });
  });
});

function psField(pid: number, field: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn("ps", ["-o", `${field}=`, "-p", String(pid)]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("error", reject);
    ps.on("close", () => resolve(out.trim()));
  });
}

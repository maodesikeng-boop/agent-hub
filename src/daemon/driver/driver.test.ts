// 驱动层 + 假 claude：m1-plan 第 4 节“W2 驱动层 + 假 claude”测试表，每条一个 describe。
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CRASH_RECOVERY_NOTE,
  DriverError,
  IDLE_CLOSE_MS,
  INTERRUPT_GRACE_MS,
  RESEND_NOTE,
  RESTART_RECOVERY_NOTE,
  START_TIMEOUT_MS,
} from "../../shared/index.ts";
import { FAKE_CLAUDE, makeHarness, realSleep, slowTurn, type Harness } from "./test-helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await h?.cleanup();
  h = undefined;
});

function harness(...args: Parameters<typeof makeHarness>): Harness {
  h = makeHarness(...args);
  return h;
}

const user = (id: number, text: string) => ({ messageIds: [id], source: "user" as const, text });
const system = (id: number, text: string) => ({ messageIds: [id], source: "system" as const, text });
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

describe("首次启动参数", () => {
  it("新会话第一条用 --session-id 预先生成的 ID，带齐 stream-json 那几个参数，没有 --resume", async () => {
    const t = harness();
    const s = t.addSession({ addDirs: ["/tmp/extra-a"], model: "haiku" });
    await expect(t.driver.send(s.id, user(1, "你好"))).resolves.toEqual({ kind: "written" });
    const [argv] = t.argvs();
    expect(argv).toBeDefined();
    const pairs = (name: string) => argv![argv!.indexOf(name) + 1];
    expect(argv).toContain("-p");
    expect(pairs("--input-format")).toBe("stream-json");
    expect(pairs("--output-format")).toBe("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv).toContain("--replay-user-messages");
    expect(pairs("--session-id")).toBe(s.vendorSessionId);
    expect(argv).not.toContain("--resume");
    expect(pairs("--model")).toBe("haiku");
    expect(pairs("--add-dir")).toBe("/tmp/extra-a");
    expect(pairs("--append-system-prompt-file")).toMatch(/prompt\.md$/);
    expect(argv).not.toContain("--strict-mcp-config");
    expect(argv).not.toContain("--mcp-config");
    expect(argv).not.toContain("--bare");
    // 工作目录是会话的 cwd
    const entry = t.log().find((e) => e.kind === "argv");
    expect(entry?.kind === "argv" && entry.cwd).toContain(join("pm-home", String(s.id)));
    await t.waitFor("turn.ended");
    expect(t.store.get(s.id)?.hasCompletedTurn).toBe(true);
  });

  it("找不到 claude 程序：send 抛可重试的 DriverError(claude_not_found)", async () => {
    const t = harness({ driver: { executablePath: "/nonexistent/claude" } });
    const s = t.addSession();
    const err = await t.driver.send(s.id, user(1, "hi")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe("claude_not_found");
    expect((err as DriverError).retryable).toBe(true);
    expect(t.of("message.delivered")).toEqual([]);
  });

  it("prepareLaunch 出错：抛 DriverError(spawn_failed)", async () => {
    const t = harness({
      driver: {
        prepareLaunch: async () => {
          throw new Error("disk full");
        },
      },
    });
    const s = t.addSession();
    await expect(t.driver.send(s.id, user(1, "hi"))).rejects.toMatchObject({ code: "spawn_failed" });
  });
});

describe("之后用 --resume", () => {
  it("跑完一轮、进程退出后再发：用 --resume 同一个 ID", async () => {
    const t = harness({ driver: { idleCloseMs: 50 } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "第一条"));
    await t.waitFor("session.exited");
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "idle", exitCode: 0, hadResult: true, messageIds: [] });
    await t.driver.send(s.id, user(2, "第二条"));
    await t.waitFor("turn.ended", undefined, 2);
    const argvs = t.argvs();
    expect(argvs).toHaveLength(2);
    expect(argvs[1]![argvs[1]!.indexOf("--resume") + 1]).toBe(s.vendorSessionId);
    expect(argvs[1]).not.toContain("--session-id");
    expect(t.of("session.started").map((e) => e.resumed)).toEqual([false, true]);
  });
});

describe("一轮正常", () => {
  it("依次出 session.started、message.delivered、message.processing、agent.text、turn.ended(ok)", async () => {
    const t = harness({ script: { defaultTurn: { steps: [{ text: "我是项目经理" }] } } });
    const s = t.addSession();
    await t.driver.send(s.id, user(7, "介绍一下你自己"));
    await t.waitFor("turn.ended");
    const types = t.events.map((e) => e.event.type).filter((x) => x !== "rate_limit");
    expect(types).toEqual(["session.started", "message.delivered", "message.processing", "agent.text", "turn.ended"]);
    expect(t.events.every((e) => e.sessionId === s.id)).toBe(true);
    expect(t.of("session.started")[0]).toMatchObject({ resumed: false, model: "claude-haiku-5-5" });
    expect(t.of("session.started")[0]!.tools).toContain("Bash");
    expect(t.of("message.delivered")[0]!.messageIds).toEqual([7]);
    expect(t.of("message.processing")[0]!.messageIds).toEqual([7]);
    expect(t.of("agent.text")[0]).toMatchObject({ text: "我是项目经理" });
    expect(t.of("agent.text")[0]!.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.of("turn.ended")[0]).toMatchObject({ ok: true, interrupted: false, messageIds: [7] });
    expect(t.of("turn.ended")[0]!.error).toBeUndefined();
    expect(t.stdinTexts()).toEqual(["介绍一下你自己"]);
    const row = t.store.get(s.id)!;
    expect(row).toMatchObject({ status: "running", hasCompletedTurn: true, model: null });
    expect(row.pid).toBeGreaterThan(0);
    expect(row.lastEventAt).not.toBeNull();
  });

  it("同样的 messageIds 写进去之后再 send：返回 written，不重复写", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    await expect(t.driver.send(s.id, user(1, "hi"))).resolves.toEqual({ kind: "written" });
    await realSleep(100);
    expect(t.stdinTexts()).toEqual(["hi"]);
  });

  it("result 出错：turn.ended(ok=false) 带 error 的 subtype 和原因", async () => {
    const t = harness({
      script: { defaultTurn: { result: { subtype: "error_max_turns", isError: true, result: "too many turns" } } },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({ ok: false, interrupted: false, error: { subtype: "error_max_turns", message: "too many turns" } });
  });

  it("assistant 事件没有 uuid：用 line:<原始行 sha256 前 32 位>", async () => {
    const t = harness({ script: { defaultTurn: { steps: [{ text: "无 uuid", noUuid: true }] } } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const text = await t.waitFor("agent.text");
    expect(text.uuid).toMatch(/^line:[0-9a-f]{32}$/);
  });
});

describe("工具调用", () => {
  it("剧本里一次工具调用和结果：出一个 agent.tool", async () => {
    const t = harness({
      script: {
        defaultTurn: { steps: [{ tool: { name: "Bash", input: { command: "pnpm test" }, result: "ok" } }, { text: "测完了" }] },
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "跑测试"));
    await t.waitFor("turn.ended");
    const tools = t.of("agent.tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "Bash", input: { command: "pnpm test" } });
    expect(tools[0]!.toolUseId).toMatch(/^toolu_/);
    expect(tools[0]!.uuid).toBeTruthy();
    // 工具结果那一行不算回显，不会再出 message.processing
    expect(t.of("message.processing")).toHaveLength(1);
    expect(t.of("agent.text").map((e) => e.text)).toEqual(["测完了"]);
  });
});

describe("一次只写一条", () => {
  it("忙时连发两条：result 前只写第一条；之后拼成一行，以“【用户连发了 2 条】”开头", async () => {
    const t = harness({ script: { turns: [slowTurn(600)] } });
    const s = t.addSession();
    await expect(t.driver.send(s.id, user(1, "写篇文章"))).resolves.toEqual({ kind: "written" });
    await expect(t.driver.send(s.id, user(2, "补充一"))).resolves.toEqual({ kind: "queued" });
    await expect(t.driver.send(s.id, user(3, "补充二"))).resolves.toEqual({ kind: "queued" });
    // 同样的 messageIds 再调不会重复排队
    await expect(t.driver.send(s.id, user(2, "补充一"))).resolves.toEqual({ kind: "queued" });
    await realSleep(200);
    expect(t.stdinTexts()).toEqual(["写篇文章"]);
    expect(t.of("message.delivered").map((e) => e.messageIds)).toEqual([[1]]);

    await t.waitFor("turn.ended", undefined, 2);
    const texts = t.stdinTexts();
    expect(texts).toHaveLength(2);
    expect(texts[1]).toMatch(/^【用户连发了 2 条】/);
    expect(texts[1]).toContain("1. 补充一");
    expect(texts[1]).toContain("2. 补充二");
    expect(texts[1]!.split("补充一")).toHaveLength(2);
    expect(t.of("message.delivered").map((e) => e.messageIds)).toEqual([[1], [2, 3]]);
    expect(t.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], [2, 3]]);
    // 写进去之后，执行器再调就是 written
    await expect(t.driver.send(s.id, user(2, "补充一"))).resolves.toEqual({ kind: "written" });
    await expect(t.driver.send(s.id, user(3, "补充二"))).resolves.toEqual({ kind: "written" });
    // 一个进程跑完两轮
    expect(t.argvs()).toHaveLength(1);
  });
});

describe("用户在系统前", () => {
  it("忙时先来系统消息再来用户消息：先写用户的，等它的 result 再写系统的，不拼在一起", async () => {
    const t = harness({ script: { turns: [slowTurn(400)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "第一条"));
    await expect(t.driver.send(s.id, system(2, "【工单 #1 汇报】做完了"))).resolves.toEqual({ kind: "queued" });
    await expect(t.driver.send(s.id, user(3, "用户补充"))).resolves.toEqual({ kind: "queued" });
    await t.waitFor("turn.ended", undefined, 3);
    expect(t.stdinTexts()).toEqual(["第一条", "用户补充", "【工单 #1 汇报】做完了"]);
    expect(t.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], [3], [2]]);
  });

  it("系统、用户交错排队：用户的全部拼成一条先写，系统的按到达顺序一条一轮", async () => {
    const t = harness({ script: { turns: [slowTurn(500)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "第一条"));
    await t.driver.send(s.id, system(2, "系统甲"));
    await t.driver.send(s.id, user(3, "用户一"));
    await t.driver.send(s.id, system(4, "系统乙"));
    await t.driver.send(s.id, user(5, "用户二"));
    await t.waitFor("turn.ended", undefined, 4);
    const texts = t.stdinTexts();
    expect(texts[0]).toBe("第一条");
    expect(t.stdinBlocks()[1]).toEqual(["【用户连发了 2 条】", "1. 用户一", "2. 用户二"]);
    expect(texts.slice(2)).toEqual(["系统甲", "系统乙"]);
    expect(t.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], [3, 5], [2], [4]]);
  });

  it("忙时连发两条系统消息：一条一轮，不拼", async () => {
    const t = harness({ script: { turns: [slowTurn(300)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "第一条"));
    await t.driver.send(s.id, system(2, "系统一"));
    await t.driver.send(s.id, system(3, "系统二"));
    await t.waitFor("turn.ended", undefined, 3);
    expect(t.stdinTexts()).toEqual(["第一条", "系统一", "系统二"]);
  });
});

describe("写入前校验", () => {
  it("直接让写入函数写一条 role 不对的：不写，出 driver.error(invalid_input)，进程还在", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    const pid = t.store.get(s.id)!.pid;
    const bad = JSON.stringify({ type: "user", message: { role: "assistant", content: [{ type: "text", text: "x" }] } });
    await expect(t.driver.writeUserLine(s.id, bad, [9])).resolves.toEqual({ kind: "rejected" });
    expect(t.of("driver.error")[0]).toMatchObject({ code: "invalid_input", messageIds: [9] });
    expect(t.of("driver.error")[0]!.message).toMatch(/^invalid_input: /);
    expect(t.of("message.delivered").map((e) => e.messageIds)).toEqual([[1]]);
    // 不是 JSON 的也不写
    await expect(t.driver.writeUserLine(s.id, "not json", [10])).resolves.toEqual({ kind: "rejected" });
    await realSleep(100);
    expect(t.log().filter((e) => e.kind === "stdin")).toHaveLength(1);
    // 进程还在，下一条照常
    await expect(t.driver.send(s.id, user(2, "还在吗"))).resolves.toEqual({ kind: "written" });
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.store.get(s.id)!.pid).toBe(pid);
    expect(t.of("session.exited")).toEqual([]);
  });

  it("空文字：send 返回 rejected", async () => {
    const t = harness();
    const s = t.addSession();
    await expect(t.driver.send(s.id, user(1, ""))).resolves.toEqual({ kind: "rejected" });
    expect(t.of("driver.error")[0]).toMatchObject({ code: "invalid_input", messageIds: [1] });
    expect(t.argvs()).toEqual([]);
  });
});

describe("打断，控制消息管用", () => {
  it("一轮中 interrupt：多一行 control_request；turn.ended(interrupted)；进程还在，下一条照常", async () => {
    const t = harness({ script: { turns: [slowTurn(3_000, "写到一半")] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "写 1500 字"));
    await t.waitFor("message.processing");
    const pid = t.store.get(s.id)!.pid;
    await t.driver.interrupt(s.id);
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({ interrupted: true, messageIds: [1] });
    const control = t
      .log()
      .flatMap((e) => (e.kind === "stdin" ? [JSON.parse(e.line) as Record<string, unknown>] : []))
      .filter((o) => o.type === "control_request");
    expect(control).toHaveLength(1);
    expect(control[0]).toMatchObject({ request: { subtype: "interrupt" } });
    expect(typeof control[0]!.request_id).toBe("string");
    expect(t.log().some((e) => e.kind === "signal")).toBe(false);

    await expect(t.driver.send(s.id, user(2, "你好"))).resolves.toEqual({ kind: "written" });
    const second = await t.waitFor("turn.ended", undefined, 2);
    expect(second).toMatchObject({ ok: true, interrupted: false, messageIds: [2] });
    expect(t.store.get(s.id)!.pid).toBe(pid);
    expect(t.argvs()).toHaveLength(1);
    expect(t.of("session.exited")).toEqual([]);
  });

  it("没在跑的会话 interrupt：什么都不做", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.interrupt(s.id);
    expect(t.argvs()).toEqual([]);
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    await t.driver.interrupt(s.id);
    await realSleep(100);
    expect(t.log().filter((e) => e.kind === "stdin")).toHaveLength(1);
  });
});

describe("打断，控制消息没回应", () => {
  it("剧本不理控制消息：5 秒后收到 SIGINT；session.exited(interrupt)；下一条用 --resume", async () => {
    const t = harness({ script: { ignoreControl: true, turns: [{ steps: [{ text: "先说一句" }] }, slowTurn(30_000)] } });
    const s = t.addSession();
    fakeTimers();
    await t.driver.send(s.id, user(1, "第一轮"));
    await t.waitFor("turn.ended");
    await t.driver.send(s.id, user(2, "写很久"));
    await t.waitFor("message.processing", undefined, 2);
    const interrupting = t.driver.interrupt(s.id);
    await realSleep(100);
    vi.advanceTimersByTime(INTERRUPT_GRACE_MS - 1);
    await realSleep(200);
    expect(t.log().some((e) => e.kind === "signal")).toBe(false);
    vi.advanceTimersByTime(1);
    const exited = await t.waitFor("session.exited");
    await interrupting;
    expect(exited).toMatchObject({ reason: "interrupt", exitCode: 0 });
    expect(t.log().filter((e) => e.kind === "signal").map((e) => e.kind === "signal" && e.signal)).toEqual(["SIGINT"]);
    // SIGINT 时假 claude（和真 claude 一样）先出打断标记和 result，所以这一轮按“已停止”收尾
    expect(t.of("turn.ended")[1]).toMatchObject({ interrupted: true, messageIds: [2] });
    expect(t.store.get(s.id)).toMatchObject({ status: "idle", pid: null });
    vi.useRealTimers();

    await t.driver.send(s.id, user(3, "接着聊"));
    await t.waitFor("turn.ended", undefined, 3);
    const argvs = t.argvs();
    expect(argvs).toHaveLength(2);
    expect(argvs[1]![argvs[1]!.indexOf("--resume") + 1]).toBe(s.vendorSessionId);
  });
});

describe("崩溃", () => {
  it("一轮中途退出码 1：session.exited(crash, hadResult:false)；下一条用 --resume，开头带恢复说明", async () => {
    const t = harness({ script: { turns: [{ steps: [{ text: "ok" }] }, { steps: [{ text: "写了一半" }, { exit: 1 }] }] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "第一轮"));
    await t.waitFor("turn.ended");
    await t.driver.send(s.id, user(2, "第二轮"));
    const exited = await t.waitFor("session.exited");
    expect(exited).toMatchObject({ reason: "crash", exitCode: 1, hadResult: false, messageIds: [2] });
    expect(t.store.get(s.id)).toMatchObject({ status: "idle", pid: null });

    await expect(t.driver.send(s.id, user(3, "还在吗"))).resolves.toEqual({ kind: "written" });
    await t.waitFor("turn.ended", undefined, 2);
    const argvs = t.argvs();
    expect(argvs[1]![argvs[1]!.indexOf("--resume") + 1]).toBe(s.vendorSessionId);
    const texts = t.stdinTexts();
    expect(texts[2]).toBe(`${CRASH_RECOVERY_NOTE}\n\n还在吗`);
    // 恢复说明只加一次
    await t.driver.send(s.id, user(4, "再来一条"));
    await t.waitFor("turn.ended", undefined, 3);
    expect(t.stdinTexts()[3]).toBe("再来一条");
  });
});

describe("启动卡住", () => {
  it("剧本不发 init：60 秒后结束进程，send 抛 DriverError(start_timeout)", async () => {
    const t = harness({ script: { noInit: true } });
    const s = t.addSession();
    fakeTimers();
    const sending = t.driver.send(s.id, user(1, "hi")).catch((e: unknown) => e);
    // 等假 claude 起来、收到这一行
    for (let i = 0; i < 50 && !t.log().some((e) => e.kind === "stdin"); i++) await realSleep(50);
    vi.advanceTimersByTime(START_TIMEOUT_MS - 1);
    await realSleep(100);
    expect(t.of("session.exited")).toEqual([]);
    vi.advanceTimersByTime(1);
    const err = await sending;
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({ code: "start_timeout", retryable: true });
    const exited = await t.waitFor("session.exited");
    // 这次失败由抛出的错误交给执行器，在途消息不在 session.exited 里，免得账本提前标失败
    expect(exited).toMatchObject({ reason: "startup_failed", hadResult: false, messageIds: [] });
    expect(t.of("message.delivered")).toEqual([]);
    expect(t.store.get(s.id)).toMatchObject({ status: "idle", pid: null });
    // 可重试的错误不出 driver.error 事件（driver.ts 的约定）
    expect(t.of("driver.error")).toEqual([]);
  });

  it("没等到 init 就退出了：抛 DriverError(spawn_failed)，带上退出码和标准错误", async () => {
    const t = harness();
    const bin = writeExecutableNodeScript(join(t.dir, "broken-claude"), 'process.stderr.write("boom\\n"); process.exit(2);\n');
    const t2 = makeHarness({ dir: t.dir, driver: { executablePath: bin } });
    try {
      const s = t2.addSession();
      const err = await t2.driver.send(s.id, user(1, "hi")).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "spawn_failed", retryable: true });
      expect((err as Error).message).toContain("boom");
      expect((err as Error).message).toContain("2");
      expect(t2.of("session.exited")[0]).toMatchObject({ reason: "startup_failed", exitCode: 2, messageIds: [] });
    } finally {
      await t2.driver.shutdown();
    }
  });
});

describe("参数选错", () => {
  it("会话其实已存在、却用了 --session-id：报 already in use，自动改用 --resume 重试一次并成功", async () => {
    const t = harness({ driver: { idleCloseMs: 50 } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "第一轮"));
    await t.waitFor("session.exited");
    // 账本里的“跑完过一轮”丢了
    t.store.update(s.id, { hasCompletedTurn: false });
    await expect(t.driver.send(s.id, user(2, "第二轮"))).resolves.toEqual({ kind: "written" });
    await t.waitFor("turn.ended", undefined, 2);
    const argvs = t.argvs();
    expect(argvs).toHaveLength(3);
    expect(argvs[1]).toContain("--session-id");
    expect(argvs[2]![argvs[2]!.indexOf("--resume") + 1]).toBe(s.vendorSessionId);
    expect(t.stdinTexts().at(-1)).toBe("第二轮");
    expect(t.store.get(s.id)!.hasCompletedTurn).toBe(true);
    // 失败的那次启动不算会话退出给账本看的在途消息
    expect(t.of("session.exited").map((e) => e.reason)).toEqual(["idle", "startup_failed"]);
    expect(t.of("session.exited")[1]!.messageIds).toEqual([]);
    expect(t.of("message.delivered").map((e) => e.messageIds)).toEqual([[1], [2]]);
  });

  it("反过来：以为跑完过、用了 --resume，报 No conversation found，自动改用 --session-id 并成功", async () => {
    const t = harness({ driver: { idleCloseMs: 50 } });
    const s = t.addSession({ hasCompletedTurn: true });
    await expect(t.driver.send(s.id, user(1, "hi"))).resolves.toEqual({ kind: "written" });
    // 等重试的那个进程跑完一轮、空闲退出，再看一共出了几个 turn.ended
    await t.waitFor("session.exited", (e) => e.reason === "idle");
    const argvs = t.argvs();
    expect(argvs).toHaveLength(2);
    expect(argvs[0]).toContain("--resume");
    expect(argvs[1]![argvs[1]!.indexOf("--session-id") + 1]).toBe(s.vendorSessionId);
    // No conversation found 时那条 result 是启动错误，不当一轮结束
    expect(t.of("turn.ended")).toHaveLength(1);
    expect(t.of("session.started")[0]).toMatchObject({ resumed: false });
  });

  it("换了参数还是不行：抛 DriverError(start_args_conflict)", async () => {
    const t = harness({ script: { rejectSessionArgs: true } });
    const s = t.addSession();
    await expect(t.driver.send(s.id, user(1, "hi"))).rejects.toMatchObject({ code: "start_args_conflict", retryable: true });
    expect(t.argvs()).toHaveLength(2);
    expect(t.of("message.delivered")).toEqual([]);
  });
});

describe("空闲关闭", () => {
  it("一轮结束后拨 10 分钟：关掉标准输入，进程正常退出，会话状态“空闲”", async () => {
    const t = harness();
    const s = t.addSession();
    fakeTimers();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    vi.advanceTimersByTime(IDLE_CLOSE_MS - 1);
    await realSleep(150);
    expect(t.log().some((e) => e.kind === "stdin_closed")).toBe(false);
    expect(t.store.get(s.id)!.status).toBe("running");
    vi.advanceTimersByTime(1);
    const exited = await t.waitFor("session.exited");
    expect(exited).toMatchObject({ reason: "idle", exitCode: 0, signal: null, hadResult: true, messageIds: [] });
    expect(t.log().some((e) => e.kind === "stdin_closed")).toBe(true);
    expect(t.log().some((e) => e.kind === "signal")).toBe(false);
    expect(t.store.get(s.id)).toMatchObject({ status: "idle", pid: null });
  });

  it("排着队的时候不关", async () => {
    const t = harness({ driver: { idleCloseMs: 100 }, script: { turns: [slowTurn(300), slowTurn(300)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.of("session.exited")).toEqual([]);
    await t.waitFor("session.exited");
  });
});

describe("额度信息", () => {
  it("剧本发 rate_limit_event：出 rate_limit，带各窗口的 utilization、resetsAt", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const ev = await t.waitFor("rate_limit");
    expect(ev.info).toEqual({
      status: "allowed",
      resetsAt: 1793619600,
      windows: {
        five_hour: { utilization: 0.37, resetsAt: 1793619600, status: "allowed" },
        seven_day: { utilization: 0.59, resetsAt: 1793646000, status: "allowed" },
      },
    });
    expect(t.store.get(s.id)!.rateLimit).toEqual(ev.info);
  });

  it("同一轮里重置前、后两条事件：每条都出 rate_limit、都写库，库里最后是重置后的新窗口（utilization 0、新 resetsAt）", async () => {
    const win = (utilization: number, resetsAt: number, status = "allowed") => ({ utilization, resetsAt, status });
    const before = { status: "allowed_warning", resetsAt: 1793773800, rateLimitType: "five_hour", unifiedWindows: { five_hour: win(0.99, 1793773800, "allowed_warning"), seven_day: win(0.31, 1794250800) } };
    const after = { status: "allowed", resetsAt: 1793791800, rateLimitType: "five_hour", unifiedWindows: { five_hour: win(0, 1793791800), seven_day: win(0.31, 1794250800) } };
    const t = harness({ script: { defaultTurn: { rateLimit: false, steps: [{ rateLimit: before }, { rateLimit: after }, { text: "ok" }] } } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    const seen = t.of("rate_limit").map((e) => e.info.windows.five_hour);
    expect(seen).toEqual([win(0.99, 1793773800, "allowed_warning"), win(0, 1793791800)]);
    expect(t.store.get(s.id)!.rateLimit?.windows.five_hour).toEqual(win(0, 1793791800));
    expect(t.store.get(s.id)!.rateLimit?.windows.seven_day).toEqual(win(0.31, 1794250800));
  });

  it("额度用完的状态原样带出来", async () => {
    const t = harness({
      script: {
        defaultTurn: {
          rateLimit: { status: "rejected", resetsAt: 1793620000, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1793620000, status: "rejected" } } },
        },
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const ev = await t.waitFor("rate_limit");
    expect(ev.info.status).toBe("rejected");
    expect(ev.info.windows.five_hour!.utilization).toBe(1);
  });
});

describe("坏的输出行", () => {
  it("剧本输出一行不是 JSON 的：记一条错误，跳过，后面的事件照常", async () => {
    const t = harness({ script: { defaultTurn: { steps: [{ raw: "this is not json" }, { text: "后面的" }] } } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const ended = await t.waitFor("turn.ended");
    expect(ended.ok).toBe(true);
    const errors = t.of("driver.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "bad_output_line" });
    expect(errors[0]!.message).toMatch(/^bad_output_line: /);
    expect(errors[0]!.messageIds).toBeUndefined();
    expect(t.of("agent.text").map((e) => e.text)).toEqual(["后面的"]);
  });
});

describe("不写原始日志", () => {
  it("跑完一轮：数据目录和临时目录里都没有 .jsonl，也没有 logs/sessions/", async () => {
    const t = harness({ script: { defaultTurn: { steps: [{ text: "hi" }, { raw: "oops" }] } } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    const files = readdirSync(t.dir, { recursive: true }).map(String);
    expect(files.filter((f) => f.endsWith(".jsonl") || f.includes(join("logs", "sessions")))).toEqual([]);
  });
});

describe("恢复和重发", () => {
  it("send(recovery)：恢复说明、重发说明和消息写在同一行，这一轮对应这条消息（不单独占一轮）", async () => {
    const t = harness({ driver: { idleCloseMs: 50 } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("session.exited");
    await expect(t.driver.send(s.id, { ...user(5, "之前那条"), resend: true, recovery: true })).resolves.toEqual({ kind: "written" });
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.stdinTexts()).toEqual(["hi", `${RESTART_RECOVERY_NOTE}\n\n${RESEND_NOTE}\n\n之前那条`]);
    expect(t.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], [5]]);
  });

  it("send(recovery) 只给它之后写进去的第一行加恢复说明；后面再重发的不加", async () => {
    const t = harness({ script: { turns: [slowTurn(200)] } });
    const s = t.addSession({ hasCompletedTurn: false });
    await t.driver.send(s.id, { ...user(5, "第一条"), resend: true, recovery: true });
    await expect(t.driver.send(s.id, { ...system(6, "【Worker #1 · X 的汇报】好了"), resend: true })).resolves.toEqual({ kind: "queued" });
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.stdinTexts()).toEqual([`${RESTART_RECOVERY_NOTE}\n\n${RESEND_NOTE}\n\n第一条`, `${RESEND_NOTE}\n\n【Worker #1 · X 的汇报】好了`]);
  });

  it("start 已经在跑的会话：直接返回，不再起进程", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.driver.start(s.id);
    await t.driver.start(s.id);
    expect(t.argvs()).toHaveLength(1);
  });
});

describe("关机", () => {
  it("忙的发 SIGINT、空闲的关标准输入；session.exited(shutdown)；之后 send 抛错", async () => {
    const t = harness({ script: { turns: [{ steps: [{ text: "ok" }] }, slowTurn(30_000)] } });
    const idle = t.addSession();
    const busy = t.addSession();
    await t.driver.send(idle.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    await t.driver.send(busy.id, user(2, "写很久"));
    await t.waitFor("message.processing", (e) => e.messageIds[0] === 2);
    await t.driver.shutdown();
    const exited = t.events.filter((e) => e.event.type === "session.exited");
    expect(exited).toHaveLength(2);
    for (const e of exited) expect(e.event).toMatchObject({ reason: "shutdown" });
    const busyExit = exited.find((e) => e.sessionId === busy.id)!.event;
    expect(busyExit).toMatchObject({ exitCode: 0 });
    const signals = t.log().filter((e) => e.kind === "signal");
    expect(signals).toHaveLength(1);
    expect(t.store.get(idle.id)).toMatchObject({ status: "idle", pid: null });
    expect(t.store.get(busy.id)).toMatchObject({ status: "idle", pid: null });
    await expect(t.driver.send(idle.id, user(3, "hi"))).rejects.toMatchObject({ code: "spawn_failed" });
  });

  it("关机时 SIGINT 结束的那一轮：turn.ended 带 shutdown（账本据此让 Worker 重启后接着做）；用户点停止的不带", async () => {
    const t = harness({ script: { turns: [slowTurn(30_000), slowTurn(30_000)] } });
    const stopped = t.addSession();
    const busy = t.addSession();
    await t.driver.send(stopped.id, user(1, "写很久"));
    await t.waitFor("message.processing", (e) => e.messageIds[0] === 1);
    await t.driver.interrupt(stopped.id);
    await t.driver.send(busy.id, user(2, "写很久"));
    await t.waitFor("message.processing", (e) => e.messageIds[0] === 2);
    await t.driver.shutdown();
    const ended = t.events.filter((e) => e.event.type === "turn.ended");
    const byUser = ended.find((e) => e.sessionId === stopped.id)!.event;
    const byShutdown = ended.find((e) => e.sessionId === busy.id)!.event;
    expect(byUser).toMatchObject({ interrupted: true, messageIds: [1] });
    expect(byUser).not.toHaveProperty("shutdown");
    expect(byShutdown).toMatchObject({ interrupted: true, shutdown: true, messageIds: [2] });
  });

  it("关机时这一轮其实正常做完了（claude 没理 SIGINT）：turn.ended 不带 shutdown，账本照常记回复、发汇报", async () => {
    const t = harness({ driver: { shutdownGraceMs: 1_500 }, script: { ignoreSigint: true, turns: [slowTurn(400)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "写一会儿"));
    await t.waitFor("message.processing", (e) => e.messageIds[0] === 1);
    await t.driver.shutdown();
    const [ended] = t.of("turn.ended");
    expect(ended).toMatchObject({ ok: true, interrupted: false, messageIds: [1] });
    expect(ended).not.toHaveProperty("shutdown");
  });

  it("用户点了停止、控制消息还没回应就关机：仍按停止收尾（turn.ended 不带 shutdown，session.exited(interrupt)）", async () => {
    const t = harness({ script: { ignoreControl: true, turns: [slowTurn(30_000)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "写很久"));
    await t.waitFor("message.processing");
    const interrupting = t.driver.interrupt(s.id);
    await waitStdin(t, 2);
    await t.driver.shutdown();
    await interrupting;
    const [ended] = t.of("turn.ended");
    expect(ended).toMatchObject({ interrupted: true, messageIds: [1] });
    expect(ended).not.toHaveProperty("shutdown");
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "interrupt" });
    expect(signals(t)).toEqual(["SIGINT"]);
  });

  it("停止已经退回 SIGINT、进程还没退就关机：session.exited 仍是 interrupt，不改成 shutdown", async () => {
    const t = harness({
      driver: { interruptGraceMs: 100, shutdownGraceMs: 300 },
      script: { ignoreControl: true, ignoreSigint: true, turns: [slowTurn(30_000)] },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "写很久"));
    await t.waitFor("message.processing");
    void t.driver.interrupt(s.id);
    for (let i = 0; i < 50 && signals(t).length === 0; i++) await realSleep(50);
    expect(signals(t)).toEqual(["SIGINT"]);
    await t.driver.shutdown();
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "interrupt", messageIds: [1] });
  });

  it("不理 SIGINT 的进程：最多等 shutdownGraceMs，然后强制结束", async () => {
    const t = harness({ driver: { shutdownGraceMs: 200 }, script: { noInit: true, ignoreSigint: true } });
    const s = t.addSession();
    void t.driver.send(s.id, user(1, "hi")).catch(() => {});
    for (let i = 0; i < 50 && !t.log().some((e) => e.kind === "stdin"); i++) await realSleep(50);
    const started = Date.now();
    await t.driver.shutdown();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(t.store.get(s.id)).toMatchObject({ pid: null });
    expect(t.log().filter((e) => e.kind === "signal")).toHaveLength(1);
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "shutdown", signal: "SIGKILL" });
  });
});

// --- 审查之后补的 ---

const signals = (t: Harness) => t.log().flatMap((e) => (e.kind === "signal" ? [e.signal] : []));
const controlLines = (t: Harness) =>
  t
    .log()
    .flatMap((e) => (e.kind === "stdin" ? [JSON.parse(e.line) as Record<string, unknown>] : []))
    .filter((o) => o.type === "control_request");
const waitStdin = async (t: Harness, count = 1) => {
  for (let i = 0; i < 100 && t.log().filter((e) => e.kind === "stdin").length < count; i++) await realSleep(50);
};

describe("U+2028 / U+2029", () => {
  it("回复里带这两个字符：只按 \\n 切行，这一轮照常结束", async () => {
    const text = "第一段\u2028第二段\u2029第三段";
    const t = harness({ script: { defaultTurn: { steps: [{ text }] } } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({ ok: true, messageIds: [1] });
    expect(t.of("agent.text").map((e) => e.text)).toEqual([text]);
    expect(t.of("driver.error")).toEqual([]);
  });

  it("用户消息里带这两个字符：写进去时转义，对方收到的是一行、文字不变", async () => {
    const text = "上\u2028下\u2029完";
    const t = harness();
    const s = t.addSession();
    await expect(t.driver.send(s.id, user(1, text))).resolves.toEqual({ kind: "written" });
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({ ok: true, messageIds: [1] });
    const raw = t.log().flatMap((e) => (e.kind === "stdin" ? [e.line] : []));
    expect(raw).toHaveLength(1);
    expect(raw[0]).not.toMatch(/[\u2028\u2029]/);
    expect(t.stdinTexts()).toEqual([text]);
    expect(t.of("session.exited")).toEqual([]);
  });
});

describe("抛错不弄垮驱动层", () => {
  it("监听者抛错：驱动层照常跑完，留下一条 driver.error(internal_error)", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = harness({ driver: { idleCloseMs: 50 } });
      t.driver.onEvent((_id, e) => {
        if (e.type === "turn.ended") throw new Error("listener boom");
      });
      const s = t.addSession();
      await t.driver.send(s.id, user(1, "hi"));
      await t.waitFor("session.exited");
      const errors = t.of("driver.error");
      expect(errors.some((e) => e.code === "internal_error" && e.message.includes("listener boom"))).toBe(true);
      expect(t.store.get(s.id)).toMatchObject({ status: "idle", pid: null });
    } finally {
      quiet.mockRestore();
    }
  });

  it("写库出错：不往上冒，出 driver.error(internal_error)，这一轮照常结束", async () => {
    const t = harness();
    const s = t.addSession();
    const update = t.store.update.bind(t.store);
    t.store.update = (id, patch) => {
      if (patch.rateLimit !== undefined) throw new Error("disk I/O error");
      return update(id, patch);
    };
    await t.driver.send(s.id, user(1, "hi"));
    const ended = await t.waitFor("turn.ended");
    expect(ended.ok).toBe(true);
    expect(t.of("driver.error").find((e) => e.code === "internal_error")!.message).toContain("disk I/O error");
  });

  it("会话那一行没了：退出时写库失败也照样收尾，exited 会 resolve；再 send 抛不可重试的错", async () => {
    const t = harness();
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    t.store.rows.delete(s.id);
    await t.driver.shutdown();
    expect(t.of("session.exited")).toHaveLength(1);
    const t2 = harness();
    const err = await t2.driver.send(999_999, user(2, "hi")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).retryable).toBe(false);
  });
});

describe("打断的回应出错", () => {
  it("control_response 是 error：马上发 SIGINT，不等 5 秒", async () => {
    const t = harness({ script: { control: "error", turns: [slowTurn(30_000)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "写很久"));
    await t.waitFor("message.processing");
    const started = Date.now();
    await t.driver.interrupt(s.id);
    const exited = await t.waitFor("session.exited");
    expect(Date.now() - started).toBeLessThan(INTERRUPT_GRACE_MS - 1_000);
    expect(exited).toMatchObject({ reason: "interrupt" });
    expect(signals(t)).toEqual(["SIGINT"]);
  });

  it("control_response 是 success：清掉定时器，过了宽限期也不发 SIGINT", async () => {
    const t = harness({ driver: { interruptGraceMs: 300 }, script: { control: "ack_only", turns: [slowTurn(1_500)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "写一会儿"));
    await t.waitFor("message.processing");
    await t.driver.interrupt(s.id);
    await realSleep(800);
    expect(signals(t)).toEqual([]);
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({ ok: true, interrupted: false });
    expect(t.of("session.exited")).toEqual([]);
  });

  it("result 比回应先到：清掉定时器，不发 SIGINT", async () => {
    const t = harness({ driver: { interruptGraceMs: 600 }, script: { ignoreControl: true, turns: [slowTurn(300)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("message.processing");
    const interrupting = t.driver.interrupt(s.id);
    await t.waitFor("turn.ended");
    await interrupting;
    await realSleep(900);
    expect(signals(t)).toEqual([]);
    expect(t.of("session.exited")).toEqual([]);
  });

  it("打断撞上自然结束：这一轮算正常结束，晚到的回应不影响下一轮", async () => {
    const t = harness({ driver: { interruptGraceMs: 300 }, script: { controlDelayMs: 400, turns: [slowTurn(100)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("message.processing");
    await t.driver.interrupt(s.id);
    const first = await t.waitFor("turn.ended");
    expect(first).toMatchObject({ ok: true, interrupted: false, messageIds: [1] });
    await realSleep(600); // 回应到了，宽限期也过了
    await t.driver.send(s.id, user(2, "下一条"));
    const second = await t.waitFor("turn.ended", undefined, 2);
    expect(second).toMatchObject({ ok: true, interrupted: false, messageIds: [2] });
    expect(signals(t)).toEqual([]);
  });

  it("重复调 interrupt：只写一条控制消息", async () => {
    const t = harness({ script: { ignoreControl: true, turns: [slowTurn(1_000)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("message.processing");
    const a = t.driver.interrupt(s.id);
    const b = t.driver.interrupt(s.id);
    await Promise.all([a, b]);
    expect(controlLines(t)).toHaveLength(1);
  });

  it("工具调用中被打断：`for tool use` 的标记也算打断", async () => {
    const t = harness({ script: { turns: [{ steps: [{ tool: { name: "Bash", input: { command: "sleep 9" }, durationMs: 3_000 } }] }] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "跑命令"));
    await t.waitFor("agent.tool");
    await t.driver.interrupt(s.id);
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({ interrupted: true, messageIds: [1] });
  });

  it("写进去了、还没回显就被打断：先补一个 message.processing，再 turn.ended", async () => {
    const t = harness({ script: { lateReplay: true, turns: [slowTurn(3_000)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("message.delivered");
    expect(t.of("message.processing")).toEqual([]);
    await t.driver.interrupt(s.id);
    await t.waitFor("turn.ended");
    const types = t.events.map((e) => e.event.type).filter((x) => x === "message.processing" || x === "turn.ended");
    expect(types).toEqual(["message.processing", "turn.ended"]);
    expect(t.of("message.processing")[0]!.messageIds).toEqual([1]);
    expect(t.of("turn.ended")[0]).toMatchObject({ interrupted: true, messageIds: [1] });
  });

  it("启动阶段打断：进程退出算 interrupt，在途消息带上；send 不抛 spawn_failed", async () => {
    const t = harness({ driver: { interruptGraceMs: 200 }, script: { noInit: true, ignoreControl: true } });
    const s = t.addSession();
    const sending = t.driver.send(s.id, user(1, "hi")).catch((e: unknown) => e);
    await waitStdin(t);
    await t.driver.interrupt(s.id);
    const exited = await t.waitFor("session.exited");
    expect(exited).toMatchObject({ reason: "interrupt", messageIds: [1] });
    await expect(sending).resolves.toEqual({ kind: "written" });
    expect(t.of("message.delivered").map((e) => e.messageIds)).toEqual([[1]]);
  });
});

describe("重发不被吞", () => {
  it("崩溃后同样的 messageIds 重发：真的再写一次", async () => {
    const t = harness({ script: { turns: [{ steps: [{ text: "写了一半" }, { exit: 1 }] }] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("session.exited");
    await expect(t.driver.send(s.id, { ...user(1, "hi"), resend: true })).resolves.toEqual({ kind: "written" });
    await t.waitFor("turn.ended");
    expect(t.stdinTexts()).toEqual(["hi", `${CRASH_RECOVERY_NOTE}\n\n${RESEND_NOTE}\n\nhi`]);
  });

  it("这一轮出错（ok=false）后重发：真的再写一次", async () => {
    const t = harness({ script: { turns: [{ result: { subtype: "error_during_execution", isError: true } }] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    await expect(t.driver.send(s.id, { ...user(1, "hi"), resend: true })).resolves.toEqual({ kind: "written" });
    const second = await t.waitFor("turn.ended", undefined, 2);
    expect(second).toMatchObject({ ok: true, messageIds: [1] });
    expect(t.stdinTexts()).toEqual(["hi", `${RESEND_NOTE}\n\nhi`]);
  });

  it("启动中又调一次同样的 send：不重复排队", async () => {
    const t = harness();
    const slow = makeHarness({
      dir: t.dir,
      driver: {
        prepareLaunch: async (session) => {
          await realSleep(300);
          const launch = join(t.dir, "launch-slow", String(session.id));
          mkdirSync(launch, { recursive: true });
          writeFileSync(join(launch, "prompt.md"), "p");
          return { promptFile: join(launch, "prompt.md"), env: {}, fingerprint: "" };
        },
      },
    });
    try {
      const s = slow.addSession();
      const first = slow.driver.send(s.id, user(1, "hi"));
      await realSleep(50);
      await expect(slow.driver.send(s.id, user(1, "hi"))).resolves.toEqual({ kind: "queued" });
      await expect(first).resolves.toEqual({ kind: "written" });
      await slow.waitFor("turn.ended");
      await realSleep(300);
      expect(slow.stdinTexts()).toEqual(["hi"]);
    } finally {
      await slow.driver.shutdown();
    }
  });
});

describe("参数冲突后的持久化", () => {
  it("两次都失败：hasCompletedTurn 不改", async () => {
    const t = harness({ script: { rejectSessionArgs: true } });
    const s = t.addSession({ hasCompletedTurn: false });
    await expect(t.driver.send(s.id, user(1, "hi"))).rejects.toMatchObject({ code: "start_args_conflict" });
    expect(t.store.get(s.id)!.hasCompletedTurn).toBe(false);
    expect(t.store.patches.some((p) => p.patch.hasCompletedTurn !== undefined)).toBe(false);
  });

  it("第二次启动成功后才写：改用 --resume 成功 → true", async () => {
    const t = harness({ driver: { idleCloseMs: 50 } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "第一轮"));
    await t.waitFor("session.exited");
    t.store.update(s.id, { hasCompletedTurn: false });
    const before = t.store.patches.length;
    let atStarted: boolean | undefined;
    t.driver.onEvent((_id, e) => {
      if (e.type === "session.started" && e.resumed) atStarted = t.store.get(s.id)!.hasCompletedTurn;
    });
    await t.driver.send(s.id, user(2, "第二轮"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(atStarted).toBe(true);
    // 失败的那次启动没有写 hasCompletedTurn
    const writes = t.store.patches.slice(before).filter((p) => p.patch.hasCompletedTurn !== undefined);
    expect(writes.map((p) => p.patch.hasCompletedTurn)).toEqual([true]);
  });

  it("只认 “Session ID … is already in use”，别的 already in use 不算参数选错", async () => {
    const t = harness();
    const bin = writeExecutableNodeScript(join(t.dir, "port-claude"), 'process.stderr.write("Error: port 8080 is already in use\\n"); process.exit(1);\n');
    const t2 = makeHarness({ dir: t.dir, driver: { executablePath: bin } });
    try {
      const s = t2.addSession();
      await expect(t2.driver.send(s.id, user(1, "hi"))).rejects.toMatchObject({ code: "spawn_failed" });
      expect(t2.argvs()).toEqual([]);
    } finally {
      await t2.driver.shutdown();
    }
  });
});

describe("启动和关闭的边角", () => {
  it("start 没有消息、一直空闲：空闲关闭算 idle，不算 startup_failed", async () => {
    const t = harness({ driver: { idleCloseMs: 100 } });
    const s = t.addSession();
    await t.driver.start(s.id);
    const exited = await t.waitFor("session.exited");
    expect(exited).toMatchObject({ reason: "idle", exitCode: 0, messageIds: [] });
  });

  it("并发调 start：只起一个进程", async () => {
    const t = harness();
    const s = t.addSession();
    await Promise.all([t.driver.start(s.id), t.driver.start(s.id), t.driver.start(s.id)]);
    for (let i = 0; i < 100 && t.argvs().length === 0; i++) await realSleep(50);
    await realSleep(300);
    expect(t.argvs()).toHaveLength(1);
    expect(t.of("session.exited")).toEqual([]);
  });

  it("send(recovery) 启动失败：恢复说明还回去，下一条写进去时带上", async () => {
    const t = harness({ script: { rejectSessionArgs: true } });
    const s = t.addSession();
    await expect(t.driver.send(s.id, { ...user(9, "先发的"), recovery: true })).rejects.toMatchObject({ code: "start_args_conflict" });
    writeFileSync(join(t.dir, "script.json"), "{}");
    await expect(t.driver.send(s.id, user(1, "hi"))).resolves.toEqual({ kind: "written" });
    await t.waitFor("turn.ended");
    expect(t.stdinTexts().at(-1)).toBe(`${RESTART_RECOVERY_NOTE}\n\nhi`);
  });

  it("进程正在退出时 send：等它退完，再用 --resume 起新的写进去", async () => {
    const t = harness({ driver: { idleCloseMs: 50, interruptGraceMs: 300, shutdownGraceMs: 500 }, script: { ignoreStdinEnd: true } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    for (let i = 0; i < 100 && !t.log().some((e) => e.kind === "stdin_closed"); i++) await realSleep(20);
    await expect(t.driver.send(s.id, user(2, "二"))).resolves.toEqual({ kind: "written" });
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "idle" });
    const argvs = t.argvs();
    expect(argvs).toHaveLength(2);
    expect(argvs[1]).toContain("--resume");
    expect(t.stdinTexts()).toEqual(["一", "二"]);
  });

  it("空闲关闭不理标准输入：先 SIGINT，再 SIGKILL", async () => {
    const t = harness({ driver: { idleCloseMs: 50, interruptGraceMs: 200 }, script: { ignoreStdinEnd: true, ignoreSigint: true } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const exited = await t.waitFor("session.exited");
    expect(exited).toMatchObject({ reason: "idle", signal: "SIGKILL", messageIds: [] });
    expect(signals(t)).toEqual(["SIGINT"]);
  });

  it("孙进程占着标准输出：进程退出后不被拖住", async () => {
    const t = harness({ script: { turns: [{ steps: [{ spawnOrphan: { sleepSec: 30 } }, { exit: 1 }] }] } });
    const s = t.addSession();
    try {
      const started = Date.now();
      await t.driver.send(s.id, user(1, "hi"));
      const exited = await t.waitFor("session.exited");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(exited).toMatchObject({ reason: "crash", exitCode: 1, messageIds: [1] });
    } finally {
      for (const e of t.log()) if (e.kind === "orphan") process.kill(e.orphanPid, "SIGKILL");
    }
  });

  it("关机时队列里还有消息：在途的这一轮按打断收尾，排队的没写、不在任何事件里", async () => {
    const t = harness({ script: { turns: [slowTurn(30_000)] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "写很久"));
    await expect(t.driver.send(s.id, user(2, "排队的"))).resolves.toEqual({ kind: "queued" });
    await t.waitFor("message.processing");
    await t.driver.shutdown();
    // SIGINT 时（和真 claude 一样）先出打断标记和 result，所以在途的那条由 turn.ended 带着
    expect(t.of("turn.ended")).toEqual([expect.objectContaining({ interrupted: true, messageIds: [1] })]);
    expect(t.of("session.exited")).toEqual([expect.objectContaining({ reason: "shutdown", messageIds: [] })]);
    expect(t.stdinTexts()).toEqual(["写很久"]);
    expect(t.of("message.delivered").map((e) => e.messageIds)).toEqual([[1]]);
  });
});

describe("其他输入输出", () => {
  it("messageIds 是空数组：按 invalid_input 拒绝", async () => {
    const t = harness();
    const s = t.addSession();
    await expect(t.driver.send(s.id, { messageIds: [], source: "user", text: "hi" })).resolves.toEqual({ kind: "rejected" });
    expect(t.of("driver.error")[0]).toMatchObject({ code: "invalid_input", messageIds: [] });
    expect(t.argvs()).toEqual([]);
  });

  it("is_error:true 配 subtype:success：算出错", async () => {
    const t = harness({ script: { defaultTurn: { result: { subtype: "success", isError: true, result: "API Error" } } } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({ ok: false, error: { subtype: "success", message: "API Error" } });
  });

  it("残缺的 rate_limit_event：跳过，不出 rate_limit、不写库", async () => {
    const t = harness({
      script: { defaultTurn: { rateLimit: false, steps: [{ raw: JSON.stringify({ type: "rate_limit_event", rate_limit_info: null }) }, { text: "ok" }] } },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    expect(t.of("rate_limit")).toEqual([]);
    expect(t.store.get(s.id)!.rateLimit).toBeNull();
  });

  it("先写库再发事件：监听者读到的那一行已经是新的", async () => {
    const t = harness({ driver: { idleCloseMs: 50 } });
    const s = t.addSession();
    const seen: Record<string, unknown> = {};
    t.driver.onEvent((_id, e) => {
      const row = t.store.get(s.id)!;
      if (e.type === "session.started") seen.started = { status: row.status, hasPid: row.pid !== null, model: row.model };
      if (e.type === "rate_limit") seen.rateLimit = row.rateLimit === null ? null : row.rateLimit.status;
      if (e.type === "turn.ended") seen.turn = row.hasCompletedTurn;
      if (e.type === "session.exited") seen.exited = { status: row.status, pid: row.pid };
    });
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("session.exited");
    expect(seen).toEqual({
      started: { status: "running", hasPid: true, model: null },
      rateLimit: "allowed",
      turn: true,
      exited: { status: "idle", pid: null },
    });
  });
});

describe("清理残留进程", () => {
  const canRunPs = (() => {
    try {
      execFileSync("ps", ["-o", "pid=", "-p", String(process.pid)], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  // 用例失败（cleanupStale 没清掉它）时假 claude 不能留在机器上
  const strays: ChildProcess[] = [];
  afterEach(() => {
    for (const stray of strays.splice(0)) stray.kill("SIGKILL");
  });
  const strayClaude = (t: Harness, sessionId: string) => {
    const stray = spawn(FAKE_CLAUDE, ["-p", "--session-id", sessionId], {
      env: { ...process.env, FAKE_CLAUDE_LOG: join(t.dir, "fake-claude.log"), FAKE_CLAUDE_SCRIPT: join(t.dir, "script.json"), FAKE_CLAUDE_STATE: t.dir },
      stdio: ["pipe", "ignore", "ignore"],
    });
    strays.push(stray);
    return stray;
  };
  const gone = async (child: ChildProcess) => {
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await realSleep(50);
    return child.exitCode !== null || child.signalCode !== null;
  };
  const waitArgv = async (t: Harness) => {
    for (let i = 0; i < 100 && t.argvs().length === 0; i++) await realSleep(50);
  };

  it.runIf(canRunPs)("命令行是 claude 且带着会话 ID：SIGINT 结束，那一行 pid 置空、状态空闲", async () => {
    const t = harness();
    const s = t.addSession({ status: "running" });
    const stray = strayClaude(t, s.vendorSessionId);
    await waitArgv(t);
    t.store.update(s.id, { pid: stray.pid! });
    await t.driver.cleanupStale();
    expect(await gone(stray)).toBe(true);
    expect(signals(t)).toEqual(["SIGINT"]);
    expect(t.store.get(s.id)).toMatchObject({ pid: null, status: "idle" });
  });

  it.runIf(canRunPs)("不理 SIGINT：等一会儿再 SIGKILL", async () => {
    const t = harness({ driver: { interruptGraceMs: 300 }, script: { ignoreSigint: true } });
    const s = t.addSession({ status: "running" });
    const stray = strayClaude(t, s.vendorSessionId);
    await waitArgv(t);
    t.store.update(s.id, { pid: stray.pid! });
    await t.driver.cleanupStale();
    expect(await gone(stray)).toBe(true);
    expect(stray.signalCode).toBe("SIGKILL");
    expect(t.store.get(s.id)).toMatchObject({ pid: null, status: "idle" });
  });

  it("pid 已经被别的进程用了、或者进程不在了：不动它，只把那一行清掉", async () => {
    const t = harness();
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const a = t.addSession({ status: "running", pid: other.pid! });
      const b = t.addSession({ status: "running", pid: 999_999 });
      await t.driver.cleanupStale();
      await realSleep(100);
      expect(other.exitCode).toBeNull();
      expect(other.signalCode).toBeNull();
      expect(t.store.get(a.id)).toMatchObject({ pid: null, status: "idle" });
      expect(t.store.get(b.id)).toMatchObject({ pid: null, status: "idle" });
    } finally {
      other.kill("SIGKILL");
    }
  });
});

describe("token 用量", () => {
  const usage = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
    input_tokens: input,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
  });

  it("一轮结束：累计用 result 的 usage；同一条消息分几个事件推出来不重复算；上下文取最近一条消息的 input + 缓存读 + 缓存写", async () => {
    const t = harness({
      script: {
        defaultTurn: {
          steps: [
            { text: "a", messageId: "msg_1", usage: usage(2, 100, 10, 8) },
            { text: "b", messageId: "msg_1", usage: usage(2, 100, 10, 8) },
            { text: "c", messageId: "msg_2", usage: usage(2, 110, 5, 9) },
          ],
          usage: usage(4, 210, 15, 60),
        },
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    expect(t.store.get(s.id)!.usage).toEqual({ input: 4, cacheRead: 210, cacheWrite: 15, output: 60, context: 117 });
  });

  it("多轮累加，上下文是最近一次的", async () => {
    const t = harness({
      script: {
        turns: [
          { steps: [{ text: "a", usage: usage(1, 1000, 100, 5) }], usage: usage(1, 1000, 100, 50) },
          { steps: [{ text: "b", usage: usage(1, 1200, 20, 5) }], usage: usage(2, 2400, 40, 70) },
        ],
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.store.get(s.id)!.usage).toEqual({ input: 3, cacheRead: 3400, cacheWrite: 140, output: 120, context: 1221 });
  });

  it("重启后接着累计：库里已有的数是起点", async () => {
    const t = harness({ script: { defaultTurn: { steps: [{ text: "a", usage: usage(1, 10, 1, 1) }], usage: usage(1, 10, 1, 7) } } });
    const s = t.addSession({ usage: { input: 100, cacheRead: 5000, cacheWrite: 300, output: 900, context: 4000 } });
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    expect(t.store.get(s.id)!.usage).toEqual({ input: 101, cacheRead: 5010, cacheWrite: 301, output: 907, context: 12 });
  });

  it("子 agent 的消息不算上下文；result 没有 usage 的字段当 0", async () => {
    const t = harness({
      script: {
        defaultTurn: {
          steps: [
            { text: "main", usage: usage(1, 50, 5, 3) },
            { text: "sub", parentToolUseId: "toolu_1", usage: usage(9, 99999, 9, 9) },
          ],
          usage: { input_tokens: 4 },
        },
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    expect(t.store.get(s.id)!.usage).toEqual({ input: 4, cacheRead: 0, cacheWrite: 0, output: 0, context: 56 });
  });

  it("实时：一轮还没结束，每条消息的用量就进了库（同一秒内的合并，到点推最新的）；轮结束用 result 校正", async () => {
    const t = harness({
      script: {
        defaultTurn: {
          steps: [
            { text: "a", messageId: "msg_1", usage: usage(2, 100, 10, 1) },
            { text: "a2", messageId: "msg_1", usage: usage(2, 100, 10, 8) },
            { text: "b", messageId: "msg_2", usage: usage(3, 110, 5, 2) },
            { sleepMs: 2500 },
          ],
          usage: usage(5, 210, 15, 60),
        },
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await vi.waitFor(() => expect(t.store.get(s.id)!.usage.input).toBeGreaterThan(0), { timeout: 3000 });
    // 第一条推出去后一秒内的更新还没推：库里是第一次推的那个数
    expect(t.store.get(s.id)!.usage.input).toBe(2);
    // 到点推最新的：msg_1 取最后一次的 usage（output 8），再加 msg_2
    await vi.waitFor(() => expect(t.store.get(s.id)!.usage).toEqual({ input: 5, cacheRead: 210, cacheWrite: 15, output: 10, context: 118 }), { timeout: 3000 });
    // 轮结束：用 result 校正，output 变准，其他不重复计
    await t.waitFor("turn.ended");
    expect(t.store.get(s.id)!.usage).toEqual({ input: 5, cacheRead: 210, cacheWrite: 15, output: 60, context: 118 });
  });

  it("先写库再发事件：turn.ended 的监听者读到的已经是这一轮的用量", async () => {
    const t = harness({ script: { defaultTurn: { steps: [{ text: "a", usage: usage(1, 2, 3, 4) }], usage: usage(1, 2, 3, 4) } } });
    const s = t.addSession();
    let seen: unknown;
    t.driver.onEvent((id, ev) => {
      if (ev.type === "turn.ended") seen = t.store.get(id)!.usage;
    });
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    expect(seen).toEqual({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4, context: 6 });
  });
});
import { writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";

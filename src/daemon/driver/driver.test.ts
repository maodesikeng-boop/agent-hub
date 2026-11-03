// 驱动层 + 假 claude：m1-plan 第 4 节“W2 驱动层 + 假 claude”测试表，每条一个 describe。
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DriverError,
  IDLE_CLOSE_MS,
  INTERRUPT_GRACE_MS,
  RESEND_NOTE,
  RESTART_RECOVERY_NOTE,
  START_TIMEOUT_MS,
} from "../../shared/index.ts";
import { CRASH_RECOVERY_NOTE } from "./index.ts";
import { makeHarness, realSleep, slowTurn, type Harness } from "./test-helpers.ts";

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
    expect(argv).toContain("--strict-mcp-config");
    expect(pairs("--mcp-config")).toMatch(/mcp\.json$/);
    expect(argv).not.toContain("--bare");
    // 工作目录是会话的 cwd
    const entry = t.log().find((e) => e.kind === "argv");
    expect(entry?.kind === "argv" && entry.cwd).toContain(join("pm-home", String(s.id)));
    await t.waitFor("turn.ended");
    expect(t.store.get(s.id)?.hasCompletedTurn).toBe(true);
  });

  it("找不到 claude 程序：send 抛可重试的 DriverError(claude_not_found)", async () => {
    const t = harness({ driver: { claudePath: "/nonexistent/claude" } });
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
    expect(row).toMatchObject({ status: "running", hasCompletedTurn: true, model: "claude-haiku-5-5" });
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
    const raw = readFileSync(join(t.dir, "logs", "sessions", `${s.id}.jsonl`), "utf8")
      .split("\n")
      .find((l) => l.includes("无 uuid"))!;
    expect(text.uuid).toBe(`line:${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`);
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
    const bin = join(t.dir, "broken-claude");
    writeFileSync(bin, "#!/bin/sh\necho boom >&2\nexit 2\n");
    chmodSync(bin, 0o755);
    const t2 = makeHarness({ dir: t.dir, driver: { claudePath: bin } });
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
    const t = harness();
    const s = t.addSession({ hasCompletedTurn: true });
    await expect(t.driver.send(s.id, user(1, "hi"))).resolves.toEqual({ kind: "written" });
    await t.waitFor("turn.ended");
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

describe("原始日志", () => {
  it("跑完一轮：logs/sessions/<会话>.jsonl 里每个事件一行，原样", async () => {
    const t = harness({ script: { defaultTurn: { steps: [{ text: "hi" }, { raw: "oops" }] } } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    const lines = readFileSync(join(t.dir, "logs", "sessions", `${s.id}.jsonl`), "utf8").split("\n").filter(Boolean);
    expect(lines).toContain("oops");
    const types = lines.filter((l) => l !== "oops").map((l) => (JSON.parse(l) as { type: string; subtype?: string }).type);
    expect(types).toEqual(["system", "user", "assistant", "rate_limit_event", "result"]);
    const init = JSON.parse(lines[0]!) as { subtype: string; session_id: string };
    expect(init).toMatchObject({ subtype: "init", session_id: s.vendorSessionId });
  });
});

describe("恢复和重发", () => {
  it("start(recovery) 且没有待发消息：单独写一条恢复说明，等到 init 才 resolve", async () => {
    const t = harness({ driver: { idleCloseMs: 50 } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("session.exited");
    await t.driver.start(s.id, { recovery: true });
    expect(t.of("session.started")).toHaveLength(2);
    expect(t.stdinTexts()[1]).toBe(RESTART_RECOVERY_NOTE);
    // 单独写的说明不对应任何消息
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.of("turn.ended")[1]!.messageIds).toEqual([]);
    expect(t.of("message.delivered").map((e) => e.messageIds)).toEqual([[1]]);
  });

  it("start(recovery) 后紧接着的消息排在说明后面；重发的消息前面加 RESEND_NOTE", async () => {
    const t = harness({ script: { turns: [slowTurn(200)] } });
    const s = t.addSession({ hasCompletedTurn: false });
    const starting = t.driver.start(s.id, { recovery: true });
    await expect(t.driver.send(s.id, { ...user(5, "之前那条"), resend: true })).resolves.toEqual({ kind: "queued" });
    await starting;
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.stdinTexts()).toEqual([RESTART_RECOVERY_NOTE, `${RESEND_NOTE}\n\n之前那条`]);
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

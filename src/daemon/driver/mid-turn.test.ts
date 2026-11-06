// 一轮中途把消息交给 claude（docs/mid-turn-messages.md 第 5 节）：init 里有 msg_lifecycle_v1、interrupt_cancel_queued_v1 时，
// 忙着也直接写进标准输入（带 uuid），用 command_lifecycle 对账；没有就照旧排在驱动层自己的队列里。假 claude 照真 claude 2.1.314 的行为回。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CRASH_RECOVERY_NOTE, RELAUNCH_NOTE, RESEND_NOTE } from "../../shared/index.ts";
import type { FakeScript, FakeTurn } from "../../../test/fake-claude/fake-claude.ts";
import { makeHarness, realSleep, type Harness } from "./test-helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const CAPS = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"];
const user = (id: number, text: string) => ({ messageIds: [id], source: "user" as const, text });

function harness(turns: FakeTurn[], extra: Partial<FakeScript> = {}, driver: Record<string, number> = {}): Harness {
  h = makeHarness({ script: { capabilities: CAPS, turns, ...extra }, driver });
  return h;
}

/** 放行卡在 waitFile 上的那一步。 */
const release = (t: Harness, name: string) => writeFileSync(join(t.dir, name), "");
const gate = (t: Harness | string, name?: string) => ({ waitFile: join(typeof t === "string" ? t : t.dir, name ?? "go") });

/** 写进去的 user 行（原始 JSON）。 */
function userLines(t: Harness): Array<{ uuid?: string; message: { content: Array<{ text: string }> } }> {
  return t.log().flatMap((e) => {
    if (e.kind !== "stdin") return [];
    const obj = JSON.parse(e.line) as { type: string };
    return obj.type === "user" ? [obj as never] : [];
  });
}

/** 一轮：先说一句，卡在 go 文件上（模拟正在跑的工具），工具跑完（这时取走中途写进来的），再说一句。 */
function toolTurn(dir: string, after = "收到"): FakeTurn {
  return { steps: [{ text: "开始跑" }, gate(dir), { tool: { name: "Bash", input: { command: "sleep 8" }, result: "ONE" } }, { text: after }] };
}

describe("中途写入：当前工具跑完就被同一轮取走", () => {
  it("忙时写进去返回 written(midTurn)、出带 midTurn 的已送达；工具跑完被取走（处理中），一轮一个 turn.ended 带两条", async () => {
    const t = harness([]);
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({ capabilities: CAPS, turns: [toolTurn(t.dir)] }));
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "跑 3 条命令"));
    await t.waitFor("agent.text");
    expect(t.driver.midTurnSupport(s.id)).toMatchObject({ mode: "direct", seenAfter: "tool" });
    await expect(t.driver.send(s.id, user(2, "停下，只跑一条"))).resolves.toEqual({ kind: "written", midTurn: true });
    expect(t.of("message.delivered").map((e) => [e.messageIds, e.midTurn])).toEqual([
      [[1], undefined],
      [[2], true],
    ]);
    expect(t.of("message.processing").map((e) => e.messageIds)).toEqual([[1]]);
    release(t, "go");
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({ ok: true, messageIds: [1, 2] });
    expect(t.of("message.processing").map((e) => e.messageIds)).toEqual([[1], [2]]);
    await realSleep(100);
    expect(t.of("turn.ended")).toHaveLength(1);
    expect(t.of("turn.started")).toEqual([]);
    // 每行都带 uuid，原文单独一行，不拼
    const lines = userLines(t);
    expect(lines.map((l) => l.message.content.map((c) => c.text))).toEqual([["跑 3 条命令"], ["停下，只跑一条"]]);
    expect(lines.every((l) => typeof l.uuid === "string" && l.uuid.length > 0)).toBe(true);
  });

  it("连发两条：各写一行、各自已送达，不拼成“用户连发了 N 条”，同一轮都取走", async () => {
    const t = harness([]);
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({ capabilities: CAPS, turns: [toolTurn(t.dir)] }));
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.text");
    await expect(t.driver.send(s.id, user(2, "再告诉我 2+2"))).resolves.toEqual({ kind: "written", midTurn: true });
    await expect(t.driver.send(s.id, user(3, "最后一句带 PINEAPPLE"))).resolves.toEqual({ kind: "written", midTurn: true });
    release(t, "go");
    expect(await t.waitFor("turn.ended")).toMatchObject({ messageIds: [1, 2, 3] });
    expect(t.stdinTexts()).toEqual(["开始", "再告诉我 2+2", "最后一句带 PINEAPPLE"]);
    expect(t.stdinTexts().some((x) => x.includes("用户连发了"))).toBe(false);
  });

  it("写进去时这一轮只剩文字（没赶上）：claude 另起一轮处理它；中间不当成 claude 自己开的轮、不空闲关、不写别的", async () => {
    const t = harness([], {}, { idleCloseMs: 80 });
    writeFileSync(
      join(t.dir, "script.json"),
      JSON.stringify({ capabilities: CAPS, turns: [{ steps: [gate(t.dir), { text: "写完了" }] }, { steps: [{ sleepMs: 300 }, { text: "ACK" }] }] }),
    );
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "讲个故事"));
    await t.waitFor("message.processing");
    await expect(t.driver.send(s.id, user(2, "最后加一行 ACK"))).resolves.toEqual({ kind: "written", midTurn: true });
    release(t, "go");
    const first = await t.waitFor("turn.ended");
    expect(first.messageIds).toEqual([1]);
    const second = await t.waitFor("turn.ended", () => true, 2);
    expect(second).toMatchObject({ ok: true, messageIds: [2] });
    expect(t.of("turn.started")).toEqual([]);
    expect(t.of("session.exited")).toEqual([]); // 两轮之间（300 ms > idleCloseMs）没被空闲关掉
    expect(t.stdinTexts()).toEqual(["讲个故事", "最后加一行 ACK"]);
    // 第二条的处理中在它那一轮结束之前
    const kinds = t.events.map((e) => e.event).filter((e) => e.type === "message.processing" || e.type === "turn.ended").map((e) => `${e.type}:${e.messageIds.join()}`);
    expect(kinds).toEqual(["message.processing:1", "turn.ended:1", "message.processing:2", "turn.ended:2"]);
    // 都结束了才开始算空闲
    expect(await t.waitFor("session.exited")).toMatchObject({ reason: "idle", messageIds: [] });
  });
});

describe("不支持时退回排队", () => {
  it("init 里没有 msg_lifecycle_v1（老 claude）：忙时照旧排在驱动层的队列里（queued），这一轮结束再拼成一条写", async () => {
    h = makeHarness({ script: { turns: [{ steps: [{ sleepMs: 300 }, { text: "一" }] }, { steps: [{ text: "二" }] }] } });
    const s = h.addSession();
    await h.driver.send(s.id, user(1, "一"));
    await h.waitFor("message.processing");
    expect(h.driver.midTurnSupport(s.id)).toMatchObject({ mode: "none" });
    await expect(h.driver.send(s.id, user(2, "二"))).resolves.toEqual({ kind: "queued" });
    await expect(h.driver.send(s.id, user(3, "三"))).resolves.toEqual({ kind: "queued" });
    await h.waitFor("turn.ended", () => true, 2);
    expect(h.stdinTexts()).toEqual(["一", "【用户连发了 2 条】\n\n1. 二\n\n2. 三"]);
    expect(h.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], [2, 3]]);
  });

  it("有 msg_lifecycle_v1 但没有 interrupt_cancel_queued_v1：停止时取消不了，忙时也排队", async () => {
    h = makeHarness({ script: { capabilities: ["msg_lifecycle_v1"], turns: [{ steps: [{ sleepMs: 300 }, { text: "一" }] }, { steps: [{ text: "二" }] }] } });
    const s = h.addSession();
    await h.driver.send(s.id, user(1, "一"));
    await h.waitFor("message.processing");
    await expect(h.driver.send(s.id, user(2, "二"))).resolves.toEqual({ kind: "queued" });
    await h.waitFor("turn.ended", () => true, 2);
    expect(h.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], [2]]);
  });

  it("命令（/ 开头）忙时照旧排队，不中途写", async () => {
    const t = harness([]);
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({ capabilities: CAPS, turns: [toolTurn(t.dir)], defaultTurn: { steps: [] } }));
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.text");
    await expect(t.driver.send(s.id, user(2, "/compact"))).resolves.toEqual({ kind: "queued" });
    // 前面排着命令：后面的普通消息也排在它后面，不插队
    await expect(t.driver.send(s.id, user(3, "之后再说"))).resolves.toEqual({ kind: "queued" });
    release(t, "go");
    await t.waitFor("turn.ended", () => true, 3);
    expect(t.stdinTexts()).toEqual(["开始", "/compact", "之后再说"]);
  });

  it("点了停止、这一轮还没收尾：新消息排队，不写进正在停的这一轮", async () => {
    const t = harness([], { controlDelayMs: 200 });
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({ capabilities: CAPS, controlDelayMs: 200, turns: [toolTurn(t.dir)], defaultTurn: { steps: [{ text: "好" }] } }));
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.text");
    const stopped = t.driver.interrupt(s.id);
    await expect(t.driver.send(s.id, user(2, "换个做法"))).resolves.toEqual({ kind: "queued" });
    await stopped;
    await t.waitFor("turn.ended", () => true, 2);
    expect(t.of("turn.ended").map((e) => [e.messageIds, e.interrupted])).toEqual([
      [[1], true],
      [[2], false],
    ]);
    expect(t.of("message.cancelled")).toEqual([]);
  });
});

describe("停止：写进去了还没被取走的标已取消，不重发", () => {
  it("interrupt 带 cancel_queued；没取走的出 message.cancelled(stop)，正在处理的那条照旧按打断收尾；之后不再跑", async () => {
    const t = harness([]);
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({ capabilities: CAPS, turns: [toolTurn(t.dir)], defaultTurn: { steps: [{ text: "不该跑" }] } }));
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "跑 3 条命令"));
    await t.waitFor("agent.text");
    await t.driver.send(s.id, user(2, "停下后回 ACK"));
    await t.driver.interrupt(s.id);
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({ messageIds: [1], interrupted: true });
    expect(t.of("message.cancelled")).toEqual([expect.objectContaining({ messageIds: [2], reason: "stop" })]);
    const control = t.log().flatMap((e) => (e.kind === "stdin" && e.line.includes("control_request") ? [JSON.parse(e.line)] : []));
    expect(control).toEqual([expect.objectContaining({ request: { subtype: "interrupt", cancel_queued: true } })]);
    await realSleep(200);
    expect(t.of("turn.ended")).toHaveLength(1);
    expect(t.of("agent.text").map((e) => e.text)).toEqual(["开始跑"]);
    expect(t.of("message.processing").map((e) => e.messageIds)).toEqual([[1]]);
    // 重发（执行器重试）也不会再写
    await expect(t.driver.send(s.id, user(2, "停下后回 ACK"))).resolves.toEqual({ kind: "written" });
    expect(t.stdinTexts()).toEqual(["跑 3 条命令", "停下后回 ACK"]);
  });

  it("工具跑完已经取走的不算取消：停止时标的是这一轮被打断", async () => {
    const t = harness([]);
    const dir = t.dir;
    writeFileSync(
      join(dir, "script.json"),
      JSON.stringify({
        capabilities: CAPS,
        turns: [{ steps: [{ text: "开始跑" }, gate(dir), { tool: { name: "Bash", input: {}, result: "ONE" } }, gate(dir, "go2"), { text: "完" }] }],
      }),
    );
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.text");
    await t.driver.send(s.id, user(2, "插一句"));
    release(t, "go");
    await t.waitFor("message.processing", (e) => e.messageIds.includes(2));
    await t.driver.interrupt(s.id);
    expect(await t.waitFor("turn.ended")).toMatchObject({ messageIds: [1, 2], interrupted: true });
    await realSleep(100);
    expect(t.of("message.cancelled")).toEqual([]);
  });
});

describe("崩溃、重启：只有写进去了还没开始处理的放回去重发", () => {
  it("进程崩了：处理中的照旧算崩溃（session.exited 带着，下一条带崩溃说明），没取走的出 message.requeued、再 send 会真的再写一次（不加重发说明）", async () => {
    const t = harness([]);
    writeFileSync(
      join(t.dir, "script.json"),
      JSON.stringify({ capabilities: CAPS, turns: [{ steps: [{ text: "开始跑" }, gate(t.dir), { exit: 1 }] }], defaultTurn: { steps: [{ text: "好" }] } }),
    );
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.text");
    await expect(t.driver.send(s.id, user(2, "插一句"))).resolves.toEqual({ kind: "written", midTurn: true });
    release(t, "go");
    const exited = await t.waitFor("session.exited");
    expect(exited).toMatchObject({ reason: "crash", messageIds: [1], hadResult: false });
    expect(t.of("message.requeued")).toEqual([expect.objectContaining({ messageIds: [2] })]);
    // 账本重新登记的 session.send：真的再写一次
    await expect(t.driver.send(s.id, user(2, "插一句"))).resolves.toEqual({ kind: "written" });
    await t.waitFor("turn.ended");
    const last = t.stdinBlocks().at(-1)!;
    expect(last).toEqual([CRASH_RECOVERY_NOTE, "插一句"]);
    expect(last).not.toContain(RESEND_NOTE);
  });

  it("用户点停止、控制消息没回应被 SIGINT：没取走的标已取消，不放回去", async () => {
    const t = harness([], { ignoreControl: true }, { interruptGraceMs: 150 });
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({ capabilities: CAPS, ignoreControl: true, turns: [toolTurn(t.dir)] }));
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.text");
    await t.driver.send(s.id, user(2, "插一句"));
    await t.driver.interrupt(s.id);
    // SIGINT 时 claude 先把这一轮收尾（result），再退出
    expect(await t.waitFor("turn.ended")).toMatchObject({ messageIds: [1], interrupted: true });
    const exited = await t.waitFor("session.exited");
    expect(exited).toMatchObject({ reason: "interrupt", messageIds: [] });
    expect(t.of("message.cancelled")).toEqual([expect.objectContaining({ messageIds: [2], reason: "stop" })]);
    expect(t.of("message.requeued")).toEqual([]);
  });
});

describe("不和别的机制搅在一起", () => {
  it("claude 自己开的一轮（后台任务完成）在跑：中途写进去，被这一轮取走，turn.started 只出一次", async () => {
    const t = harness([]);
    writeFileSync(
      join(t.dir, "script.json"),
      JSON.stringify({
        capabilities: CAPS,
        turns: [{ steps: [{ text: "在等后台" }], selfTurn: { steps: [{ text: "后台好了" }, gate(t.dir), { tool: { name: "Read", input: {}, result: "x" } }, { text: "读到了" }], afterMs: 50 } }],
      }),
    );
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("turn.started");
    await expect(t.driver.send(s.id, user(2, "顺便看看这个"))).resolves.toEqual({ kind: "written", midTurn: true });
    release(t, "go");
    await t.waitFor("turn.ended", () => true, 2);
    expect(t.of("turn.started")).toHaveLength(1);
    expect(t.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], [2]]);
    expect(t.of("message.processing").map((e) => e.messageIds)).toEqual([[1], [2]]);
  });

  it("有后台任务时中途写入：照常写，结束后照旧按后台任务的兜底时长算空闲（不按 idleCloseMs 关）", async () => {
    const t = harness([], {}, { idleCloseMs: 100, backgroundHoldMaxMs: 5000 });
    writeFileSync(
      join(t.dir, "script.json"),
      JSON.stringify({ capabilities: CAPS, turns: [{ steps: [{ backgroundTasks: ["a"] }, { text: "开始跑" }, gate(t.dir), { tool: { name: "Bash", input: {}, result: "ONE" } }, { text: "完" }] }] }),
    );
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.text");
    await expect(t.driver.send(s.id, user(2, "插一句"))).resolves.toEqual({ kind: "written", midTurn: true });
    release(t, "go");
    expect(await t.waitFor("turn.ended")).toMatchObject({ messageIds: [1, 2] });
    await realSleep(400);
    expect(t.of("session.exited")).toEqual([]);
  });

  it("设置在这一轮里变了：中途写入照旧写进现在的进程（不重启、不调 prepareLaunch）；这一轮结束后下一条才按新设置重启", async () => {
    const t = harness([]);
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({ capabilities: CAPS, turns: [toolTurn(t.dir)], defaultTurn: { steps: [{ text: "好" }] } }));
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.text");
    const calls = t.prepareCalls.get(s.id);
    t.launch.fingerprint = "v2";
    await expect(t.driver.send(s.id, user(2, "插一句"))).resolves.toEqual({ kind: "written", midTurn: true });
    expect(t.prepareCalls.get(s.id)).toBe(calls);
    release(t, "go");
    await t.waitFor("turn.ended");
    expect(t.argvs()).toHaveLength(1);
    await t.driver.send(s.id, user(3, "下一条"));
    await t.waitFor("turn.ended", () => true, 2);
    expect(t.argvs()).toHaveLength(2);
    expect(t.stdinBlocks().at(-1)).toEqual([RELAUNCH_NOTE, "下一条"]);
  });

  it("中途写入的消息还没被处理完时 end：等它们都处理完才关", async () => {
    const t = harness([]);
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({ capabilities: CAPS, turns: [{ steps: [gate(t.dir), { text: "一" }] }, { steps: [{ text: "二" }] }] }));
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("message.processing");
    await t.driver.send(s.id, user(2, "二"));
    const ending = t.driver.end(s.id);
    release(t, "go");
    await ending;
    expect(t.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], [2]]);
    expect(t.of("session.exited")).toEqual([expect.objectContaining({ reason: "idle", messageIds: [] })]);
  });
});

// claude 自己开的一轮（后台任务完成通知触发，不是我们写的消息）：驱动层要认成一轮，发 turn.started，结束时发 messageIds 为空的 turn.ended。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./test-helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const user = (id: number, text: string) => ({ messageIds: [id], source: "user" as const, text });
const SELF = { steps: [{ text: "后台好了" }] };

describe("claude 自己开的一轮", () => {
  it("回完一轮后自己再开一轮：按顺序出 turn.ended(消息) → turn.started → agent.text → turn.ended(没有消息)", async () => {
    h = makeHarness({ script: { turns: [{ steps: [{ text: "在等后台" }], selfTurn: { ...SELF, afterMs: 100 } }] } });
    const s = h.addSession();
    await h.driver.send(s.id, user(1, "开始"));
    await h.waitFor("turn.ended", () => true, 2);
    const kinds = h.events.map((e) => e.event.type).filter((t) => ["agent.text", "turn.started", "turn.ended"].includes(t));
    expect(kinds).toEqual(["agent.text", "turn.ended", "turn.started", "agent.text", "turn.ended"]);
    expect(h.of("turn.ended").map((e) => [e.messageIds, e.ok])).toEqual([[[1], true], [[], true]]);
    expect(h.of("agent.text").map((e) => e.text)).toEqual(["在等后台", "后台好了"]);
  });

  it("自己开的一轮在跑的时候来的消息排着，等这一轮结束才写进去", async () => {
    h = makeHarness({
      script: { turns: [{ steps: [{ text: "在等" }], selfTurn: { steps: [{ sleepMs: 400 }, { text: "后台好了" }], afterMs: 50 } }, { steps: [{ text: "收到" }] }] },
    });
    const s = h.addSession();
    await h.driver.send(s.id, user(1, "开始"));
    await h.waitFor("turn.started");
    await expect(h.driver.send(s.id, user(2, "再来一句"))).resolves.toEqual({ kind: "queued" });
    expect(h.stdinTexts()).toEqual(["开始"]);
    await h.waitFor("turn.ended", () => true, 3);
    expect(h.stdinTexts()).toEqual(["开始", "再来一句"]);
    expect(h.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], [], [2]]);
  });

  it("自己开的一轮在跑时 end：等它跑完再退出，不出错", async () => {
    h = makeHarness({ script: { turns: [{ steps: [{ text: "在等" }], selfTurn: { steps: [{ sleepMs: 300 }, { text: "后台好了" }], afterMs: 50 } }] } });
    const s = h.addSession();
    await h.driver.send(s.id, user(1, "开始"));
    await h.waitFor("turn.started");
    await h.driver.end(s.id);
    expect(h.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], []]);
    expect(h.of("driver.error")).toEqual([]);
  });

  it("自己开的一轮在跑时关机：不出错", async () => {
    h = makeHarness({ script: { turns: [{ steps: [{ text: "在等" }], selfTurn: { steps: [{ sleepMs: 5000 }, { text: "后台好了" }], afterMs: 50 } }] } });
    const s = h.addSession();
    await h.driver.send(s.id, user(1, "开始"));
    await h.waitFor("turn.started");
    await h.driver.shutdown();
    expect(h.of("driver.error")).toEqual([]);
    expect(h.of("session.exited").at(-1)).toMatchObject({ reason: "shutdown", messageIds: [] });
  });

  it("自己开的一轮在跑时点停止：这一轮按停止收尾，下一条消息照常写", async () => {
    h = makeHarness({ script: { turns: [{ steps: [{ text: "在等" }], selfTurn: { steps: [{ sleepMs: 5000 }, { text: "后台好了" }], afterMs: 50 } }, { steps: [{ text: "收到" }] }] } });
    const s = h.addSession();
    await h.driver.send(s.id, user(1, "开始"));
    await h.waitFor("turn.started");
    await h.driver.interrupt(s.id);
    await h.waitFor("turn.ended", () => true, 2);
    expect(h.of("turn.ended")[1]).toMatchObject({ messageIds: [], interrupted: true });
    await h.driver.send(s.id, user(2, "再来"));
    await h.waitFor("turn.ended", () => true, 3);
    expect(h.of("turn.ended")[2]).toMatchObject({ messageIds: [2], ok: true });
  });
  it("排队的消息等 prepareLaunch 的时候 claude 自己开了一轮：写之前重查忙，消息留在队列里，等这一轮结束才写", async () => {
    let slow = false;
    h = makeHarness({
      script: { turns: [{ steps: [{ text: "在等" }], selfTurn: { steps: [{ sleepMs: 500 }, { text: "后台好了" }], afterMs: 50 } }, { steps: [{ text: "收到" }] }] },
      driver: {
        prepareLaunch: async (row) => {
          if (slow) await new Promise((r) => setTimeout(r, 300));
          return { promptFile: join(h!.dir, "prompt.md"), env: {}, fingerprint: String(row.id) };
        },
      },
    });
    writeFileSync(join(h.dir, "prompt.md"), "你是项目经理。");
    const s = h.addSession();
    await h.driver.send(s.id, user(1, "开始"));
    await h.waitFor("turn.ended");
    slow = true;
    // prepareLaunch 的 300 毫秒里，假 claude 的自己开的一轮（50 毫秒后）开始了
    await expect(h.driver.send(s.id, user(2, "再来一句"))).resolves.toEqual({ kind: "queued" });
    await h.waitFor("turn.ended", () => true, 3);
    const order = h.events.map((e) => e.event.type + (e.event.type === "turn.ended" ? `:${e.event.messageIds.join()}` : ""));
    expect(order.indexOf("message.delivered", order.indexOf("turn.started"))).toBeGreaterThan(order.indexOf("turn.ended:"));
    expect(h.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], [], [2]]);
  });
});

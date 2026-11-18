import { describe, expect, it } from "vitest";
import type { FeishuCardId, FeishuChatId, FeishuMessageId } from "../../shared/feishu.ts";
import { FEISHU_CARD_MAX_CHARS, FEISHU_STREAM_FLUSH_MS, FEISHU_STREAM_RENEW_MS } from "../../shared/limits.ts";
import {
  createFeishuCardkitBudget,
  stepFeishuStream,
  type FeishuCardkitBudget,
  type FeishuStreamEffect,
  type FeishuStreamEvent,
  type FeishuStreamState,
} from "./stream.ts";

const target = { conversationId: 1, chatId: "oc_1" as FeishuChatId };
const CARD = "card1" as FeishuCardId;
const OM = "om_1" as FeishuMessageId;
const always: FeishuCardkitBudget = { tryTake: () => true };
const never: FeishuCardkitBudget = { tryTake: () => false };

/** 依次喂事件，记下每一步的效果。 */
function run(events: [FeishuStreamEvent, number][], budget: FeishuCardkitBudget = always, start: FeishuStreamState = { phase: "idle" }) {
  let state = start;
  const effects: FeishuStreamEffect[] = [];
  for (const [event, now] of events) {
    const step = stepFeishuStream(state, event, target, now, budget);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}
const opened = (sequence = 0): FeishuStreamEvent => ({ kind: "opened", cardId: CARD, messageId: OM, sequence });
const text = (t: string): FeishuStreamEvent => ({ kind: "text", text: t });
const working = (status: string): FeishuStreamEvent => ({ kind: "working", status });
const kinds = (effects: FeishuStreamEffect[]) => effects.filter((e) => e.kind !== "schedule_tick").map((e) => e.kind);
const pushes = (effects: FeishuStreamEffect[]) => effects.filter((e): e is Extract<FeishuStreamEffect, { kind: "push" }> => e.kind === "push");

describe("stepFeishuStream", () => {
  it("第一块文字来了发 open，opening 期间的文字在 opened 之后补推", () => {
    const { effects, state } = run([
      [text("你"), 0],
      [text("你好"), 10],
      [opened(), 20],
      [{ kind: "tick" }, 20 + FEISHU_STREAM_FLUSH_MS],
    ]);
    expect(effects[0]).toEqual({ kind: "open", text: "你" });
    expect(pushes(effects)).toEqual([{ kind: "push", cardId: CARD, text: "你好", sequence: 1 }]);
    expect(state).toMatchObject({ phase: "live", sentText: "你好" });
  });

  it("距上次推送不足 FEISHU_STREAM_FLUSH_MS 只记下并发 schedule_tick，到点 tick 时 push 全文", () => {
    const opening = run([[text("a"), 0], [opened(), 0]]);
    const early = stepFeishuStream(opening.state, text("ab"), target, 10, always);
    expect(early.effects).toEqual([{ kind: "schedule_tick", at: FEISHU_STREAM_FLUSH_MS }]);
    const due = stepFeishuStream(early.state, { kind: "tick" }, target, FEISHU_STREAM_FLUSH_MS, always);
    expect(pushes(due.effects)).toEqual([{ kind: "push", cardId: CARD, text: "ab", sequence: 1 }]);
  });

  it("每次 push 的 sequence 比上一次大", () => {
    const events: [FeishuStreamEvent, number][] = [[text("a"), 0], [opened(3), 0]];
    let t = 0;
    let body = "a";
    for (let i = 0; i < 10; i++) {
      t += FEISHU_STREAM_FLUSH_MS;
      body += "b";
      events.push([text(body), t]);
    }
    events.push([{ kind: "segment_done", messageId: 9, text: body }, t + 1]);
    const seqs = run(events).effects.flatMap((e) => ("sequence" in e ? [e.sequence] : []));
    expect(seqs.length).toBe(11);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    expect(seqs[0]).toBe(4);
  });

  it("拿不到预算时只合并不排队，下一次 tick 再推", () => {
    const live = run([[text("a"), 0], [opened(), 0]]).state;
    const t = FEISHU_STREAM_FLUSH_MS;
    const denied1 = stepFeishuStream(live, text("ab"), target, t, never);
    const denied2 = stepFeishuStream(denied1.state, text("abc"), target, t + 1, never);
    expect(pushes([...denied1.effects, ...denied2.effects])).toEqual([]);
    expect(denied2.effects.some((e) => e.kind === "schedule_tick")).toBe(true);
    const ok = stepFeishuStream(denied2.state, { kind: "tick" }, target, t + FEISHU_STREAM_FLUSH_MS, always);
    expect(pushes(ok.effects)).toEqual([{ kind: "push", cardId: CARD, text: "abc", sequence: 1 }]);
  });

  it("流式模式开着超过 FEISHU_STREAM_RENEW_MS 时 tick 发 renew", () => {
    const live = run([[text("a"), 0], [opened(), 0]]);
    expect(live.effects).toContainEqual({ kind: "schedule_tick", at: FEISHU_STREAM_RENEW_MS });
    const before = stepFeishuStream(live.state, { kind: "tick" }, target, FEISHU_STREAM_RENEW_MS - 1, always);
    expect(kinds(before.effects)).toEqual([]);
    const renew = stepFeishuStream(live.state, { kind: "tick" }, target, FEISHU_STREAM_RENEW_MS, always);
    expect(renew.effects[0]).toEqual({ kind: "renew", cardId: CARD, sequence: 1 });
    expect(renew.state).toMatchObject({ streamingSince: FEISHU_STREAM_RENEW_MS, sequence: 1 });
  });

  it("segment_done 发 finalize，定稿正文等于账本这段文字，不另发新卡", () => {
    const { effects, state } = run([
      [text("草稿"), 0],
      [opened(), 0],
      [{ kind: "segment_done", messageId: 42, text: "账本里的正文" }, 5],
    ]);
    expect(effects.filter((e) => e.kind === "open")).toHaveLength(1);
    expect(effects.at(-1)).toEqual({ kind: "finalize", cardId: CARD, sequence: 1, messageId: 42, text: "账本里的正文" });
    expect(state).toEqual({ phase: "idle" });
  });

  it("opening 期间就落库时，等 opened 之后再定稿", () => {
    const pending = run([
      [text("草稿"), 0],
      [{ kind: "segment_done", messageId: 42, text: "正文" }, 1],
    ]);
    expect(kinds(pending.effects)).toEqual(["open"]);
    const done = stepFeishuStream(pending.state, opened(2), target, 3, always);
    expect(done.effects).toEqual([{ kind: "finalize", cardId: CARD, sequence: 3, messageId: 42, text: "正文" }]);
    expect(done.state).toEqual({ phase: "idle" });
  });

  it("没流式过的段直接 finalize，cardId 为 null", () => {
    expect(run([[{ kind: "segment_done", messageId: 7, text: "一次写完" }, 0]]).effects).toEqual([
      { kind: "finalize", cardId: null, sequence: 0, messageId: 7, text: "一次写完" },
    ]);
  });

  it("turn_end 时还在 live 发 abandon 回 idle；idle 时 turn_end 什么都不做", () => {
    const live = run([[text("a"), 0], [opened(), 0]]).state;
    expect(stepFeishuStream(live, { kind: "turn_end" }, target, 1, always)).toEqual({ state: { phase: "idle" }, effects: [{ kind: "abandon", cardId: CARD, sequence: 1, text: "a" }] });
    expect(stepFeishuStream({ phase: "idle" }, { kind: "turn_end" }, target, 1, always)).toEqual({ state: { phase: "idle" }, effects: [] });
    const opening = run([[text("a"), 0], [{ kind: "turn_end" }, 1], [opened(), 2]]);
    expect(kinds(opening.effects)).toEqual(["open", "abandon"]);
  });

  it("abandon 带最新的预览全文，不是上一次推上去的那部分", () => {
    const { effects } = run([[text("a"), 0], [opened(), 0], [text("ab"), 1], [{ kind: "turn_end" }, 2]]);
    expect(effects.at(-1)).toEqual({ kind: "abandon", cardId: CARD, sequence: 1, text: "ab" });
  });

  it("开轮、工具阶段（working）先开一张带状态的卡；正文来了在同一张卡上换成正文，定稿在这张卡上", () => {
    const { effects, state } = run([
      [working("Working…"), 0],
      [opened(), 1],
      [working("Running command…"), 1 + FEISHU_STREAM_FLUSH_MS],
      [text("结论"), 1 + FEISHU_STREAM_FLUSH_MS * 2],
      [{ kind: "segment_done", messageId: 5, text: "结论：没问题", turnActive: false }, 1 + FEISHU_STREAM_FLUSH_MS * 3],
    ]);
    expect(effects[0]).toEqual({ kind: "open", text: "Working…" });
    expect(pushes(effects).map((p) => p.text)).toEqual(["Running command…", "结论"]);
    expect(effects.filter((e) => e.kind === "open")).toHaveLength(1);
    expect(effects.at(-1)).toEqual({ kind: "finalize", cardId: CARD, sequence: 3, messageId: 5, text: "结论：没问题" });
    expect(state).toEqual({ phase: "idle" });
  });

  it("正文开始后状态行不再盖掉正文", () => {
    const { effects } = run([
      [text("正文"), 0],
      [opened(), 0],
      [working("Running command…"), FEISHU_STREAM_FLUSH_MS],
    ]);
    expect(pushes(effects)).toEqual([]);
  });

  it("整轮没有正文就结束（只调了工具或被停下）：发 discard 撤回状态卡，不留残卡", () => {
    const live = run([[working("Working…"), 0], [opened(), 0]]);
    expect(stepFeishuStream(live.state, { kind: "turn_end" }, target, 1, always)).toEqual({
      state: { phase: "idle" },
      effects: [{ kind: "discard", cardId: CARD, messageId: OM, sequence: 1 }],
    });
    const opening = run([[working("Working…"), 0], [{ kind: "turn_end" }, 1], [opened(), 2]]);
    expect(kinds(opening.effects)).toEqual(["open", "discard"]);
  });

  it("这一轮定稿过一段后进 quiet：工具阶段不再开状态卡，下一段文字照常开卡，turn_end 回 idle", () => {
    const done = run([
      [working("Working…"), 0],
      [opened(), 0],
      [{ kind: "segment_done", messageId: 5, text: "先说一句", turnActive: true }, 1],
    ]);
    expect(done.state).toEqual({ phase: "quiet" });
    expect(stepFeishuStream(done.state, working("Running command…"), target, 2, always)).toEqual({ state: { phase: "quiet" }, effects: [] });
    expect(kinds(stepFeishuStream(done.state, text("第二段"), target, 2, always).effects)).toEqual(["open"]);
    expect(stepFeishuStream(done.state, { kind: "segment_done", messageId: 6, text: "一次写完", turnActive: true }, target, 2, always).effects).toEqual([
      { kind: "finalize", cardId: null, sequence: 0, messageId: 6, text: "一次写完" },
    ]);
    expect(stepFeishuStream(done.state, { kind: "turn_end" }, target, 2, always)).toEqual({ state: { phase: "idle" }, effects: [] });
  });

  it("一轮已经结束后才落库的段（turnActive 为 false）定稿后回 idle，下一轮照常开状态卡", () => {
    const { state } = run([[{ kind: "segment_done", messageId: 7, text: "迟到的段", turnActive: false }, 0]]);
    expect(state).toEqual({ phase: "idle" });
    expect(kinds(stepFeishuStream(state, working("Working…"), target, 1, always).effects)).toEqual(["open"]);
  });

  it("同一个事件序列、同一个 now、同样的预算结果得到同一个结果", () => {
    const events: [FeishuStreamEvent, number][] = [
      [text("a"), 0],
      [opened(), 5],
      [text("ab"), 100],
      [{ kind: "tick" }, 400],
      [text("x".repeat(FEISHU_CARD_MAX_CHARS + 5)), 800],
      [{ kind: "segment_done", messageId: 1, text: "ab" }, 900],
    ];
    expect(run(events)).toEqual(run(events));
    const long = run(events).effects.find((e): e is Extract<FeishuStreamEffect, { kind: "push" }> => e.kind === "push" && e.text.startsWith("x"))!;
    expect([...long.text]).toHaveLength(FEISHU_CARD_MAX_CHARS);
  });
});

describe("createFeishuCardkitBudget", () => {
  it("一秒内用满 perSecond 次后 tryTake 返回 false，过了一秒恢复", () => {
    const budget = createFeishuCardkitBudget(3);
    expect([0, 100, 200].map((t) => budget.tryTake(t))).toEqual([true, true, true]);
    expect(budget.tryTake(999)).toBe(false);
    expect(budget.tryTake(1000)).toBe(true);
    expect(budget.tryTake(1050)).toBe(false);
    expect(budget.tryTake(1100)).toBe(true);
  });
});

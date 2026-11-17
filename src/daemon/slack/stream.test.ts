import { describe, it } from "vitest";

describe("stepSlackStream", () => {
  it.todo("idle 收到第一块文字发 post，带停止按钮，进 opening");
  it.todo("opening 期间来的文字只记下，opened 之后按间隔补发 update");
  it.todo("live 时距上次刷新不足 SLACK_STREAM_UPDATE_INTERVAL_MS 只记下并 schedule_tick，到点发 update");
  it.todo("预算用满时只记下，下一次 tick 再发，最后一次 update 的正文是最新预览");
  it.todo("segment_done 发 finalize，ts 是流式那条，正文等于账本这段文字，不另发新消息");
  it.todo("没流式过就落库的一段直接 finalize（ts 为 null）");
  it.todo("这一轮被打断没落库时 turn_end 发 update 去掉停止按钮，回 idle");
  it.todo("定稿后再来的文字开始下一段，不改已定稿的那条");
  it.todo("同一个事件序列算两次得到同一个结果");
});

describe("createSlackUpdateBudget", () => {
  it.todo("一分钟内最多给 perMinute 次，用满后返回 false，过了窗口恢复");
});

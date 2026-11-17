import { describe, it } from "vitest";

describe("stepSlackStream：edit（顶层消息）", () => {
  it.todo("idle 收到第一块文字发 post，带停止按钮，进 opening");
  it.todo("opened 之后的文字距上次刷新不足 SLACK_STREAM_UPDATE_INTERVAL_MS 只记下并 schedule_tick，到点发 update");
  it.todo("segment_done 发 finalize，ts 是流式那条，正文等于账本这段文字，不另发新消息");
  it.todo("没流式过就落库的一段直接 finalize（ts 为 null）");
  it.todo("这一轮被打断没落库时 turn_end 发 update 去掉停止按钮，回 idle");
});

describe("stepSlackStream：native（串里原生流式）", () => {
  it.todo("有 threadTs 和 recipient 时第一块文字发 start_native");
  it.todo("之后按 SLACK_NATIVE_STREAM_APPEND_INTERVAL_MS 发 append_native，只发新增部分");
  it.todo("开了 SLACK_NATIVE_STREAM_MAX_MS 或空闲 SLACK_NATIVE_STREAM_IDLE_MAX_MS 就 stop_native 收尾");
  it.todo("预览被改写（不是在原文后追加）时改用整条 update");
  it.todo("native_failed 后当前这条改用 edit 继续，定稿正文不丢字");
  it.todo("segment_done 先 stop_native 再 finalize");
});

describe("stepSlackStream：通用", () => {
  it.todo("同一个事件序列算两次得到同一个结果");
  it.todo("定稿后再来的文字开始下一段，不改已定稿的那条");
});

describe("createSlackUpdateBudget", () => {
  it.todo("一分钟内最多给 perMinute 次，用满后返回 false，过了窗口恢复");
});

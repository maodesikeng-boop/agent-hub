import { describe, it } from "vitest";

describe("stepFeishuStream", () => {
  it.todo("第一块文字来了发 open，opening 期间的文字在 opened 之后补推");
  it.todo("距上次推送不足 FEISHU_STREAM_FLUSH_MS 只记下并发 schedule_tick，到点 tick 时 push 全文");
  it.todo("每次 push 的 sequence 比上一次大");
  it.todo("拿不到预算时只合并不排队，下一次 tick 再推");
  it.todo("流式模式开着超过 FEISHU_STREAM_RENEW_MS 时 tick 发 renew");
  it.todo("segment_done 发 finalize，定稿正文等于账本这段文字，不另发新卡");
  it.todo("opening 期间就落库时，等 opened 之后再定稿");
  it.todo("没流式过的段直接 finalize，cardId 为 null");
  it.todo("turn_end 时还在 live 发 abandon 回 idle；idle 时 turn_end 什么都不做");
  it.todo("同一个事件序列、同一个 now、同样的预算结果得到同一个结果");
});

describe("createFeishuCardkitBudget", () => {
  it.todo("一秒内用满 perSecond 次后 tryTake 返回 false，过了一秒恢复");
});

import { describe, it } from "vitest";

// 账本这一侧的接线（docs/slack-design.md「骨架文件」）：Slack 来的消息带 origin，发给 agent 时加署名，访客轮次拦高危命令。

describe("账本：Slack 消息的来源", () => {
  it.todo("postUserMessage 带 origin 时写进 meta.origin，网页发的消息 meta 不变");
  it.todo("deliveryOf 对带 origin 的消息在 prefixes 里加上 slackDeliveryPrefixes 的结果");
  it.todo("项目经理正在处理访客唤醒的消息时，hub project.attach 等 SLACK_GUEST_BLOCKED_HUB_COMMANDS 返回 forbidden 和原因");
  it.todo("主人唤醒的轮次和网页发的消息不受影响");
  it.todo("messagesAfter 返回这个对话里编号更大的消息，从小到大，最多 limit 条");
});

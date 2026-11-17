import { describe, it } from "vitest";

describe("parseSlack*Id / parseSlackTs", () => {
  it.todo("形状对的工作区、频道、用户编号和 ts 返回品牌值，原值不变");
  it.todo("空串、小写、带空格、非字符串、ts 少了小数部分都返回 null");
});

describe("slackDeliveryPrefixes", () => {
  it.todo("solo 模式下主人的话返回空数组，和网页发的一样不加前缀");
  it.todo("shared 模式下主人和访客都有署名，写明显示名和“主人”或“访客”");
  it.todo("有背景聊天时先放“频道里刚才的讨论”一块（从早到晚，每行带名字和身份），再放署名");
});

describe("slackGuestTurnBlockReason", () => {
  it.todo("访客唤醒的轮次里调 SLACK_GUEST_BLOCKED_HUB_COMMANDS 里的每一个命令都返回拒绝原因");
  it.todo("访客唤醒的轮次里调 worker.start、ask、router.report 等其余命令返回 null");
  it.todo("主人唤醒的轮次和网页发的消息（origin 为 null）调任何命令都返回 null");
});

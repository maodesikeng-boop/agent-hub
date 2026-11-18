import { describe, it } from "vitest";

// 实现步骤在账本一侧接的几处（docs/feishu-design.md「骨架文件」末段）。本步不改账本，先列行为。

describe("账本接线", () => {
  it.todo("postUserMessage 带 origin 时写进 meta.origin，读回一致");
  it.todo("deliveryParts 按 meta.origin 调 feishuDeliveryPrefixes，网页消息不变");
  it.todo("hubCall 查正在处理的那条用户消息的 origin，访客轮次里本档禁用的命令返回 forbidden 和拒绝原因");
  it.todo("messagesAfter 返回编号大于 after 的消息，从小到大，最多 limit 条");
  it.todo("只读 Worker 读不到 state/feishu-secrets.json");
  it.todo("db-retention 每天清理时调 prunePosts，删掉超过 FEISHU_POST_RETENTION_DAYS 的已定稿记录");
});

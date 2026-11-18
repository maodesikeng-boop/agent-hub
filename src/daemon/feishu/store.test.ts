import { describe, it } from "vitest";

describe("createFeishuStore", () => {
  it.todo("saveApp 换了 appId 时四张表在一个事务里清空，主人取入参");
  it.todo("saveApp 同一个 appId 只更新机器人信息，主人和群保留");
  it.todo("bindOwner 已有主人时原样返回");
  it.todo("同一个 target 只有一行；upsertChat 换群编号时清掉旧群的 feishu_posts 和水位、archivedAt 回到 null，唤醒方式和访客档位不动");
  it.todo("setChatArchived 记下归档时间并删掉这个群的 feishu_posts");
  it.todo("setChatPolicy 只改给了的字段，默认 auto / chat_only");
  it.todo("项目经理删掉后群记录的 pmId 变 null，不跟着删");
  it.todo("advanceWatermark 只往大了改");
  it.todo("savePost 同一个 ref 覆盖；sequence 比已存的小时抛错");
  it.todo("postByMessageId 按飞书消息编号找回");
  it.todo("prunePosts 只删早于 before 的 final / card_settled，等拍板的不删");
  it.todo("avatarKey / saveAvatarKey 按水果存取");
});

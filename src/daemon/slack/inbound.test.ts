import { describe, it } from "vitest";

describe("parseSlackEnvelope", () => {
  it.todo("私密频道里的真人消息解析成 message，channelType 是 group，带 ts；发在串里的 inThread 为 true");
  it.todo("正文里的 <@机器人> 去掉，@别人原样保留");
  it.todo("机器人自己发的、别的机器人发的、message_changed、message_deleted、channel_join 子类型返回 null");
  it.todo("别的工作区的用户（team 不是本工作区）返回 null");
  it.todo("同一条消息重投（retry_attempt 不同）解析结果相同");
  it.todo("按钮点击解析成 action，带消息 ts、action_ts、trigger_id 和解码后的动作；值解不出返回 null");
  it.todo("弹窗提交解析成 note_submitted，带弹窗编号和填写的文字");
  it.todo("member_joined_channel、member_left_channel 解析成 membership");
  it.todo("group_rename、group_archive、group_unarchive 解析成 channel");
  it.todo("不认识的信封类型、形状不对的 payload 返回 null，不抛错");
});

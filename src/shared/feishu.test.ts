import { describe, it } from "vitest";

describe("parseFeishu*", () => {
  it.todo("cli_ / ou_ / oc_ / om_ 开头且形状对时返回品牌值，前缀不对、空串、非字符串返回 null");
  it.todo("卡片编号只认非空字母数字，image_key 只认非空字符串");
});

describe("feishuGuestMay", () => {
  it.todo("chat_only：能 talk，不能 answer_card、stop、send_files");
  it.todo("collaborator：talk、answer_card、stop、send_files 都能");
  it.todo("observer：四件都不能（说的话只记成背景，由 routing 处理）");
});

describe("feishuDeliveryPrefixes", () => {
  it.todo("solo 下主人的话、没有背景时返回空数组");
  it.todo("shared 下主人和访客的话各有一行署名，写明显示名和（主人）或（访客）");
  it.todo("有背景时多一段“群里之前的讨论”，每行“名字（身份）：原话”，按时间先后");
});

describe("feishuGuestTurnBlockReason", () => {
  it.todo("每一档访客的话触发的轮次里，本档 FEISHU_GUEST_BLOCKED_HUB_COMMANDS 中的每个命令都返回拒绝原因");
  it.todo("collaborator 档访客的话触发的轮次里 graph.decide、schedule.add 放行");
  it.todo("主人的话、网页的话（origin 为 null）、表外命令返回 null");
});

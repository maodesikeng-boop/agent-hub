import { describe, it } from "vitest";

describe("feishuWakes（单人群直聊，拉人进群后自动切 @机器人 才触发）", () => {
  it.todo("auto 档 solo 时不 @机器人 也唤醒");
  it.todo("auto 档 shared 时只有 @机器人 才唤醒");
  it.todo("mention_only 档不管几个人都只有 @机器人 才唤醒");
  it.todo("mentionOnlyForced 时按 mention_only 处理");
});

describe("routeFeishuMessage", () => {
  it.todo("没认主人时单聊里发有效绑定码 → bind_owner；别的单聊、群消息 → ignore 或 reject");
  it.todo("主人在单聊里说话 → deliver 给总助；别人在单聊里说话 → reject");
  it.todo("唤醒时 deliver，origin 带 mode、guestTier 和这个群的背景");
  it.todo("shared 下没 @机器人 的话 → context，送达时由调用方清空背景");
  it.todo("observer 档访客的话 @机器人 也不唤醒，记成背景 → context");
  it.todo("访客以“/”开头的话 → reject");
  it.todo("chat_only 档访客带的文件不收，droppedFiles 记个数；collaborator 档收");
  it.todo("话题里的话 → ignore；记录已归档（群已解散）的迟到事件 → ignore");
});

describe("routeFeishuAction", () => {
  it.todo("主人点选项 → answer；同一次点击重投得到同一个 clientId");
  it.todo("chat_only 档访客点选项、停止 → reject 并给 toast；collaborator 档访客能点");
  it.todo("set_policy 只认主人，访客点 → reject");
  it.todo("还没认主人 → ignore");
});

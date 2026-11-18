import { describe, it } from "vitest";

describe("parseFeishuEvent", () => {
  it.todo("用户在群里发的文字解析成 message，编号品牌化，mentionedBot、inThread 照原样");
  it.todo("机器人（含自己）发的消息、编号形状不对的事件返回 null");
  it.todo("图片和文件进 files，语音、视频、表情包只记 droppedMedia");
  it.todo("成员进群、退群解析成 members_added / members_removed；机器人被移出和群解散都是 chat_gone；改群名是 chat_renamed");
});

describe("parseFeishuCardAction", () => {
  it.todo("按钮值能解码时返回动作，表单里的补充说明去掉首尾空白放进 note，空的是 null");
  it.todo("按钮值被改过或是老版本的返回 null");
});

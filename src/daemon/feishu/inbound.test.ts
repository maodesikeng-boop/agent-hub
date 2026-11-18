import { describe, expect, it } from "vitest";
import type { FeishuOpenId } from "../../shared/feishu.ts";
import { encodeFeishuActionValue } from "./cards.ts";
import { parseFeishuCardAction, parseFeishuEvent } from "./inbound.ts";
import type { FeishuRawEvent } from "./transport.ts";

const BOT = "ou_bot" as FeishuOpenId;
const msg = (patch: Partial<Extract<FeishuRawEvent, { type: "im.message.receive_v1" }>> = {}): FeishuRawEvent => ({
  type: "im.message.receive_v1",
  messageId: "om_1",
  chatId: "oc_1",
  chatType: "group",
  senderOpenId: "ou_owner",
  senderType: "user",
  content: "  你好  ",
  mentionedBot: true,
  threadId: null,
  resources: [],
  createTime: 123,
  ...patch,
});

describe("parseFeishuEvent", () => {
  it("用户在群里发的文字解析成 message，编号品牌化，mentionedBot、inThread 照原样", () => {
    expect(parseFeishuEvent(msg(), BOT)).toEqual({
      kind: "message",
      messageId: "om_1",
      chatId: "oc_1",
      chatType: "group",
      senderOpenId: "ou_owner",
      text: "你好",
      mentionedBot: true,
      inThread: false,
      files: [],
      droppedMedia: 0,
      at: 123,
    });
    expect(parseFeishuEvent(msg({ threadId: "omt_1", mentionedBot: false }), BOT)).toMatchObject({ inThread: true, mentionedBot: false });
  });

  it("机器人（含自己）发的消息、编号形状不对的事件返回 null", () => {
    expect(parseFeishuEvent(msg({ senderType: "app" }), BOT)).toBeNull();
    expect(parseFeishuEvent(msg({ senderOpenId: "ou_bot" }), BOT)).toBeNull();
    expect(parseFeishuEvent(msg({ chatId: "bad" }), BOT)).toBeNull();
    expect(parseFeishuEvent(msg({ messageId: "" }), BOT)).toBeNull();
    expect(parseFeishuEvent(msg({ senderOpenId: "user1" }), BOT)).toBeNull();
  });

  it("图片、文件、视频、语音进 files（视频语音按文件下载、没名字时补一个），只有表情包记 droppedMedia", () => {
    const parsed = parseFeishuEvent(
      msg({
        resources: [
          { type: "image", fileKey: "img_1", fileName: null },
          { type: "file", fileKey: "file_1", fileName: "a.pdf" },
          { type: "audio", fileKey: "a_000001", fileName: null },
          { type: "video", fileKey: "v_000001", fileName: "demo.mp4" },
          { type: "video", fileKey: "v_000002", fileName: null },
          { type: "sticker", fileKey: "s_1", fileName: null },
        ],
      }),
      BOT,
    );
    expect(parsed).toMatchObject({
      files: [
        { type: "image", fileKey: "img_1", fileName: null },
        { type: "file", fileKey: "file_1", fileName: "a.pdf" },
        { type: "file", fileKey: "a_000001", fileName: "飞书语音-a_000001.opus" },
        { type: "file", fileKey: "v_000001", fileName: "demo.mp4" },
        { type: "file", fileKey: "v_000002", fileName: "飞书视频-v_000002.mp4" },
      ],
      droppedMedia: 1,
    });
  });

  it("富文本里图片、文件、视频的占位从正文里去掉，正文只留用户写的字", () => {
    const parsed = parseFeishuEvent(
      msg({
        content: '看这两张\n![image](img_a) ![image](img_b)\n<file key="file_c" name="报告.pdf"/>\n<video key="file_v" name="demo.mp4" duration="0:03"/>\n然后改一下',
        resources: [
          { type: "image", fileKey: "img_a", fileName: null },
          { type: "image", fileKey: "img_b", fileName: null },
          { type: "file", fileKey: "file_c", fileName: "报告.pdf" },
          { type: "video", fileKey: "file_v", fileName: "demo.mp4" },
        ],
      }),
      BOT,
    );
    expect(parsed).toMatchObject({ text: "看这两张\n然后改一下" });
    expect(parsed?.kind === "message" ? parsed.files.map((f) => f.fileKey) : []).toEqual(["img_a", "img_b", "file_c", "file_v"]);
    expect(parseFeishuEvent(msg({ content: "![image](img_only)", resources: [{ type: "image", fileKey: "img_only", fileName: null }] }), BOT)).toMatchObject({ text: "" });
  });

  it("成员进群、退群解析成 members_added / members_removed；机器人被移出和群解散都是 chat_gone；改群名是 chat_renamed", () => {
    expect(parseFeishuEvent({ type: "im.chat.member.user.added_v1", chatId: "oc_1", openIds: ["ou_a", "bad"] }, BOT)).toEqual({
      kind: "members_added",
      chatId: "oc_1",
      openIds: ["ou_a"],
    });
    expect(parseFeishuEvent({ type: "im.chat.member.user.deleted_v1", chatId: "oc_1", openIds: ["ou_a"] }, BOT)).toEqual({
      kind: "members_removed",
      chatId: "oc_1",
      openIds: ["ou_a"],
    });
    expect(parseFeishuEvent({ type: "im.chat.member.bot.deleted_v1", chatId: "oc_1" }, BOT)).toEqual({ kind: "chat_gone", chatId: "oc_1" });
    expect(parseFeishuEvent({ type: "im.chat.disbanded_v1", chatId: "oc_1" }, BOT)).toEqual({ kind: "chat_gone", chatId: "oc_1" });
    expect(parseFeishuEvent({ type: "im.chat.updated_v1", chatId: "oc_1", name: "新名字" }, BOT)).toEqual({ kind: "chat_renamed", chatId: "oc_1", name: "新名字" });
    expect(parseFeishuEvent({ type: "im.chat.updated_v1", chatId: "oc_1", name: null }, BOT)).toBeNull();
  });
});

describe("parseFeishuCardAction", () => {
  const value = encodeFeishuActionValue({ kind: "choose", card: { kind: "ask", askMessageId: 3 }, optionIndex: 1 });

  it("按钮值能解码时返回动作，表单里的补充说明去掉首尾空白放进 note，空的是 null", () => {
    expect(parseFeishuCardAction({ messageId: "om_1", chatId: "oc_1", operatorOpenId: "ou_a", value, formValue: { note: "  先这样  " } })).toEqual({
      messageId: "om_1",
      chatId: "oc_1",
      operatorOpenId: "ou_a",
      value: { kind: "choose", card: { kind: "ask", askMessageId: 3 }, optionIndex: 1 },
      note: "先这样",
    });
    expect(parseFeishuCardAction({ messageId: "om_1", chatId: "oc_1", operatorOpenId: "ou_a", value, formValue: { note: "   " } })?.note).toBeNull();
    expect(parseFeishuCardAction({ messageId: "om_1", chatId: "oc_1", operatorOpenId: "ou_a", value, formValue: null })?.note).toBeNull();
  });

  it("按钮值被改过或是老版本的返回 null", () => {
    expect(parseFeishuCardAction({ messageId: "om_1", chatId: "oc_1", operatorOpenId: "ou_a", value: { kind: "choose" }, formValue: null })).toBeNull();
    expect(parseFeishuCardAction({ messageId: "om_1", chatId: "oc_1", operatorOpenId: "ou_a", value: { ...value, fusa: 0 }, formValue: null })).toBeNull();
    expect(parseFeishuCardAction({ messageId: "bad", chatId: "oc_1", operatorOpenId: "ou_a", value, formValue: null })).toBeNull();
  });
});

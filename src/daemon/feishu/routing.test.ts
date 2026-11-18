import { describe, expect, it } from "vitest";
import type { FeishuChatId, FeishuMessageId, FeishuOpenId } from "../../shared/feishu.ts";
import type { FeishuInbound, FeishuInboundAction } from "./inbound.ts";
import { feishuWakes, routeFeishuAction, routeFeishuMessage, type FeishuRoutingContext } from "./routing.ts";

const OWNER = "ou_owner" as FeishuOpenId;
const GUEST = "ou_guest" as FeishuOpenId;
type Msg = Extract<FeishuInbound, { kind: "message" }>;

const msg = (patch: Partial<Msg> = {}): Msg => ({
  kind: "message",
  messageId: "om_1" as FeishuMessageId,
  chatId: "oc_pm" as FeishuChatId,
  chatType: "group",
  senderOpenId: OWNER,
  text: "看看登录页",
  mentionedBot: false,
  inThread: false,
  files: [],
  droppedMedia: 0,
  at: 100,
  ...patch,
});

const ctx = (patch: Partial<FeishuRoutingContext> = {}): FeishuRoutingContext => ({
  ownerOpenId: OWNER,
  binding: { target: { kind: "pm", pmId: 7 }, archived: false },
  mode: "solo",
  triggerMode: "auto",
  guestTier: "chat_only",
  mentionOnlyForced: false,
  speakerName: "张三",
  pendingContext: [],
  isBindCode: (text) => text === "123456",
  ...patch,
});

describe("feishuWakes（单人群直聊，拉人进群后自动切 @机器人 才触发）", () => {
  const w = (patch: Partial<FeishuRoutingContext>, mentioned: boolean) => feishuWakes({ ...ctx(), ...patch }, mentioned);

  it("auto 档 solo 时不 @机器人 也唤醒", () => {
    expect(w({ mode: "solo" }, false)).toBe(true);
    expect(w({ mode: "solo" }, true)).toBe(true);
  });

  it("auto 档 shared 时只有 @机器人 才唤醒", () => {
    expect(w({ mode: "shared" }, false)).toBe(false);
    expect(w({ mode: "shared" }, true)).toBe(true);
  });

  it("mention_only 档不管几个人都只有 @机器人 才唤醒", () => {
    for (const mode of ["solo", "shared"] as const) {
      expect(w({ mode, triggerMode: "mention_only" }, false)).toBe(false);
      expect(w({ mode, triggerMode: "mention_only" }, true)).toBe(true);
    }
  });

  it("mentionOnlyForced 时按 mention_only 处理", () => {
    expect(w({ mode: "solo", mentionOnlyForced: true }, false)).toBe(false);
    expect(w({ mode: "solo", mentionOnlyForced: true }, true)).toBe(true);
  });
});

describe("routeFeishuMessage", () => {
  it("没认主人时单聊里发有效绑定码 → bind_owner；别的单聊、群消息 → ignore 或 reject", () => {
    const noOwner = ctx({ ownerOpenId: null });
    expect(routeFeishuMessage(msg({ chatType: "p2p", senderOpenId: GUEST, text: "123456" }), noOwner)).toEqual({ kind: "bind_owner", openId: GUEST });
    expect(routeFeishuMessage(msg({ chatType: "p2p", senderOpenId: GUEST, text: "你好" }), noOwner)).toEqual({ kind: "ignore" });
    expect(routeFeishuMessage(msg({ mentionedBot: true }), noOwner)).toEqual({ kind: "ignore" });
    expect(routeFeishuMessage(msg(), ctx({ binding: null }))).toEqual({ kind: "ignore" });
  });

  it("主人在单聊里说话 → deliver 给总助；别人在单聊里说话 → reject", () => {
    const owner = routeFeishuMessage(msg({ chatType: "p2p", text: "今天怎么样" }), ctx({ binding: null }));
    expect(owner).toMatchObject({ kind: "deliver", target: { kind: "router" }, text: "今天怎么样", origin: { role: "owner", mode: "solo", context: [] } });
    const other = routeFeishuMessage(msg({ chatType: "p2p", senderOpenId: GUEST }), ctx({ binding: null }));
    expect(other).toMatchObject({ kind: "reject", openId: GUEST });
  });

  it("唤醒时 deliver，origin 带 mode、guestTier 和这个群的背景", () => {
    const pending = [{ name: "李四", role: "guest" as const, text: "先看注册", at: 50 }];
    const route = routeFeishuMessage(msg({ mentionedBot: true }), ctx({ mode: "shared", guestTier: "collaborator", pendingContext: pending }));
    expect(route).toEqual({
      kind: "deliver",
      target: { kind: "pm", pmId: 7 },
      text: "看看登录页",
      origin: { kind: "feishu", openId: OWNER, name: "张三", role: "owner", mode: "shared", guestTier: "collaborator", context: pending },
      files: [],
      droppedFiles: 0,
    });
  });

  it("shared 下没 @机器人 的话 → context，送达时由调用方清空背景", () => {
    expect(routeFeishuMessage(msg(), ctx({ mode: "shared" }))).toEqual({ kind: "context", line: { name: "张三", role: "owner", text: "看看登录页", at: 100 } });
    expect(routeFeishuMessage(msg({ senderOpenId: GUEST }), ctx({ mode: "shared", speakerName: "李四" }))).toEqual({
      kind: "context",
      line: { name: "李四", role: "guest", text: "看看登录页", at: 100 },
    });
  });

  it("observer 档访客的话 @机器人 也不唤醒，记成背景 → context", () => {
    const route = routeFeishuMessage(msg({ senderOpenId: GUEST, mentionedBot: true }), ctx({ mode: "shared", guestTier: "observer", speakerName: "李四" }));
    expect(route).toEqual({ kind: "context", line: { name: "李四", role: "guest", text: "看看登录页", at: 100 } });
  });

  it("访客以“/”开头的话 → reject", () => {
    expect(routeFeishuMessage(msg({ senderOpenId: GUEST, mentionedBot: true, text: "/clear" }), ctx({ mode: "shared" }))).toMatchObject({ kind: "reject", openId: GUEST });
    expect(routeFeishuMessage(msg({ mentionedBot: true, text: "/compact" }), ctx({ mode: "shared" }))).toMatchObject({ kind: "deliver" });
  });

  it("chat_only 档访客带的文件不收，droppedFiles 记个数；collaborator 档收", () => {
    const files = [{ type: "image" as const, fileKey: "img_1", fileName: null }];
    const input = msg({ senderOpenId: GUEST, mentionedBot: true, files });
    expect(routeFeishuMessage(input, ctx({ mode: "shared", guestTier: "chat_only" }))).toMatchObject({ kind: "deliver", files: [], droppedFiles: 1 });
    expect(routeFeishuMessage(input, ctx({ mode: "shared", guestTier: "collaborator" }))).toMatchObject({ kind: "deliver", files, droppedFiles: 0 });
  });

  it("话题里的话 → ignore；记录已归档（群已解散）的迟到事件 → ignore", () => {
    expect(routeFeishuMessage(msg({ inThread: true }), ctx())).toEqual({ kind: "ignore" });
    expect(routeFeishuMessage(msg(), ctx({ binding: { target: { kind: "pm", pmId: 7 }, archived: true } }))).toEqual({ kind: "ignore" });
  });
});

describe("routeFeishuAction", () => {
  const action = (patch: Partial<FeishuInboundAction> = {}): FeishuInboundAction => ({
    messageId: "om_card" as FeishuMessageId,
    chatId: "oc_pm" as FeishuChatId,
    operatorOpenId: OWNER,
    value: { kind: "choose", card: { kind: "ask", askMessageId: 3 }, optionIndex: 1 },
    note: "就这样",
    ...patch,
  });
  const actx = (patch: Partial<Pick<FeishuRoutingContext, "ownerOpenId" | "binding" | "guestTier">> = {}) => ({
    ownerOpenId: OWNER,
    binding: { target: { kind: "pm" as const, pmId: 7 }, archived: false },
    guestTier: "chat_only" as const,
    ...patch,
  });

  it("主人点选项 → answer；同一次点击重投得到同一个 clientId", () => {
    const a = routeFeishuAction(action(), actx());
    expect(a).toMatchObject({ kind: "answer", card: { kind: "ask", askMessageId: 3 }, optionIndex: 1, note: "就这样", byOpenId: OWNER });
    expect(routeFeishuAction(action(), actx())).toEqual(a);
    const elsewhere = routeFeishuAction(action({ messageId: "om_router" as FeishuMessageId }), actx());
    expect((elsewhere as { clientId: string }).clientId).not.toBe((a as { clientId: string }).clientId);
  });

  it("chat_only 档访客点选项、停止 → reject 并给 toast；collaborator 档访客能点", () => {
    const guestChoose = action({ operatorOpenId: GUEST });
    const guestStop = action({ operatorOpenId: GUEST, value: { kind: "stop", conversationId: 1 } });
    expect(routeFeishuAction(guestChoose, actx())).toEqual({ kind: "reject", toast: "只有主人能拍板" });
    expect(routeFeishuAction(guestStop, actx())).toEqual({ kind: "reject", toast: "只有主人能停止" });
    expect(routeFeishuAction(guestChoose, actx({ guestTier: "collaborator" }))).toMatchObject({ kind: "answer", byOpenId: GUEST });
    expect(routeFeishuAction(guestStop, actx({ guestTier: "collaborator" }))).toEqual({ kind: "stop", target: { kind: "pm", pmId: 7 } });
  });

  it("set_policy 只认主人，访客点 → reject", () => {
    const value = { kind: "set_policy" as const, pmId: 7, guestTier: "observer" as const };
    expect(routeFeishuAction(action({ value }), actx())).toEqual({ kind: "set_policy", pmId: 7, guestTier: "observer" });
    expect(routeFeishuAction(action({ value, operatorOpenId: GUEST }), actx({ guestTier: "collaborator" }))).toMatchObject({ kind: "reject" });
  });

  it("还没认主人 → ignore", () => {
    expect(routeFeishuAction(action(), actx({ ownerOpenId: null }))).toEqual({ kind: "ignore" });
  });
});

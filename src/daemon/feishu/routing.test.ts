import { describe, expect, it } from "vitest";
import type { FeishuChatId, FeishuMessageId, FeishuOpenId } from "../../shared/feishu.ts";
import type { FeishuInbound, FeishuInboundAction } from "./inbound.ts";
import { feishuWakes, GUEST_NO_FILES, OWNER_ONLY_SETTINGS_CARD, routeFeishuAction, routeFeishuMessage, type FeishuRoutingContext } from "./routing.ts";

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
  pendingFiles: [],
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

  it("keeps an observer's bare mention quiet even when there is earlier discussion", () => {
    const message = msg({ senderOpenId: GUEST, mentionedBot: true, text: "" });
    const policy = ctx({
      mode: "shared",
      guestTier: "observer",
      pendingContext: [{ name: "张三", role: "owner", text: "等会", at: 90 }],
    });
    expect(routeFeishuMessage(message, policy)).toEqual({ kind: "ignore" });
    expect(routeFeishuMessage({ ...message, inThread: true }, policy)).toEqual({ kind: "ignore" });
  });

  it("wakes with earlier discussion and a nonempty body when the mention has no new text", () => {
    const pendingContext = [{ name: "张三", role: "owner" as const, text: "等会", at: 90 }];
    expect(routeFeishuMessage(msg({ mentionedBot: true, text: "" }), ctx({ mode: "shared", pendingContext }))).toMatchObject({
      kind: "deliver",
      text: "（@机器人，请看上面的讨论）",
      origin: { context: pendingContext },
      files: [],
    });
  });

  it("answers a bare mention without context and ignores unmentioned empty input", () => {
    expect(routeFeishuMessage(msg({ mentionedBot: true, text: "" }), ctx({ mode: "shared" }))).toEqual({
      kind: "hint",
      text: "我在，直接 @我 后面说事就行。",
    });
    expect(routeFeishuMessage(msg({ text: "" }), ctx())).toEqual({ kind: "ignore" });
  });

  it("访客以“/”开头的话 → reject", () => {
    expect(routeFeishuMessage(msg({ senderOpenId: GUEST, mentionedBot: true, text: "/clear" }), ctx({ mode: "shared" }))).toMatchObject({ kind: "reject", openId: GUEST });
    expect(routeFeishuMessage(msg({ mentionedBot: true, text: "/compact" }), ctx({ mode: "shared" }))).toMatchObject({ kind: "deliver" });
  });

  it("chat_only 档访客带的文件不收，droppedFiles 记个数；collaborator 档收", () => {
    const files = [{ type: "image" as const, fileKey: "img_1", fileName: null }];
    const input = msg({ senderOpenId: GUEST, mentionedBot: true, files });
    expect(routeFeishuMessage(input, ctx({ mode: "shared", guestTier: "chat_only" }))).toMatchObject({ kind: "deliver", files: [], droppedFiles: 1 });
    expect(routeFeishuMessage(input, ctx({ mode: "shared", guestTier: "collaborator" }))).toMatchObject({
      kind: "deliver",
      files: [{ messageId: "om_1", file: files[0] }],
      droppedFiles: 0,
    });
  });

  describe("多人群里文件气泡带不了 @：前面没唤醒的气泡里的文件随下一次 @机器人 交出", () => {
    const image = { type: "image" as const, fileKey: "img_0", fileName: null };
    const doc = { type: "file" as const, fileKey: "file_g", fileName: "brief.pdf" };
    const ownerImage = { messageId: "om_0" as FeishuMessageId, speaker: OWNER, file: image, at: 90 };
    const guestDoc = { messageId: "om_g" as FeishuMessageId, speaker: GUEST, file: doc, at: 95 };
    const mentionOnly = { mode: "shared" as const, triggerMode: "mention_only" as const, pendingFiles: [ownerImage, guestDoc] };

    it("主人 @机器人：主人前面发的图一起交出；仅对话档访客发的文件不交", () => {
      expect(routeFeishuMessage(msg({ mentionedBot: true, text: "照图里的写一版" }), ctx(mentionOnly))).toMatchObject({
        kind: "deliver",
        text: "照图里的写一版",
        files: [{ messageId: "om_0", file: image }],
        droppedFiles: 0,
      });
    });

    it("协作者档：访客前面发的文件也交出，先后照发的顺序，本条带的文件排最后", () => {
      const own = { type: "image" as const, fileKey: "img_1", fileName: null };
      const route = routeFeishuMessage(msg({ mentionedBot: true, files: [own] }), ctx({ ...mentionOnly, guestTier: "collaborator" }));
      expect(route).toMatchObject({
        kind: "deliver",
        files: [
          { messageId: "om_0", file: image },
          { messageId: "om_g", file: doc },
          { messageId: "om_1", file: own },
        ],
        droppedFiles: 0,
      });
    });

    it("仅对话档访客 @机器人：自己前面发的文件按档位不收，droppedFiles 记上；主人发的照交", () => {
      const route = routeFeishuMessage(msg({ senderOpenId: GUEST, mentionedBot: true, text: "看我刚发的" }), ctx({ ...mentionOnly, speakerName: "李四" }));
      expect(route).toMatchObject({ kind: "deliver", files: [{ messageId: "om_0", file: image }], droppedFiles: 1 });
    });

    it("passes earlier files when the next bubble only mentions the bot", () => {
      expect(routeFeishuMessage(msg({ mentionedBot: true, text: "" }), ctx(mentionOnly))).toMatchObject({
        kind: "deliver",
        text: "",
        files: [{ messageId: "om_0", file: image }],
      });
    });

    it("仅对话档访客只 @机器人、前面只有自己发的文件：回他一句文件不收，不投空消息", () => {
      const route = routeFeishuMessage(msg({ senderOpenId: GUEST, mentionedBot: true, text: "" }), ctx({
        ...mentionOnly,
        pendingFiles: [guestDoc],
        pendingContext: [{ name: "李四", role: "guest", text: "（发了文件）", at: 95 }],
      }));
      expect(route).toEqual({ kind: "reject", openId: GUEST, reason: GUEST_NO_FILES, guestDenied: true });
    });

    it("delivers earlier discussion and sheds a guest file they cannot submit", () => {
      const pendingContext = [{ name: "李四", role: "guest" as const, text: "先看注册页", at: 80 }];
      const route = routeFeishuMessage(msg({ senderOpenId: GUEST, mentionedBot: true, text: "" }), ctx({
        ...mentionOnly, pendingContext, pendingFiles: [guestDoc],
      }));
      expect(route).toMatchObject({ kind: "deliver", origin: { context: pendingContext }, files: [], droppedFiles: 1 });
    });

    it("没唤醒的文件气泡仍记成背景“（发了文件）”，文件留给下一次唤醒", () => {
      const route = routeFeishuMessage(msg({ text: "", files: [image] }), ctx(mentionOnly));
      expect(route).toEqual({ kind: "context", line: { name: "张三", role: "owner", text: "（发了文件）", at: 100 } });
    });
  });

  it("仅对话档访客的文件不收时，回的那句告诉主人去「群设置」卡切到协作者", () => {
    expect(GUEST_NO_FILES).toContain("群设置");
    expect(GUEST_NO_FILES).toContain("协作者");
  });

  it("话题里的话 → ignore；记录已归档（群已解散）的迟到事件 → ignore", () => {
    expect(routeFeishuMessage(msg({ inThread: true }), ctx())).toEqual({ kind: "ignore" });
    expect(routeFeishuMessage(msg(), ctx({ binding: { target: { kind: "pm", pmId: 7 }, archived: true } }))).toEqual({ kind: "ignore" });
  });
});

describe("群设置命令（只认带斜杠的整句，不碰自然语言）", () => {
  const shared = { mode: "shared" as const };
  const slashCommands = ["/群设置", "/设置", "/policy", "/model", "/settings"] as const;

  it("主人发「设置」「模型」「权限」「群设置」这类不带斜杠的话：项目群和单聊都照常交给账本/总助，绝不误拦", () => {
    for (const text of ["设置", "模型", "权限", "群设置", "policy", "model", "settings", "设置一下", "帮我看看群设置"]) {
      expect(routeFeishuMessage(msg({ text }), ctx())).toMatchObject({ kind: "deliver", text });
      expect(routeFeishuMessage(msg({ text, mentionedBot: true }), ctx(shared))).toMatchObject({ kind: "deliver", text });
      expect(routeFeishuMessage(msg({ chatType: "p2p", text }), ctx())).toMatchObject({ kind: "deliver", target: { kind: "router" }, text });
    }
  });

  it("主人发 /群设置、/设置、/policy、/model、/settings（去掉 @ 后整句）：项目群和总助单聊都叫出设置卡，不进账本", () => {
    for (const cmd of slashCommands) {
      for (const text of [cmd, ` ${cmd} `, `${cmd}\n`]) {
        expect(routeFeishuMessage(msg({ text }), ctx())).toEqual({ kind: "settings_card" });
        expect(routeFeishuMessage(msg({ text }), ctx(shared))).toEqual({ kind: "settings_card" });
        expect(routeFeishuMessage(msg({ text, mentionedBot: true }), ctx(shared))).toEqual({ kind: "settings_card" });
        expect(routeFeishuMessage(msg({ chatType: "p2p", text }), ctx())).toEqual({ kind: "settings_card" });
      }
    }
  });

  it("斜杠命令后面还带了字、带了文件，或大小写不同：不算群设置命令", () => {
    expect(routeFeishuMessage(msg({ text: "/群设置 改成协作者" }), ctx())).toMatchObject({ kind: "deliver" });
    expect(routeFeishuMessage(msg({ text: "/model sonnet" }), ctx())).toMatchObject({ kind: "deliver" });
    expect(routeFeishuMessage(msg({ text: "/Policy" }), ctx())).toMatchObject({ kind: "deliver" });
    const files = [{ type: "image" as const, fileKey: "img_1", fileName: null }];
    expect(routeFeishuMessage(msg({ text: "/群设置", files }), ctx())).toMatchObject({ kind: "deliver" });
  });

  it("访客发任意设置斜杠命令：回他只有主人能叫，@ 不 @、哪一档都一样", () => {
    for (const guestTier of ["chat_only", "collaborator", "observer"] as const) {
      for (const mentionedBot of [false, true]) {
        for (const text of slashCommands) {
          expect(routeFeishuMessage(msg({ senderOpenId: GUEST, text, mentionedBot }), ctx({ ...shared, guestTier }))).toEqual({
            kind: "reject",
            openId: GUEST,
            reason: OWNER_ONLY_SETTINGS_CARD,
          });
        }
      }
    }
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
    expect(routeFeishuAction(guestChoose, actx())).toEqual({ kind: "reject", toast: "只有主人能拍板", guestDenied: true });
    expect(routeFeishuAction(guestStop, actx())).toEqual({ kind: "reject", toast: "只有主人能停止", guestDenied: true });
    const guestDone = action({ operatorOpenId: GUEST, value: { kind: "blocker_done", card: { kind: "blocker", askMessageId: 3, blockerId: 1 } } });
    expect(routeFeishuAction(guestDone, actx())).toEqual({ kind: "reject", toast: "只有主人能拍板", guestDenied: true });
    expect(routeFeishuAction(guestChoose, actx({ guestTier: "collaborator" }))).toMatchObject({ kind: "answer", byOpenId: GUEST });
    expect(routeFeishuAction(guestStop, actx({ guestTier: "collaborator" }))).toEqual({ kind: "stop", target: { kind: "pm", pmId: 7 } });
  });

  it("set_policy 只认主人，访客点 → reject", () => {
    const value = { kind: "set_policy" as const, pmId: 7, guestTier: "observer" as const };
    expect(routeFeishuAction(action({ value }), actx())).toEqual({ kind: "set_policy", pmId: 7, guestTier: "observer" });
    expect(routeFeishuAction(action({ value, operatorOpenId: GUEST }), actx({ guestTier: "collaborator" }))).toEqual({ kind: "reject", toast: "只有主人能改设置" });
  });

  it("set_pm_model 与 set_router_model 只认主人，访客（含协作者）点下拉 → reject", () => {
    const pmValue = { kind: "set_pm_model" as const, pmId: 7, field: "vendor" as const };
    expect(routeFeishuAction(action({ value: pmValue, option: "codex" }), actx())).toEqual({ kind: "set_pm_model", pmId: 7, field: "vendor", option: "codex" });
    expect(routeFeishuAction(action({ value: pmValue, option: "codex", operatorOpenId: GUEST }), actx({ guestTier: "collaborator" }))).toEqual({
      kind: "reject",
      toast: "只有主人能改设置",
    });

    const routerCtx = { ownerOpenId: OWNER, binding: { target: { kind: "router" as const }, archived: false }, guestTier: "collaborator" as const };
    const routerValue = { kind: "set_router_model" as const, field: "model" as const };
    expect(routeFeishuAction(action({ value: routerValue, option: "gpt-6-luna" }), routerCtx)).toEqual({
      kind: "set_router_model",
      field: "model",
      option: "gpt-6-luna",
    });
    expect(routeFeishuAction(action({ value: routerValue, option: "gpt-6-luna", operatorOpenId: GUEST }), routerCtx)).toEqual({
      kind: "reject",
      toast: "只有主人能改设置",
    });
  });

  it("还没认主人 → ignore", () => {
    expect(routeFeishuAction(action(), actx({ ownerOpenId: null }))).toEqual({ kind: "ignore" });
  });
});

import { describe, expect, it } from "vitest";
import type { AskMeta, Message } from "../../shared/domain.ts";
import type { FeishuChatId } from "../../shared/feishu.ts";
import { ASK_MAX_OPTION_CHARS, ASK_MAX_OPTIONS, FEISHU_CARD_MAX_BYTES, MAX_DECISION_CHOICE_CHARS, MAX_DECISION_NOTE_CHARS } from "../../shared/limits.ts";
import type { RouterDecisionItem, RouterReportItem } from "../../shared/router.ts";
import {
  decodeFeishuActionValue,
  encodeFeishuActionValue,
  FEISHU_NOTE_FIELD,
  FEISHU_STOP_ELEMENT_ID,
  FEISHU_STREAM_ELEMENT_ID,
  renderAskCard,
  renderChatPolicyCard,
  renderReplyCard,
  renderRouterItem,
  type FeishuActionValue,
  type FeishuCardJson,
} from "./cards.ts";

type El = Record<string, unknown>;

function walk(card: FeishuCardJson): El[] {
  const out: El[] = [];
  const visit = (els: El[]) => {
    for (const el of els) {
      out.push(el);
      if (Array.isArray(el.elements)) visit(el.elements as El[]);
      if (Array.isArray(el.columns)) visit(el.columns as El[]);
    }
  };
  visit(card.body.elements);
  return out;
}
const buttons = (card: FeishuCardJson) => walk(card).filter((el) => el.tag === "button");
const callbackButtons = (card: FeishuCardJson) =>
  buttons(card).filter((b) => (b.behaviors as { type: string }[]).some((x) => x.type === "callback"));
const valueOf = (b: El) => decodeFeishuActionValue((b.behaviors as { type: string; value?: unknown }[]).find((x) => x.type === "callback")!.value);
const textOf = (b: El) => (b.text as { content: string }).content;
const allText = (card: FeishuCardJson) => JSON.stringify(card);

const message = (id: number, text: string, meta: AskMeta): Message => ({
  id,
  conversationId: 1,
  sessionId: 1,
  workerId: null,
  sender: "agent",
  kind: "text",
  text,
  meta: meta as unknown as Record<string, unknown>,
  collapsed: false,
  dedupeKey: `k${id}`,
  status: null,
  failureReason: null,
  createdAt: 1,
  updatedAt: 1,
});

const ALL_VALUES: FeishuActionValue[] = [
  { kind: "choose", card: { kind: "ask", askMessageId: 3 }, optionIndex: 1 },
  { kind: "choose", card: { kind: "gate", askMessageId: 3, graphId: 4, nodeKey: "impl" }, optionIndex: 0 },
  { kind: "choose", card: { kind: "router_item", itemId: 9 }, optionIndex: 2 },
  { kind: "submit_note", card: { kind: "ask", askMessageId: 5 } },
  { kind: "blocker_done", card: { kind: "blocker", askMessageId: 6, blockerId: 7 } },
  { kind: "stop", conversationId: 8 },
  { kind: "set_policy", pmId: 2, triggerMode: "mention_only" },
  { kind: "set_policy", pmId: 2, guestTier: "observer" },
];

describe("按钮值编解码", () => {
  it("每种 FeishuActionValue 编码后再解码深等于原值", () => {
    for (const value of ALL_VALUES) expect(decodeFeishuActionValue(encodeFeishuActionValue(value))).toEqual(value);
  });

  it("缺字段、类型不对、多出未知 kind 的值解码为 null", () => {
    const good = encodeFeishuActionValue({ kind: "stop", conversationId: 8 });
    expect(decodeFeishuActionValue({ ...good, conversationId: "8" })).toBeNull();
    expect(decodeFeishuActionValue({ ...good, kind: "explode" })).toBeNull();
    expect(decodeFeishuActionValue({ kind: "stop", conversationId: 8 })).toBeNull();
    expect(decodeFeishuActionValue({ ...encodeFeishuActionValue(ALL_VALUES[0]!), card: { kind: "ask" } })).toBeNull();
    expect(decodeFeishuActionValue({ ...encodeFeishuActionValue({ kind: "set_policy", pmId: 2, guestTier: "observer" }), guestTier: undefined })).toBeNull();
    expect(decodeFeishuActionValue(null)).toBeNull();
    expect(decodeFeishuActionValue("stop")).toBeNull();
  });
});

describe("renderAskCard", () => {
  const ask: AskMeta = { needsUser: true, options: ["方案 A", "方案 B", "方案 C"], recommended: "方案 B" };
  const msg = message(11, "选哪个方案？", ask);

  it("pending 时有补充说明输入框和选项按钮，推荐项排第一并标推荐，点哪个选项都连同输入框回传", () => {
    const c = renderAskCard(msg, ask, { kind: "pending" });
    const form = walk(c).find((el) => el.tag === "form")!;
    const formEls = form.elements as El[];
    expect(formEls.some((el) => el.tag === "input" && el.name === FEISHU_NOTE_FIELD)).toBe(true);
    const bs = callbackButtons(c);
    expect(bs.map(textOf)).toEqual(["方案 B（推荐）", "方案 A", "方案 C"]);
    expect(bs.map(valueOf)).toEqual([
      { kind: "choose", card: { kind: "ask", askMessageId: 11 }, optionIndex: 1 },
      { kind: "choose", card: { kind: "ask", askMessageId: 11 }, optionIndex: 0 },
      { kind: "choose", card: { kind: "ask", askMessageId: 11 }, optionIndex: 2 },
    ]);
    for (const b of bs) {
      expect(b.form_action_type).toBe("submit");
      expect(formEls).toContain(b);
    }
  });

  it("检查点卡是通过 / 打回，提醒卡是已处理", () => {
    const gate: AskMeta = { needsUser: true, gateRef: { graphId: 4, nodeKey: "impl", checkpoint: true } };
    const g = renderAskCard(message(12, "请确认", gate), gate, { kind: "pending" });
    expect(callbackButtons(g).map(textOf)).toEqual(["通过", "打回"]);
    expect(valueOf(callbackButtons(g)[1]!)).toEqual({ kind: "choose", card: { kind: "gate", askMessageId: 12, graphId: 4, nodeKey: "impl" }, optionIndex: 1 });
    const blocker: AskMeta = { needsUser: true, blockerRef: { blockerId: 7 } };
    const b = renderAskCard(message(13, "去登录", blocker), blocker, { kind: "pending" });
    expect(callbackButtons(b).map(textOf)).toEqual(["已处理"]);
    expect(valueOf(callbackButtons(b)[0]!)).toEqual({ kind: "blocker_done", card: { kind: "blocker", askMessageId: 13, blockerId: 7 } });
  });

  it("answered 时没有按钮，写明谁选了什么和补充说明；closed 时写明已关闭", () => {
    const a = renderAskCard(msg, ask, { kind: "answered", chosenOption: "方案 A", note: "先做 A", byName: "张三" });
    expect(buttons(a)).toEqual([]);
    expect(allText(a)).toContain("张三 选了「方案 A」");
    expect(allText(a)).toContain("先做 A");
    const c = renderAskCard(msg, ask, { kind: "closed" });
    expect(buttons(c)).toEqual([]);
    expect(allText(c)).toContain("已关闭");
  });

  it("卡片 schema 是 2.0，update_multi 为 true", () => {
    const c = renderAskCard(msg, ask, { kind: "pending" });
    expect(c.schema).toBe("2.0");
    expect(c.config.update_multi).toBe(true);
  });
});

describe("renderRouterItem", () => {
  const ask: AskMeta = { needsUser: true, options: ["要", "不要"] };
  const askMsg = message(21, "要不要上线？", ask);
  const decision = (patch: Partial<RouterDecisionItem> = {}): RouterDecisionItem => ({
    id: 31,
    kind: "decision",
    status: "pending",
    pmId: 1,
    projectId: null,
    conversationId: 1,
    question: "要不要上线？",
    context: "",
    options: ["要", "不要"],
    askMessageId: 21,
    resolution: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  });
  const chat = "oc_pm1" as FeishuChatId;

  it("带 ask 的拍板项和项目群那张卡的按钮值解码出同一个 FeishuCardRef，另有打开项目群的按钮", () => {
    const inRouter = renderRouterItem(decision(), { message: askMsg, meta: ask }, { kind: "pending" }, chat);
    const inGroup = renderAskCard(askMsg, ask, { kind: "pending" });
    expect(callbackButtons(inRouter).map(valueOf)).toEqual(callbackButtons(inGroup).map(valueOf));
    const link = buttons(inRouter).find((b) => textOf(b) === "打开项目群")!;
    expect(JSON.stringify(link.behaviors)).toContain("openChatId=oc_pm1");
  });

  it("带 ask 的拍板项定案后和 renderAskCard 一样写明结论、没有按钮", () => {
    const state = { kind: "answered" as const, chosenOption: "要", note: null, byName: "张三" };
    const inRouter = renderRouterItem(decision(), { message: askMsg, meta: ask }, state, null);
    expect(callbackButtons(inRouter)).toEqual([]);
    expect(inRouter.body.elements).toEqual(renderAskCard(askMsg, ask, state).body.elements);
  });

  it("没有 ask 的拍板项带 router_item 的选项按钮；简报只有摘要和打开项目群的按钮", () => {
    const d = renderRouterItem(decision({ askMessageId: null }), null, { kind: "pending" }, chat);
    expect(callbackButtons(d).map(valueOf)).toEqual([
      { kind: "choose", card: { kind: "router_item", itemId: 31 }, optionIndex: 0 },
      { kind: "choose", card: { kind: "router_item", itemId: 31 }, optionIndex: 1 },
    ]);
    const report: RouterReportItem = {
      id: 32,
      kind: "report",
      status: "unread",
      pmId: 1,
      projectId: null,
      conversationId: 1,
      summary: "登录页做完了",
      links: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const r = renderRouterItem(report, null, { kind: "pending" }, chat);
    expect(callbackButtons(r)).toEqual([]);
    expect(buttons(r).map(textOf)).toEqual(["打开项目群"]);
    expect(allText(r)).toContain("登录页做完了");
  });
});

describe("卡片体积", () => {
  const bytes = (c: FeishuCardJson) => Buffer.byteLength(JSON.stringify(c));
  const longText = "请看方案对比：\n" + "长文\"内容\\".repeat(4_000) + "\n最后一句";
  const options = Array.from({ length: ASK_MAX_OPTIONS }, (_, i) => `${i}`.padEnd(ASK_MAX_OPTION_CHARS, "选"));
  const ask: AskMeta = { needsUser: true, options, recommended: options[3]! };
  const msg = message(41, longText, ask);
  const answered = {
    kind: "answered" as const,
    chosenOption: "".padEnd(MAX_DECISION_CHOICE_CHARS, "定"),
    note: "".padEnd(MAX_DECISION_NOTE_CHARS, "注"),
    byName: "张三",
  };

  it("正文超长的提问卡扣掉按钮和定案说明后不超过 FEISHU_CARD_MAX_BYTES，按钮一个不少，写明去网页看全文", () => {
    for (const state of [{ kind: "pending" as const }, answered, { kind: "closed" as const }]) {
      const c = renderAskCard(msg, ask, state);
      expect(bytes(c)).toBeLessThanOrEqual(FEISHU_CARD_MAX_BYTES);
      expect(allText(c)).toContain("去网页看");
      expect(JSON.stringify(c.body.elements[0])).toContain("请看方案对比");
    }
    expect(callbackButtons(renderAskCard(msg, ask, { kind: "pending" }))).toHaveLength(ASK_MAX_OPTIONS);
  });

  it("总助单聊里引用超长提问卡的拍板项也不超过 FEISHU_CARD_MAX_BYTES，打开项目群按钮还在", () => {
    const item: RouterDecisionItem = {
      id: 51, kind: "decision", status: "pending", pmId: 1, projectId: null, conversationId: 1,
      question: "选哪个？", context: "", options: [], askMessageId: 41, resolution: null, createdAt: 1, updatedAt: 1,
    };
    for (const state of [{ kind: "pending" as const }, answered]) {
      const c = renderRouterItem(item, { message: msg, meta: ask }, state, "oc_pm1" as FeishuChatId);
      expect(bytes(c)).toBeLessThanOrEqual(FEISHU_CARD_MAX_BYTES);
      expect(buttons(c).map(textOf)).toContain("打开项目群");
    }
  });

  it("没超的正文原样放进卡片，不加提示", () => {
    const short = message(42, "短问题", ask);
    expect(renderAskCard(short, ask, { kind: "pending" }).body.elements[0]).toMatchObject({ tag: "markdown", content: "短问题" });
    expect(allText(renderAskCard(short, ask, { kind: "pending" }))).not.toContain("去网页看");
  });
});

describe("renderReplyCard", () => {
  it("streaming 为 true 时开流式模式，正文组件的 element_id 是 FEISHU_STREAM_ELEMENT_ID", () => {
    const c = renderReplyCard({ conversationId: 5, text: "你好\n世界", streaming: true, withStop: true });
    expect(c.config.streaming_mode).toBe(true);
    expect(c.config.streaming_config).toBeDefined();
    expect(walk(c).find((el) => el.element_id === FEISHU_STREAM_ELEMENT_ID)).toMatchObject({ tag: "markdown", content: "你好\n世界" });
    expect((c.config.summary as { content: string }).content).toBe("你好");
    expect(renderReplyCard({ conversationId: 5, text: "x", streaming: false, withStop: false }).config.streaming_mode).toBe(false);
  });

  it("withStop 时有停止按钮，按钮值解码为这个对话的 stop", () => {
    const c = renderReplyCard({ conversationId: 5, text: "x", streaming: true, withStop: true });
    const stop = buttons(c).find((b) => b.element_id === FEISHU_STOP_ELEMENT_ID)!;
    expect(valueOf(stop)).toEqual({ kind: "stop", conversationId: 5 });
    expect(buttons(renderReplyCard({ conversationId: 5, text: "x", streaming: false, withStop: false }))).toEqual([]);
  });
});

describe("renderChatPolicyCard（群设置卡：唤醒方式、群成员权限分两组）", () => {
  const policy = (patch: Partial<Parameters<typeof renderChatPolicyCard>[0]> = {}) =>
    renderChatPolicyCard({ pmId: 2, triggerMode: "auto", guestTier: "chat_only", mentionOnlyForced: false, ...patch });
  /** 卡片顶层元素按分割线切成几组。 */
  const groups = (card: FeishuCardJson): El[][] => {
    const out: El[][] = [[]];
    for (const el of card.body.elements) {
      if (el.tag === "hr") out.push([]);
      else out.at(-1)!.push(el);
    }
    return out;
  };
  const groupCard = (els: El[]): FeishuCardJson => ({ schema: "2.0", config: {}, body: { elements: els } });

  it("标题是“群设置”；唤醒方式在上、群成员权限在下，中间一条分割线，各组按钮只改各自那一项", () => {
    const c = policy();
    expect(JSON.stringify(c.header)).toContain("群设置");
    const [wake, members] = groups(c);
    expect(groups(c).length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(wake)).toContain("唤醒方式");
    expect(JSON.stringify(wake)).not.toContain("群成员权限");
    expect(JSON.stringify(members)).toContain("群成员权限");
    const wakeValues = callbackButtons(groupCard(wake!)).map(valueOf);
    const tierValues = callbackButtons(groupCard(members!)).map(valueOf);
    expect(wakeValues).toEqual([
      { kind: "set_policy", pmId: 2, triggerMode: "auto" },
      { kind: "set_policy", pmId: 2, triggerMode: "mention_only" },
    ]);
    expect(tierValues).toEqual([
      { kind: "set_policy", pmId: 2, guestTier: "collaborator" },
      { kind: "set_policy", pmId: 2, guestTier: "chat_only" },
      { kind: "set_policy", pmId: 2, guestTier: "observer" },
    ]);
  });

  it("三档各有一句直白说明：协作者能发文件、点拍板和停止；仅对话不收文件；只读只旁听", () => {
    const members = JSON.stringify(groups(policy())[1]);
    expect(members).toMatch(/协作者[^"]*可对话、发文件、点拍板卡与停止/);
    expect(members).toMatch(/仅对话[^"]*只能文字聊天，不收文件/);
    expect(members).toMatch(/只读[^"]*只旁听，@机器人 也不唤醒/);
  });

  it("当前生效的那项按钮是 primary 且带 ✓，别的是 default、不带 ✓；当前项不禁用", () => {
    const c = policy({ triggerMode: "mention_only", guestTier: "collaborator" });
    const bs = callbackButtons(c);
    const chosen = bs.filter((b) => b.type === "primary");
    expect(chosen.map(valueOf)).toEqual([
      { kind: "set_policy", pmId: 2, triggerMode: "mention_only" },
      { kind: "set_policy", pmId: 2, guestTier: "collaborator" },
    ]);
    for (const b of chosen) expect(textOf(b).startsWith("✓")).toBe(true);
    for (const b of bs.filter((x) => x.type !== "primary")) {
      expect(b.type).toBe("default");
      expect(textOf(b)).not.toContain("✓");
    }
    expect(bs.some((b) => b.disabled === true)).toBe(false);
  });

  it("每组写明当前生效的是哪一项", () => {
    const [wake, members] = groups(policy({ triggerMode: "mention_only", guestTier: "observer" }));
    expect(JSON.stringify(wake)).toMatch(/当前[^"]*仅 @ 唤醒/);
    expect(JSON.stringify(members)).toMatch(/当前[^"]*只读/);
  });

  it("卡底提示随时发 /群设置 叫出这张卡，只有主人能改", () => {
    const text = allText(policy());
    expect(text).toContain("/群设置");
    expect(text).toContain("只有主人能改");
  });

  it("mentionOnlyForced 时不给切回 auto，按仅 @ 唤醒画", () => {
    const c = policy({ mentionOnlyForced: true });
    const values = callbackButtons(c).map(valueOf);
    expect(values).not.toContainEqual({ kind: "set_policy", pmId: 2, triggerMode: "auto" });
    expect(values).toContainEqual({ kind: "set_policy", pmId: 2, triggerMode: "mention_only" });
    expect(callbackButtons(c).find((b) => b.type === "primary" && valueOf(b)?.kind === "set_policy" && "triggerMode" in valueOf(b)!)).toBeDefined();
  });
});

describe("卡片正文里的本机图片", () => {
  it("提问卡和简报卡的正文不带本机图片语法，飞书不会当成图片编号拒收", () => {
    const ask: AskMeta = { needsUser: true, options: ["要", "不要"] };
    const askCard = renderAskCard(message(31, "看图：![截图](/tmp/a.png)", ask), ask, { kind: "pending" });
    expect(allText(askCard)).not.toContain("](/tmp");
    expect(allText(askCard)).toContain("截图");
    const report = { id: 1, pmId: 1, kind: "report", summary: "![截图](/tmp/a.png) 做完了", status: "pending", createdAt: 1, updatedAt: 1 } as unknown as RouterReportItem;
    expect(allText(renderRouterItem(report, null, { kind: "pending" }, null))).not.toContain("](/tmp");
  });
});

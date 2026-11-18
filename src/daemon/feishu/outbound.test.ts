import { renderReplyCard } from "./cards.ts";
import { describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import type { Message, SessionState } from "../../shared/domain.ts";
import type { FeishuChatId } from "../../shared/feishu.ts";
import { FEISHU_CARD_MAX_CHARS, FEISHU_CATCHUP_MAX_MESSAGES } from "../../shared/limits.ts";
import type { RouterCommandRecord, RouterReportItem } from "../../shared/router.ts";
import { catchUpIntents, feishuMarkdownPrefix, projectFeishuChange, splitFeishuMarkdown, type FeishuProjectionContext } from "./outbound.ts";
import type { FeishuChatBinding } from "./store.ts";

const PM_CONV = 10;
const WORKER_CONV = 20;
const binding = { chatId: "oc_pm" as FeishuChatId } as FeishuChatBinding;
const ctx = (withRouter = true, awaitingUser = true): FeishuProjectionContext => ({
  chatOfConversation: (id) => (id === PM_CONV ? binding : null),
  routerChat: () => (withRouter ? ({ chatId: "oc_router" as FeishuChatId } as FeishuChatBinding) : null),
  pmOfConversation: (id) => (id === PM_CONV ? 1 : null),
  awaitingUser: () => awaitingUser,
});
let seq = 0;
const change = <T extends Change["type"]>(type: T, data: Extract<Change, { type: T }>["data"]): Change => ({ seq: ++seq, type, data }) as Change;
const message = (patch: Partial<Message> = {}): Message => ({
  id: 1,
  conversationId: PM_CONV,
  sessionId: 1,
  workerId: null,
  sender: "agent",
  kind: "text",
  text: "好的",
  meta: null,
  collapsed: false,
  dedupeKey: "session:1:u",
  status: null,
  failureReason: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});
const session = (patch: Partial<SessionState> = {}): SessionState => ({
  sessionId: 1,
  conversationId: PM_CONV,
  pmId: 1,
  generation: 1,
  status: "running",
  activity: "working",
  currentTool: null,
  rateLimit: null,
  lastEventAt: 1,
  ...patch,
});
const project = (c: Change, withRouter = true) => projectFeishuChange(c, ctx(withRouter));

describe("projectFeishuChange", () => {
  it("项目经理建了、改名、归档、删了 → sync_chats", () => {
    const pm = { id: 1, name: "小林" } as never;
    expect(project(change("pm.created", { pm }))).toEqual([{ kind: "sync_chats" }]);
    expect(project(change("pm.updated", { pm }))).toEqual([{ kind: "sync_chats" }]);
    expect(project(change("pm.removed", { pmId: 1 }))).toEqual([{ kind: "sync_chats" }]);
  });

  it("项目经理对话的流式预览 → stream；会话回到空闲 → turn_end", () => {
    expect(project(change("session.status", { session: session({ streamingText: "正在写" }) }))).toEqual([{ kind: "stream", conversationId: PM_CONV, text: "正在写" }]);
    expect(project(change("session.status", { session: session({ status: "idle" }) }))).toEqual([{ kind: "turn_end", conversationId: PM_CONV }]);
    expect(project(change("session.status", { session: session({ activity: "idle" }) }))).toEqual([{ kind: "turn_end", conversationId: PM_CONV }]);
    expect(project(change("session.status", { session: session({ conversationId: WORKER_CONV, streamingText: "x" }) }))).toEqual([]);
  });

  it("项目经理开轮在干活、还没出正文 → working，带一行状态；Worker、总助的会话不出", () => {
    expect(project(change("session.status", { session: session() }))).toEqual([{ kind: "working", conversationId: PM_CONV, status: "Working…" }]);
    expect(project(change("session.status", { session: session({ step: { type: "thinking" } }) }))).toEqual([{ kind: "working", conversationId: PM_CONV, status: "Thinking…" }]);
    expect(project(change("session.status", { session: session({ activity: "stopping" }) }))).toEqual([{ kind: "working", conversationId: PM_CONV, status: "Stopping…" }]);
    expect(project(change("session.status", { session: session({ pmId: null }) }))).toEqual([]);
    expect(project(change("session.status", { session: session({ pmId: null, streamingText: "x" }) }))).toEqual([]);
  });

  it("后台轮次（没有在等回复的用户消息）在干活不出 working，出正文照常 stream、结束照常 turn_end", () => {
    const background = ctx(true, false);
    expect(projectFeishuChange(change("session.status", { session: session() }), background)).toEqual([]);
    expect(projectFeishuChange(change("session.status", { session: session({ activity: "stopping" }) }), background)).toEqual([]);
    expect(projectFeishuChange(change("session.status", { session: session({ streamingText: "汇报来了" }) }), background)).toEqual([{ kind: "stream", conversationId: PM_CONV, text: "汇报来了" }]);
    expect(projectFeishuChange(change("session.status", { session: session({ activity: "idle" }) }), background)).toEqual([{ kind: "turn_end", conversationId: PM_CONV }]);
  });

  it("项目经理的文字消息 → agent_text，带它发的文件", () => {
    const files = [{ href: "a.png", path: "/x/a.png", id: "0123456789abcdef", name: "a.png", size: 1, mime: "image/png", status: "saved", mtime: 1 }];
    const m = message({ meta: { files } });
    const intents = project(change("message.created", { message: m }));
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ kind: "agent_text", conversationId: PM_CONV, message: m, files: [{ id: "0123456789abcdef", name: "a.png" }] });
  });

  it("提问卡 → ask_card；回答或关掉后 → ask_settled", () => {
    const ask = message({ meta: { needsUser: true, options: ["A", "B"] } });
    expect(project(change("message.created", { message: ask }))).toEqual([{ kind: "ask_card", conversationId: PM_CONV, message: ask, deliverables: [] }]);
    expect(project(change("message.updated", { message: ask }))).toEqual([]);
    const answered = message({ meta: { needsUser: true, options: ["A", "B"], answered: true, chosenOption: "A" } });
    expect(project(change("message.updated", { message: answered }))).toEqual([{ kind: "ask_settled", conversationId: PM_CONV, message: answered }]);
    const closed = message({ meta: { needsUser: true, closed: true, answered: true } });
    expect(project(change("message.updated", { message: closed }))).toMatchObject([{ kind: "ask_settled" }]);
  });

  it("网页发的用户消息 → mirror_user；从飞书来的（带 origin）不镜像", () => {
    const web = message({ sender: "user", dedupeKey: `client:${PM_CONV}:abc`, status: "queued" });
    expect(project(change("message.created", { message: web }))).toEqual([{ kind: "mirror_user", conversationId: PM_CONV, message: web }]);
    const fromFeishu = message({
      sender: "user",
      dedupeKey: `client:${PM_CONV}:feishu:om_1`,
      meta: { origin: { kind: "feishu", openId: "ou_a", name: "张三", role: "owner", mode: "solo", guestTier: "chat_only", context: [] } },
    });
    expect(project(change("message.created", { message: fromFeishu }))).toEqual([]);
    const wakeup = message({ sender: "user", dedupeKey: "router-resolve:1:2:c" });
    expect(project(change("message.created", { message: wakeup }))).toEqual([]);
  });

  it("工具调用、Worker 汇报行、Worker 对话、交接、只给人看的系统消息不出意图", () => {
    const quiet = [
      message({ kind: "tool", collapsed: true }),
      message({ kind: "worker", sender: "system", workerId: 3 }),
      message({ conversationId: WORKER_CONV, workerId: 3 }),
      message({ meta: { handover: true } }),
      message({ sender: "system", meta: { event: "project.created", projectId: 1 } }),
      message({ sender: "user", workerId: 3, dedupeKey: `client:${PM_CONV}:x` }),
    ];
    for (const m of quiet) expect(project(change("message.created", { message: m }))).toEqual([]);
  });

  it("总助卡片和指令结果出 router_item / router_command；没有对应会话的变化不出意图", () => {
    const item = { id: 1, kind: "report", summary: "做完了" } as RouterReportItem;
    expect(project(change("router.item.created", { item }))).toEqual([{ kind: "router_item", item }]);
    expect(project(change("router.item.updated", { item }))).toEqual([{ kind: "router_item", item }]);
    expect(project(change("router.item.created", { item }), false)).toEqual([]);
    const command = (status: RouterCommandRecord["status"]) => ({ id: 1, status }) as RouterCommandRecord;
    expect(project(change("router.command.updated", { command: command("answered") }))).toEqual([{ kind: "router_command", command: command("answered") }]);
    expect(project(change("router.command.updated", { command: command("planning") }))).toEqual([]);
    expect(project(change("router.command.updated", { command: command("failed") }), false)).toEqual([]);
    expect(project(change("health.updated", { health: { module: "store", consecutiveFailures: 0, lastError: null, updatedAt: 1 } }))).toEqual([]);
  });
});

describe("catchUpIntents", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => message({ id: i + 1, text: `第${i + 1}条` }));

  it("最多 FEISHU_CATCHUP_MAX_MESSAGES 条，取最新的，更早的记 omitted", () => {
    const { intents, omitted } = catchUpIntents(PM_CONV, many(FEISHU_CATCHUP_MAX_MESSAGES + 5));
    expect(intents).toHaveLength(FEISHU_CATCHUP_MAX_MESSAGES);
    expect(omitted).toBe(5);
    expect((intents[0] as { message: Message }).message.id).toBe(6);
  });

  it("lastMessageId 是给出消息里最大的编号；没有消息时是 null", () => {
    expect(catchUpIntents(PM_CONV, many(3)).lastMessageId).toBe(3);
    expect(catchUpIntents(PM_CONV, [])).toEqual({ intents: [], omitted: 0, lastMessageId: null });
  });
});

/** 去掉 splitFeishuMarkdown 在断点处补的闭合围栏和下一段开头补的打开围栏。 */
function joinBack(chunks: string[]): string {
  let out = "";
  let reopen: string | null = null;
  chunks.forEach((chunk, i) => {
    let body = chunk;
    if (reopen !== null) body = body.slice(body.indexOf("\n") + 1);
    reopen = null;
    const fence = /\n(`{3,}|~{3,})\n$/.exec(body)?.[1];
    const opened = fence === undefined ? null : openFence(out + body.slice(0, body.length - fence.length - 1));
    if (i < chunks.length - 1 && opened !== null) {
      body = body.slice(0, body.length - fence!.length - 1);
      reopen = opened;
    }
    out += body;
  });
  return out;
}
function openFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^(`{3,}|~{3,})/.exec(line);
    if (m === null) continue;
    open = open === null ? m[1]! : null;
  }
  return open;
}

describe("splitFeishuMarkdown", () => {
  it("不超过 FEISHU_CARD_MAX_CHARS 时原样一段；空正文返回空数组", () => {
    expect(splitFeishuMarkdown("短短一段")).toEqual(["短短一段"]);
    expect(splitFeishuMarkdown("字".repeat(FEISHU_CARD_MAX_CHARS))).toHaveLength(1);
    expect(splitFeishuMarkdown("")).toEqual([]);
  });

  it("优先在空行、换行处断，每段不超过上限", () => {
    const para = "这是一段话。".repeat(200);
    const text = Array.from({ length: 12 }, () => para).join("\n\n");
    const chunks = splitFeishuMarkdown(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect([...c].length).toBeLessThanOrEqual(FEISHU_CARD_MAX_CHARS);
    for (const c of chunks.slice(0, -1)) expect(c.endsWith("\n\n")).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("超长围栏和 JSON 转义文字分块后，每张卡的序列化体积都在上限内", () => {
    const text = `\`\`\`txt\n${"😀\u0000".repeat(FEISHU_CARD_MAX_CHARS)}\n\`\`\``;
    const chunks = splitFeishuMarkdown(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect([...chunk].length).toBeLessThanOrEqual(FEISHU_CARD_MAX_CHARS);
      expect(Buffer.byteLength(JSON.stringify(renderReplyCard({ conversationId: 1, text: chunk, streaming: true, withStop: true })))).toBeLessThanOrEqual(30_000);
    }
  });

  it("不在代码块中间断；必须断时补上闭合和重新打开的围栏，去掉补的围栏拼回等于原文", () => {
    const code = Array.from({ length: 1500 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const text = `前言\n\n\`\`\`ts\n${code}\n\`\`\`\n\n结尾`;
    const chunks = splitFeishuMarkdown(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect([...c].length).toBeLessThanOrEqual(FEISHU_CARD_MAX_CHARS);
      expect(openFence(c)).toBeNull();
    }
    expect(chunks[1]!.startsWith("```ts\n")).toBe(true);
    expect(joinBack(chunks)).toBe(text);
  });
});

describe("卡片里的本机图片和本机路径链接", () => {
  const reply = [
    "看结果：",
    "",
    "![总助长回复截图](/tmp/reverify/01.png)",
    "",
    "![](file:///tmp/reverify/02.png)",
    "",
    "- [复验报告](/tmp/reverify/report.md)",
    "- [官网](https://example.com)",
    "- ![远程图](https://example.com/x.png)",
    "- ![已上传](img_v3_abc)",
    "",
    "`![行内代码](/tmp/a.png)`",
  ].join("\n");
  const expected = [
    "看结果：",
    "",
    "图片「总助长回复截图」",
    "",
    "图片「02.png」",
    "",
    "- 复验报告",
    "- [官网](https://example.com)",
    "- [远程图](https://example.com/x.png)",
    "- ![已上传](img_v3_abc)",
    "",
    "`![行内代码](/tmp/a.png)`",
  ].join("\n");

  it("定稿分块时本机图片换成图片名、本机路径链接只留文字，网页链接、飞书图片和代码原样", () => {
    expect(splitFeishuMarkdown(reply)).toEqual([expected]);
  });

  it("流式推送的正文同样换掉", () => {
    expect(feishuMarkdownPrefix(reply)).toBe(expected);
  });

  it("链接文字里套着本机图片时两层都换掉", () => {
    expect(splitFeishuMarkdown("[![图](/tmp/a.png)](/tmp/a.png)")).toEqual(["图片「图」"]);
  });
});

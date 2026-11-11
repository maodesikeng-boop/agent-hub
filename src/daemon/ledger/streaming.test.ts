// 账本流式增量文字测试：零 SQLite 写入、首块立即推 + 窗口内节流合并、MAX_STREAMING_TEXT_CHARS 上限、
// 段完成/下一段/轮结束/退出/关账本原子清空无重影、子任务与后台写交接隔离、提醒状态引用稳定。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Change } from "../../shared/api.ts";
import type { ConversationId, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import {
  MAX_STREAMING_TEXT_CHARS,
  MIN_TOOL_STEP_VISIBLE_MS,
  PM_ARCHIVE_RETENTION_MS,
  STREAMING_TEXT_THROTTLE_MS,
} from "../../shared/limits.ts";
import { AGENT_VENDORS } from "../../shared/vendors.ts";
import { applyReminderChange, reminderStateFrom } from "../../shared/reminders.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createLedger, type SqliteLedger } from "./index.ts";

const INITIAL_SEQ = 10_000;
let db: Db;
let home: string;
let ledger: SqliteLedger;
let now: number;
let changes: Change[];
let conversationId: ConversationId;
let sessionId: SessionId;

beforeEach(() => {
  vi.useFakeTimers();
  db = openTestDb();
  home = mkdtempSync(join(tmpdir(), "agent-hub-streaming-"));
  now = 1_000;
  const created = createLedger(db, { now: () => now, pmHomeRoot: home }).createPm({
    name: "项目经理",
    mode: "manage_only",
    persona: "",
  });
  ledger = createLedger(db, { now: () => now, initialSeq: INITIAL_SEQ, pmHomeRoot: home });
  conversationId = created.conversation.id;
  sessionId = created.sessionId;
  createSessionStore(db, { now: () => now }).update(sessionId, { status: "running" });
  changes = [];
  ledger.onChange((c) => changes.push(c));
});

afterEach(() => {
  ledger.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
  vi.useRealTimers();
});

const ev = (event: DriverEvent) => ledger.applyDriverEvent(sessionId, event);
const count = (table: string) => db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;
const statusChanges = () => changes.flatMap((c) => (c.type === "session.status" ? [c.data.session] : []));

describe("ledger 流式文字（agent.text_delta）", () => {
  it("零 SQLite 写入，首块立即广播，节流窗口内合并后续增量并在到点后补发一次", () => {
    const msgBefore = count("messages");
    const stepsBefore = count("session_steps");

    ev({ type: "agent.text_delta", delta: "我先", at: now });
    // 首块 0ms 延迟立即推出去
    expect(statusChanges()).toHaveLength(1);
    expect(statusChanges()[0]).toMatchObject({
      sessionId,
      activity: "working",
      step: { type: "text" },
      streamingText: "我先",
    });

    // 同一节流窗口内连续来多块：不立即刷屏，合并在内存里
    now += 10;
    ev({ type: "agent.text_delta", delta: "查一下", at: now });
    now += 10;
    ev({ type: "agent.text_delta", delta: "代码。", at: now });
    expect(statusChanges()).toHaveLength(1);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.streamingText).toBe("我先查一下代码。");

    // 窗口到点：合并推一次最新全文
    now += STREAMING_TEXT_THROTTLE_MS;
    vi.advanceTimersByTime(STREAMING_TEXT_THROTTLE_MS);
    expect(statusChanges()).toHaveLength(2);
    expect(statusChanges()[1]?.streamingText).toBe("我先查一下代码。");

    // 全程 0 次 messages / session_steps 数据库写入
    expect(count("messages")).toBe(msgBefore);
    expect(count("session_steps")).toBe(stepsBefore);
  });

  it("agent.text 落库时同步取消节流定时器并原子清空 streamingText，不留双份重影", () => {
    ev({ type: "agent.text_delta", delta: "正在生成", at: now });
    now += 10;
    ev({ type: "agent.text_delta", delta: "下半句", at: now });
    changes.length = 0;

    // 节流定时器还没触发前，完整段落 agent.text 到达
    now += 5;
    ev({ type: "agent.text", uuid: "u-1", text: "正在生成下半句", at: now });

    expect(changes.map((c) => c.type)).toEqual(["message.created", "session.status"]);
    const statusAfter = statusChanges()[0]!;
    expect(statusAfter.streamingText).toBeUndefined();

    // 推进定时器：旧定时器已被取消，绝不会死灰复燃推回残留的 streamingText
    vi.advanceTimersByTime(STREAMING_TEXT_THROTTLE_MS * 3);
    expect(changes).toHaveLength(2);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.streamingText).toBeUndefined();
  });

  it("失效清理：agent.tool、agent.thinking、turn.ended、session.exited、context.compacted、ledger.close() 都会清掉残留流式状态与定时器", () => {
    const cases: Array<{ label: string; clear: () => void }> = [
      { label: "agent.tool", clear: () => ev({ type: "agent.tool", uuid: "t1", toolUseId: "tu1", name: "Read", input: { file_path: "/a.ts" }, at: now }) },
      { label: "agent.thinking", clear: () => ev({ type: "agent.thinking", uuid: "th1", at: now }) },
      { label: "turn.ended", clear: () => ev({ type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 50, at: now }) },
      { label: "session.exited", clear: () => ev({ type: "session.exited", reason: "interrupt", exitCode: 0, signal: null, hadResult: false, messageIds: [], at: now }) },
      { label: "context.compacted", clear: () => ev({ type: "context.compacted", uuid: "cp1", trigger: "manual", preTokens: 1000, postTokens: 200, at: now }) },
    ];

    for (const item of cases) {
      ev({ type: "agent.text_delta", delta: `段-${item.label}-1`, reset: true, at: (now += 100) });
      ev({ type: "agent.text_delta", delta: "-2", at: (now += 5) });
      item.clear();
      expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.streamingText, item.label).toBeUndefined();
      const countAfterClear = changes.length;
      vi.advanceTimersByTime(STREAMING_TEXT_THROTTLE_MS * 2);
      expect(changes.length, `${item.label} timer cancelled`).toBe(countAfterClear);
    }

    // ledger.close() 取消挂起的节流定时器
    ev({ type: "agent.text_delta", delta: "关机前首块", reset: true, at: (now += 100) });
    ev({ type: "agent.text_delta", delta: "关机前尾块", at: (now += 5) });
    const beforeClose = changes.length;
    ledger.close();
    vi.advanceTimersByTime(STREAMING_TEXT_THROTTLE_MS * 2);
    expect(changes.length).toBe(beforeClose);
  });

  it("停止后迟到的流式帧不能恢复预览或覆盖 stopping", () => {
    ev({ type: "agent.text_delta", delta: "正在输出", at: now });
    ledger.requestStop(conversationId);
    ev({ type: "agent.text_delta", delta: "停止后迟到", at: ++now });
    vi.advanceTimersByTime(STREAMING_TEXT_THROTTLE_MS * 2);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)).toMatchObject({ activity: "stopping" });
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.streamingText).toBeUndefined();
  });

  it("停止并 rewind 后迟到增量和待发定时器都不能恢复旧预览", () => {
    const id = ledger.postUserMessage({ conversationId, clientId: "rewind-stream", text: "查一下" }).messageId;
    ev({ type: "message.processing", messageIds: [id], at: now });
    ev({ type: "agent.text_delta", delta: "首块", at: now });
    ev({ type: "agent.text_delta", delta: "尾块", at: ++now });
    ledger.requestStop(conversationId);
    expect(ledger.rewindLastUserMessage(conversationId)?.id).toBe(id);
    ev({ type: "agent.text_delta", delta: "迟到旧回复", at: ++now });
    vi.advanceTimersByTime(STREAMING_TEXT_THROTTLE_MS * 2);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.streamingText).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("彻底删除会话立即取消待发流式定时器", () => {
    const pmId = ledger.snapshot().pms[0]!.id;
    ledger.archivePm(pmId);
    // 模拟归档时进程尚未退出的迟到输出。
    ev({ type: "agent.text_delta", delta: "首块", at: now });
    ev({ type: "agent.text_delta", delta: "尾块", at: ++now });
    expect(vi.getTimerCount()).toBe(1);
    ledger.purgeExpiredArchivedPms(now + PM_ARCHIVE_RETENTION_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("预览上限不劈开 emoji 代理对", () => {
    ev({ type: "agent.text_delta", delta: "中".repeat(MAX_STREAMING_TEXT_CHARS - 1) + "😀尾", at: now });
    const text = ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.streamingText;
    expect(text).toBe("中".repeat(MAX_STREAMING_TEXT_CHARS - 1) + "😀");
  });

  it("上限：单段流式文本超过 MAX_STREAMING_TEXT_CHARS 时截断内存预览前缀，最终 agent.text 仍完整入库", () => {
    const chunk = "中".repeat(5_000);
    for (let i = 0; i < 5; i++) {
      ev({ type: "agent.text_delta", delta: chunk, at: (now += 5) });
    }
    vi.advanceTimersByTime(STREAMING_TEXT_THROTTLE_MS * 2);
    const liveText = ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.streamingText ?? "";
    expect([...liveText].length).toBe(MAX_STREAMING_TEXT_CHARS);

    const fullText = chunk.repeat(5);
    ev({ type: "agent.text", uuid: "u-long", text: fullText, at: (now += 10) });
    const msg = ledger.snapshot().conversations.find((c) => c.conversation.id === conversationId)!.messages.at(-1)!;
    expect(msg.text.length).toBe(fullText.length);
  });

  it("子任务（带 parentToolUseId）与本会话隐藏写交接轮次不污染主会话流式预览", () => {
    // 1. 子任务增量被忽略
    ev({ type: "agent.text_delta", delta: "子代理输出", parentToolUseId: "toolu_sub", at: now });
    expect(statusChanges()).toHaveLength(0);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.streamingText).toBeUndefined();

    // 2. 本会话写交接轮次（messages 表存在 handover.requested 且 meta.writing = 1）不推流式预览
    db.run(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'system', 'text', '写交接', ?, ?, 'processing', ?, ?)`,
      conversationId,
      sessionId,
      JSON.stringify({ event: "handover.requested", writing: true }),
      `handover:${sessionId}`,
      now,
      now,
    );
    ev({ type: "agent.text_delta", delta: "这是后台交接草稿，用户不该看见", at: (now += 100) });
    vi.advanceTimersByTime(STREAMING_TEXT_THROTTLE_MS * 2);
    expect(statusChanges()).toHaveLength(0);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.streamingText).toBeUndefined();
  });

  it("applyReminderChange：纯流式文本更新不翻转提醒所看的 sessions 引用（防 ReminderWatcher 频繁重排定时器）", () => {
    ev({ type: "turn.started", at: now });
    let rem = reminderStateFrom(ledger.snapshot());
    const sessionsRef = rem.sessions;

    now += 100;
    changes.length = 0;
    ev({ type: "agent.text_delta", delta: "增量一", at: now });
    expect(changes).toHaveLength(1);
    rem = applyReminderChange(rem, changes[0]!);
    expect(rem.sessions).toBe(sessionsRef);
  });
});

describe("ledger 流式工具早捕获（agent.tool_preview）与快工具防闪没驻留（MIN_TOOL_STEP_VISIBLE_MS）", () => {
  it("6 家厂商早期工具预览零 SQLite 写入（Reading file → Reading foo.ts），正式 agent.tool 只入库一次且不重复插行", () => {
    for (const vendor of AGENT_VENDORS) {
      db.run("UPDATE agent_sessions SET vendor = ?, status = 'running' WHERE id = ?", vendor, sessionId);
      const msgBefore = count("messages");
      const stepsBefore = count("session_steps");
      changes.length = 0;

      // 1) 流式工具起点（仅有工具名，尚无路径）
      ev({ type: "agent.tool_preview", toolUseId: `tu-${vendor}`, name: "Read", input: {}, at: (now += 10) });
      expect(statusChanges().at(-1)?.step).toEqual({ type: "tool_use", name: "Read", input: {} });

      // 2) 流式参数增量拼出路径字段
      ev({
        type: "agent.tool_preview",
        toolUseId: `tu-${vendor}`,
        name: "Read",
        input: { file_path: `/repo/${vendor}/foo.ts` },
        at: (now += 20),
      });
      expect(statusChanges().at(-1)?.step).toEqual({
        type: "tool_use",
        name: "Read",
        input: { file_path: `/repo/${vendor}/foo.ts` },
      });

      // 预览阶段 0 次 SQLite 入库
      expect(count("messages"), `${vendor} preview messages`).toBe(msgBefore);
      expect(count("session_steps"), `${vendor} preview steps`).toBe(stepsBefore);

      // 3) 完整工具调用到达：仅入库 1 条 tool message 与 1 条 tool step
      ev({
        type: "agent.tool",
        uuid: `uuid-${vendor}`,
        toolUseId: `tu-${vendor}`,
        name: "Read",
        input: { file_path: `/repo/${vendor}/foo.ts` },
        at: (now += 10),
      });
      expect(count("messages") - msgBefore, `${vendor} tool message once`).toBe(1);
      const toolSteps = db.all<{ id: number }>(
        "SELECT id FROM session_steps WHERE session_id = ? AND kind = 'tool' AND tool_use_id = ?",
        sessionId,
        `tu-${vendor}`,
      );
      expect(toolSteps, `${vendor} session_steps once`).toHaveLength(1);

      now += MIN_TOOL_STEP_VISIBLE_MS + 10;
      ev({ type: "agent.tool_result", toolUseIds: [`tu-${vendor}`], at: now });
      ev({ type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 50, at: (now += 10) });
    }
  });

  it("已打开工具（如 ACP tool_call 空参入库后收到 tool_call_update 路径）经 agent.tool_preview 升级 openTools 文案且不重复入库", () => {
    const msgBefore = count("messages");
    ev({ type: "agent.tool", uuid: "acp-1", toolUseId: "tc-1", name: "read_file", input: {}, at: now });
    expect(statusChanges().at(-1)?.step).toEqual({ type: "tool_use", name: "read_file", input: {} });
    expect(count("messages")).toBe(msgBefore + 1);

    now += 30;
    ev({ type: "agent.tool_preview", toolUseId: "tc-1", name: "read_file", input: { path: "/repo/bar.ts" }, at: now });
    expect(statusChanges().at(-1)?.step).toEqual({ type: "tool_use", name: "read_file", input: { path: "/repo/bar.ts" } });
    expect(count("messages")).toBe(msgBefore + 1);
  });

  it("子任务（带 parentToolUseId）、隐藏写交接轮次与 stopping 忽略 agent.tool_preview", () => {
    ev({ type: "agent.tool_preview", name: "Bash", input: { command: "ls" }, parentToolUseId: "sub-1", at: now });
    expect(statusChanges()).toHaveLength(0);

    ev({ type: "turn.started", at: now });
    ledger.requestStop(conversationId);
    changes.length = 0;
    ev({ type: "agent.tool_preview", name: "Read", input: { file_path: "/a.ts" }, at: ++now });
    expect(statusChanges()).toHaveLength(0);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.activity).toBe("stopping");
  });

  it("快工具防闪没：耗时 < 450ms 的本地工具在 toolFinished 后保留工具文案满 MIN_TOOL_STEP_VISIBLE_MS 再回退 Thinking（含期间收到 agent.thinking）", () => {
    ev({ type: "agent.tool", uuid: "fast-1", toolUseId: "tu-fast", name: "Read", input: { file_path: "/ssd/fast.ts" }, at: now });
    expect(statusChanges().at(-1)?.step).toEqual({ type: "tool_use", name: "Read", input: { file_path: "/ssd/fast.ts" } });

    // 3ms 秒回结果：不足 450ms，保留 Reading fast.ts 并挂起唯一驻留定时器
    now += 3;
    vi.advanceTimersByTime(3);
    changes.length = 0;
    ev({ type: "agent.tool_result", toolUseIds: ["tu-fast"], at: now });
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.step).toEqual({
      type: "tool_use",
      name: "Read",
      input: { file_path: "/ssd/fast.ts" },
    });
    expect(vi.getTimerCount()).toBe(1);

    // 100ms 后下一轮模型发来 agent.thinking（缓存命中 TTFT 快）：不提前掐断驻留文案
    now += 100;
    vi.advanceTimersByTime(100);
    ev({ type: "agent.thinking", uuid: "th-next", at: now });
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.step).toEqual({
      type: "tool_use",
      name: "Read",
      input: { file_path: "/ssd/fast.ts" },
    });

    // 距工具显示 449ms 时仍在驻留
    const remaining = MIN_TOOL_STEP_VISIBLE_MS - 103;
    now += remaining - 1;
    vi.advanceTimersByTime(remaining - 1);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.step).toEqual({
      type: "tool_use",
      name: "Read",
      input: { file_path: "/ssd/fast.ts" },
    });

    // 满 450ms 到点：自动回退到 Thinking 并推送一次 session.status，定时器归零
    now += 1;
    changes.length = 0;
    vi.advanceTimersByTime(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(statusChanges()).toHaveLength(1);
    expect(statusChanges()[0]?.step).toEqual({ type: "thinking" });
  });

  it("慢工具（耗时 >= MIN_TOOL_STEP_VISIBLE_MS）在 toolFinished 时立即切回 Thinking，不额外挂定时器", () => {
    ev({ type: "agent.tool", uuid: "slow-1", toolUseId: "tu-slow", name: "Bash", input: { command: "sleep 1" }, at: now });
    now += MIN_TOOL_STEP_VISIBLE_MS;
    changes.length = 0;
    ev({ type: "agent.tool_result", toolUseIds: ["tu-slow"], at: now });
    expect(vi.getTimerCount()).toBe(0);
    expect(statusChanges().at(-1)?.step).toEqual({ type: "thinking" });
  });

  it("立即打断与清理铁律：驻留窗口内遇到新工具、text_delta、agent.text、turn.ended、stopping、session.exited、删会话、close() 立即清定时器且绝不诈尸 Thinking", () => {
    const armFastHold = (tag: string) => {
      ev({ type: "turn.started", at: (now += 10) });
      ev({ type: "agent.tool", uuid: `u-${tag}`, toolUseId: `t-${tag}`, name: "Read", input: { file_path: `/${tag}.ts` }, at: (now += 5) });
      now += 2;
      ev({ type: "agent.tool_result", toolUseIds: [`t-${tag}`], at: now });
      expect(vi.getTimerCount(), `${tag} hold armed`).toBe(1);
    };

    // 1. 新工具预览（agent.tool_preview）抢占
    armFastHold("preview");
    ev({ type: "agent.tool_preview", name: "Edit", input: { file_path: "/next.ts" }, at: (now += 10) });
    expect(vi.getTimerCount()).toBe(0);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.step).toEqual({
      type: "tool_use",
      name: "Edit",
      input: { file_path: "/next.ts" },
    });
    vi.advanceTimersByTime(MIN_TOOL_STEP_VISIBLE_MS * 2);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.step).toEqual({
      type: "tool_use",
      name: "Edit",
      input: { file_path: "/next.ts" },
    });
    ev({ type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 10, at: (now += 10) });

    // 2. 新正式工具（agent.tool）抢占
    armFastHold("tool");
    ev({ type: "agent.tool", uuid: "u-new", toolUseId: "t-new", name: "Bash", input: { command: "pwd" }, at: (now += 10) });
    expect(vi.getTimerCount()).toBe(0);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.step).toEqual({
      type: "tool_use",
      name: "Bash",
      input: {},
    });
    now += MIN_TOOL_STEP_VISIBLE_MS;
    vi.advanceTimersByTime(MIN_TOOL_STEP_VISIBLE_MS);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.step).toEqual({
      type: "tool_use",
      name: "Bash",
      input: {},
    });
    ev({ type: "agent.tool_result", toolUseIds: ["t-new"], at: now });
    ev({ type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 10, at: (now += 10) });

    // 3. 流式文字（agent.text_delta）切 Writing 抢占
    armFastHold("delta");
    ev({ type: "agent.text_delta", delta: "结论如下", reset: true, at: (now += 10) });
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.step).toEqual({ type: "text" });
    now += MIN_TOOL_STEP_VISIBLE_MS * 2;
    vi.advanceTimersByTime(MIN_TOOL_STEP_VISIBLE_MS * 2);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.step).toEqual({ type: "text" });
    ev({ type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 10, at: (now += 10) });

    // 4. 完整文字（agent.text）切 Writing 抢占
    armFastHold("text");
    ev({ type: "agent.text", uuid: "txt-1", text: "直接回复", at: (now += 10) });
    expect(vi.getTimerCount()).toBe(0);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.step).toEqual({ type: "text" });
    vi.advanceTimersByTime(MIN_TOOL_STEP_VISIBLE_MS * 2);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.step).toEqual({ type: "text" });
    ev({ type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 10, at: (now += 10) });

    // 5. turn.ended（idle）抢占，绝不诈尸回 Thinking
    armFastHold("ended");
    ev({ type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 10, at: (now += 10) });
    expect(vi.getTimerCount()).toBe(0);
    const changesAfterEnd = changes.length;
    vi.advanceTimersByTime(MIN_TOOL_STEP_VISIBLE_MS * 2);
    expect(changes.length).toBe(changesAfterEnd);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)).toMatchObject({ activity: "idle", step: null });

    // 6. requestStop（stopping）抢占
    armFastHold("stop");
    ledger.requestStop(conversationId);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(MIN_TOOL_STEP_VISIBLE_MS * 2);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.activity).toBe("stopping");
    ev({ type: "session.exited", reason: "interrupt", exitCode: 0, signal: null, hadResult: false, messageIds: [], at: (now += 10) });

    // 7. session.exited 抢占
    armFastHold("exited");
    ev({ type: "session.exited", reason: "crash", exitCode: 1, signal: null, hadResult: false, messageIds: [], at: (now += 10) });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(MIN_TOOL_STEP_VISIBLE_MS * 2);
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)).toMatchObject({ activity: "idle", step: null });

    // 8. ledger.close() 清空挂起驻留定时器
    armFastHold("close");
    const beforeClose = changes.length;
    ledger.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(MIN_TOOL_STEP_VISIBLE_MS * 2);
    expect(changes.length).toBe(beforeClose);
  });

  it("彻底删除归档 PM 会话（forgetSession）立即取消驻留定时器", () => {
    const pmId = ledger.snapshot().pms[0]!.id;
    ev({ type: "agent.tool", uuid: "u-del", toolUseId: "t-del", name: "Read", input: { file_path: "/del.ts" }, at: now });
    now += 2;
    ev({ type: "agent.tool_result", toolUseIds: ["t-del"], at: now });
    expect(vi.getTimerCount()).toBe(1);
    ev({ type: "session.exited", reason: "idle", exitCode: 0, signal: null, hadResult: true, messageIds: [], at: ++now });
    expect(vi.getTimerCount()).toBe(0);

    // 再模拟退出后迟到乱序事件挂起定时器，purge 时同样清零
    ev({ type: "agent.tool", uuid: "u-del2", toolUseId: "t-del2", name: "Read", input: { file_path: "/del2.ts" }, at: ++now });
    ev({ type: "agent.tool_result", toolUseIds: ["t-del2"], at: ++now });
    expect(vi.getTimerCount()).toBe(1);
    ledger.archivePm(pmId);
    ledger.purgeExpiredArchivedPms(now + PM_ARCHIVE_RETENTION_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
});

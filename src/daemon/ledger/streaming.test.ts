// 账本流式增量文字测试：零 SQLite 写入、首块立即推 + 窗口内节流合并、MAX_STREAMING_TEXT_CHARS 上限、
// 段完成/下一段/轮结束/退出/关账本原子清空无重影、子任务与后台写交接隔离、提醒状态引用稳定。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Change } from "../../shared/api.ts";
import type { ConversationId, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { MAX_STREAMING_TEXT_CHARS, PM_ARCHIVE_RETENTION_MS, STREAMING_TEXT_THROTTLE_MS } from "../../shared/limits.ts";
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

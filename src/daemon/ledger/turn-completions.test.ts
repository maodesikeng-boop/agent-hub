import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyActionRow } from "../../shared/actions.ts";
import type { Change } from "../../shared/api.ts";
import { systemEventOf } from "../../shared/domain.ts";
import type { ConversationId, MessageId, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { TURN_COMPLETION_RETRY_MAX_MS } from "../../shared/limits.ts";
import { replyIdOf } from "../../shared/turn-reply.ts";
import { listActions } from "../actions/index.ts";
import { createSessionSendHandler } from "../handlers.ts";
import type { LocalLink } from "../sent-files.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createDriverEventDrain } from "./driver-events.ts";
import { createLedger } from "./index.ts";
import type { SqliteLedger } from "./index.ts";
import { NO_TURN_FACTS, type createTurnCompletionLedger } from "./turn-completions.ts";

type TurnEnded = Extract<DriverEvent, { type: "turn.ended" }>;

let db: Db;
let home: string;
let ledger: SqliteLedger;
let now: number;
let changes: Change[];
let conversationId: ConversationId;
let sessionId: SessionId;

const openLedger = () => {
  const opened = createLedger(db, { now: () => now, pmHomeRoot: home });
  opened.onChange((c) => changes.push(c));
  return opened;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  db = openTestDb();
  home = mkdtempSync(join(tmpdir(), "agent-hub-turn-completions-"));
  now = 1_000;
  changes = [];
  ledger = openLedger();
  const created = ledger.createPm({ name: "项目经理", mode: "manage_only", persona: "" });
  conversationId = created.conversation.id;
  sessionId = created.sessionId;
  changes = [];
});

afterEach(() => {
  ledger.close();
  db.close();
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

const post = (text: string, conversation = conversationId) =>
  ledger.postUserMessage({ conversationId: conversation, clientId: text, text }).messageId;

const ev = (event: DriverEvent, sid = sessionId) => ledger.applyDriverEvent(sid, event);

function startTurn(id: MessageId, sid = sessionId): void {
  ev({ type: "message.delivered", at: now, messageIds: [id] }, sid);
  ev({ type: "message.processing", at: now, messageIds: [id] }, sid);
}

const say = (uuid: string, text: string, sid = sessionId) => ev({ type: "agent.text", uuid, text, at: now }, sid);

const end = (messageIds: MessageId[], extra: Partial<TurnEnded> = {}, sid = sessionId) =>
  ev({ type: "turn.ended", ok: true, interrupted: false, messageIds, durationMs: 1, at: now, ...extra }, sid);

const FAILED = { ok: false, error: { subtype: "error_during_execution", message: "boom" } } as const;

const failOn = (name: string, when: string) => db.exec(`CREATE TRIGGER ${name} ${when} BEGIN SELECT RAISE(ABORT, 'injected ${name}'); END`);
const failReplied = (id: MessageId) => failOn("fail_replied", `BEFORE UPDATE OF status ON messages WHEN NEW.id = ${id} AND NEW.status = 'replied'`);
const drop = (name: string) => db.exec(`DROP TRIGGER ${name}`);

function tick(ms = TURN_COMPLETION_RETRY_MAX_MS): void {
  now += ms;
  vi.advanceTimersByTime(ms);
}

const statusOf = (id: MessageId) => ledger.getMessage(id)?.status;
const receipts = (sid = sessionId) => db.get<{ n: number }>("SELECT count(*) AS n FROM turn_completions WHERE session_id = ?", sid)!.n;
const turnEnds = (sid = sessionId) =>
  db.all<{ outcome: string }>("SELECT outcome FROM session_steps WHERE session_id = ? AND kind = 'turn_ended' ORDER BY id", sid).map((r) => r.outcome);
const storeError = () => db.get<{ last_error: string | null }>("SELECT last_error FROM health WHERE module = 'store'")?.last_error ?? null;
const sendsFor = (id: MessageId) =>
  listActions(db).filter((a): a is Extract<AnyActionRow, { type: "session.send" }> => a.type === "session.send" && a.params.messageId === id);
const updatesOf = (id: MessageId) => changes.filter((c) => c.type === "message.updated" && c.data.message.id === id);
const activity = () => ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.activity;
const agentReply = () => db.get<{ id: MessageId }>("SELECT id FROM messages WHERE session_id = ? AND sender = 'agent' ORDER BY id DESC LIMIT 1", sessionId)!.id;

function restart(): void {
  ledger.close();
  ledger = openLedger();
  ledger.recoverAfterRestart();
}

function secondPm(): { conversationId: ConversationId; sessionId: SessionId } {
  const created = ledger.createPm({ name: "另一个项目经理", mode: "manage_only", persona: "" });
  return { conversationId: created.conversation.id, sessionId: created.sessionId };
}

describe("turn completion receipts", () => {
  it("records the same receipt before an earlier reply attachment finishes copying", async () => {
    const calls: string[] = [];
    let finishCopy: (meta: null) => void = () => {};
    const completions = {
      receive: (sid: SessionId, event: TurnEnded, facts: unknown) => {
        calls.push(`receive:${facts === null ? "deferred" : "head"}`);
        return { sequence: 7, sessionId: sid, event };
      },
      settle: (receipt: { sequence: number }) => {
        calls.push(`settle:${receipt.sequence}`);
        return { kind: "settled" as const };
      },
    } as unknown as ReturnType<typeof createTurnCompletionLedger>;
    const drain = createDriverEventDrain({
      completions,
      factsFor: () => {
        calls.push("facts");
        return NO_TURN_FACTS;
      },
      apply: (_sid, event) => calls.push(`apply:${event.type}`),
      localLinks: (text) => (text.includes("file") ? [{ href: text } as LocalLink] : []),
      textMetaFor: () => new Promise((resolve) => (finishCopy = resolve)),
      onOverflow: vi.fn(),
    });
    drain.push(sessionId, { type: "agent.text", uuid: "u", text: "file", at: 1 });
    drain.push(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [1], durationMs: 1, at: 2 });
    expect(calls).toEqual(["receive:deferred"]);
    finishCopy(null);
    await drain.wait();
    expect(calls).toEqual(["receive:deferred", "apply:agent.text", "facts", "settle:7"]);
  });

  it("settles after one SQLite abort on the replied transition without sending the request again", () => {
    const id = post("问题");
    startTurn(id);
    say("r1", "答复");
    failReplied(id);
    changes = [];
    end([id]);
    expect(statusOf(id)).toBe("processing");
    expect(receipts()).toBe(1);
    expect(updatesOf(id)).toEqual([]);
    expect(storeError()).toMatch(/Turn completion write failed: .*injected fail_replied/);

    drop("fail_replied");
    tick();
    expect(statusOf(id)).toBe("replied");
    expect(replyIdOf(ledger.getMessage(id)!)).toBe(agentReply());
    expect(receipts()).toBe(0);
    expect(turnEnds()).toEqual(["ok"]);
    expect(updatesOf(id)).toHaveLength(1);
    expect(sendsFor(id)).toHaveLength(1);
    expect(sendsFor(id)[0]!.params).not.toHaveProperty("resend");
    expect(storeError()).toBeNull();
  });

  it("retries the same receipt after its initial SQLite insert fails while the daemon stays up", () => {
    const id = post("问题");
    startTurn(id);
    say("r1", "答复");
    failOn("fail_receipt", "BEFORE INSERT ON turn_completions");
    end([id]);
    expect(receipts()).toBe(0);
    expect(statusOf(id)).toBe("processing");
    expect(ledger.waitsForTurnCompletion(sessionId)).toBe(true);

    drop("fail_receipt");
    tick();
    expect(statusOf(id)).toBe("replied");
    expect(ledger.waitsForTurnCompletion(sessionId)).toBe(false);
    expect(db.get("SELECT seq FROM sqlite_sequence WHERE name = 'turn_completions'")).toEqual({ seq: 1 });
    expect(turnEnds()).toEqual(["ok"]);
  });

  it("rolls back message status, reply links, steps, and live state when a later write fails", () => {
    const id = post("问题");
    startTurn(id);
    say("r1", "答复");
    const working = activity();
    expect(working).not.toBe("idle");
    failOn("fail_watermark", "BEFORE INSERT ON turn_completion_watermarks");
    changes = [];
    end([id]);
    expect(statusOf(id)).toBe("processing");
    expect(replyIdOf(ledger.getMessage(id)!)).toBeNull();
    expect(turnEnds()).toEqual([]);
    expect(activity()).toBe(working);
    expect(changes.filter((c) => c.type !== "health.updated")).toEqual([]);

    drop("fail_watermark");
    tick();
    expect(statusOf(id)).toBe("replied");
    expect(replyIdOf(ledger.getMessage(id)!)).toBe(agentReply());
    expect(turnEnds()).toEqual(["ok"]);
    expect(activity()).toBe("idle");
  });

  it("publishes message changes once after settlement and ignores a settled sequence", () => {
    const id = post("问题");
    startTurn(id);
    end([id]);
    const watermark = db.get<{ sequence: number }>("SELECT sequence FROM turn_completion_watermarks WHERE session_id = ?", sessionId)!.sequence;
    const event = JSON.stringify({ type: "turn.ended", ok: false, interrupted: true, messageIds: [id], durationMs: 1, at: now });
    db.run(
      "INSERT INTO turn_completions (sequence, session_id, event, facts, next_attempt_at) VALUES (?, ?, ?, ?, 0)",
      watermark, sessionId, event, JSON.stringify(NO_TURN_FACTS),
    );
    changes = [];
    restart();
    expect(receipts()).toBe(0);
    expect(statusOf(id)).toBe("replied");
    expect(turnEnds()).toEqual(["ok"]);
    expect(updatesOf(id)).toEqual([]);
  });

  it("settles each session in order and continues settling other sessions while one session is blocked", () => {
    const other = secondPm();
    const a = post("a");
    const b = post("b", other.conversationId);
    startTurn(a);
    startTurn(b, other.sessionId);
    failReplied(a);
    end([a]);
    end([], FAILED);
    expect(receipts()).toBe(2);
    end([b], {}, other.sessionId);
    expect(statusOf(b)).toBe("replied");
    expect(receipts(other.sessionId)).toBe(0);
    expect(turnEnds()).toEqual([]);

    drop("fail_replied");
    tick();
    expect(statusOf(a)).toBe("replied");
    expect(turnEnds()).toEqual(["ok", "failed"]);
    expect(receipts()).toBe(0);
  });

  it("keeps new sends on hold until the affected session settles and caps the retry delay", () => {
    const other = secondPm();
    const id = post("问题");
    startTurn(id);
    failReplied(id);
    end([id]);
    expect(ledger.waitsForTurnCompletion(sessionId)).toBe(true);
    expect(ledger.waitsForTurnCompletion(other.sessionId)).toBe(false);
    for (let i = 0; i < 6; i++) tick();
    const row = db.get<{ attempts: number; next_attempt_at: number }>("SELECT attempts, next_attempt_at FROM turn_completions")!;
    expect(row.attempts).toBeGreaterThanOrEqual(6);
    expect(row.next_attempt_at - now).toBe(TURN_COMPLETION_RETRY_MAX_MS);
    expect(ledger.waitsForTurnCompletion(sessionId)).toBe(true);

    drop("fail_replied");
    tick();
    expect(ledger.waitsForTurnCompletion(sessionId)).toBe(false);
  });

  it("prevents an executor retry from resending a failed turn and allows a new explicit user retry", async () => {
    const id = post("问题");
    startTurn(id);
    ev({ type: "agent.tool", uuid: "t", toolUseId: "t1", name: "Bash", input: { command: "ls" }, at: now });
    end([id], FAILED);
    expect(statusOf(id)).toBe("failed");
    const send = vi.fn(async () => {
      ev({ type: "message.delivered", at: now, messageIds: [id] });
      return { kind: "written" as const };
    });
    const handler = createSessionSendHandler({
      driver: { start: vi.fn(), send, end: vi.fn() },
      ledger,
      sessions: createSessionStore(db),
      tokens: { revoke: vi.fn() },
      now: () => now,
    });
    expect(await handler(sendsFor(id)[0]!)).toEqual({ kind: "done" });
    expect(send).not.toHaveBeenCalled();

    ledger.retryMessage(id);
    expect(statusOf(id)).toBe("queued");
    expect(await handler(sendsFor(id).at(-1)!)).toEqual({ kind: "done" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("settles tool-only, failed, stopped, and message-free turns from the recorded outcome", () => {
    const toolOnly = post("工具");
    startTurn(toolOnly);
    ev({ type: "agent.tool", uuid: "t", toolUseId: "t1", name: "Bash", input: { command: "ls" }, at: now });
    end([toolOnly], FAILED);
    const textThenFail = post("文字");
    startTurn(textThenFail);
    say("x", "写完了");
    end([textThenFail], FAILED);
    const stopped = post("停");
    startTurn(stopped);
    end([stopped], { ok: false, interrupted: true });
    end([]);
    expect([statusOf(toolOnly), statusOf(textThenFail), statusOf(stopped)]).toEqual(["failed", "replied", "stopped"]);
    expect(turnEnds()).toEqual(["failed", "failed", "interrupted", "ok"]);
    expect(receipts()).toBe(0);
  });

  it("keeps the existing restart policy for turns without a completion receipt", () => {
    const interrupted = post("被打断");
    const receipted = post("已结束");
    startTurn(receipted);
    db.run("UPDATE messages SET status = 'processing' WHERE id = ?", interrupted);
    failReplied(receipted);
    end([receipted]);
    restart();
    expect(sendsFor(interrupted).at(-1)!.params).toMatchObject({ resend: true });
    expect(sendsFor(receipted).at(-1)!.params).not.toHaveProperty("resend");
    expect(statusOf(receipted)).toBe("processing");
    expect(ledger.waitsForTurnCompletion(sessionId)).toBe(true);

    drop("fail_replied");
    tick();
    expect(statusOf(receipted)).toBe("replied");
    expect(sendsFor(receipted)).toHaveLength(1);
  });

  it("settles only the listed messages still owned by the session and ignores deleted or superseded messages", () => {
    const other = secondPm();
    const moved = post("改派");
    const kept = post("留下");
    startTurn(moved);
    startTurn(kept);
    db.run("UPDATE messages SET session_id = ? WHERE id = ?", other.sessionId, moved);
    end([moved, kept, 999_999]);
    expect(statusOf(moved)).toBe("processing");
    expect(statusOf(kept)).toBe("replied");
    expect(receipts()).toBe(0);
  });

  it("recovers a receipt without attachment facts without linking a different turn's reply", () => {
    const id = post("问题");
    startTurn(id);
    say("r1", "上一轮的答复");
    ledger.close();
    const event = JSON.stringify({ type: "turn.ended", ok: true, interrupted: false, messageIds: [id], durationMs: 1, at: now });
    db.run("INSERT INTO turn_completions (session_id, event, facts, next_attempt_at) VALUES (?, ?, NULL, 0)", sessionId, event);
    ledger = openLedger();
    ledger.recoverAfterRestart();
    expect(statusOf(id)).toBe("replied");
    expect(replyIdOf(ledger.getMessage(id)!)).toBeNull();
    expect(receipts()).toBe(0);
    expect(sendsFor(id)).toHaveLength(1);
  });

  it("stops retries when the ledger closes and leaves committed receipts for restart", () => {
    const id = post("问题");
    startTurn(id);
    failReplied(id);
    end([id]);
    ledger.close();
    drop("fail_replied");
    tick();
    expect(receipts()).toBe(1);
    expect(statusOf(id)).toBe("processing");

    ledger = openLedger();
    ledger.recoverAfterRestart();
    expect(statusOf(id)).toBe("replied");
    expect(sendsFor(id)).toHaveLength(1);
    expect(sendsFor(id)[0]!.params).not.toHaveProperty("resend");
  });

  it("sends the next scheduled occurrence once the previous occurrence settles", () => {
    const schedule = ledger.hubCall(sessionId, "schedule.add", { name: "日报", prompt: "写日报", daily: "09:00" }).data.schedule;
    const runs = () =>
      db.all<{ id: MessageId }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id", conversationId)
        .map((r) => ledger.getMessage(r.id)!)
        .filter((m) => systemEventOf(m)?.event === "schedule.run");
    const nextRun = () => db.get<{ next_run_at: number }>("SELECT next_run_at FROM schedules WHERE id = ?", schedule.id)!.next_run_at;
    now = nextRun();
    ledger.runDueSchedules(now);
    const first = runs()[0]!;
    startTurn(first.id);
    say("r1", "日报写好了");
    failReplied(first.id);
    end([first.id]);
    expect(statusOf(first.id)).toBe("processing");

    drop("fail_replied");
    tick();
    expect(statusOf(first.id)).toBe("replied");
    now = nextRun();
    ledger.runDueSchedules(now);
    expect(runs()).toHaveLength(2);
    expect(sendsFor(runs()[1]!.id)).toHaveLength(1);
    expect(db.get("SELECT last_status FROM schedules WHERE id = ?", schedule.id)).toEqual({ last_status: "sent" });
  });
});

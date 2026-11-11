// 二次 Esc 回退最后一条被中断或已取消的用户消息：账本状态、幂等、索引查询与界面服务接口。
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import { API_PATHS, ConversationNotFoundError, LedgerRequestError, isRewoundMessage, workerPickOf } from "../../shared/index.ts";
import type { ConversationId, MessageId, PmId, SessionId, WorkerPick } from "../../shared/index.ts";
import { openDatabase } from "../store/db.ts";
import type { Db } from "../store/index.ts";
import { migrate } from "../store/migrate.ts";
import { createUiServer } from "../ui-server/server.ts";
import { FakeLedger, makeMessage as makeFakeMessage } from "../ui-server/fake-ledger.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger } from "./index.ts";
import type { LedgerOptions, SqliteLedger } from "./index.ts";

let root: string;
let dbFile: string;
let db: Db;
let ledger: SqliteLedger;
let changes: Change[];
let now: number;
let clientSeq: number;
let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };

function options(): LedgerOptions {
  const dataHome = join(root, ".agent-hub");
  return {
    now: () => now,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    worktreesDir: join(dataHome, "worktrees"),
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
  };
}

function open(): void {
  db = openDatabase(dbFile);
  migrate(db);
  ledger = createLedger(db, options());
  changes = [];
  ledger.onChange((c) => changes.push(c));
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-rewind-")));
  dbFile = join(root, "hub.sqlite");
  now = 1_000;
  clientSeq = 0;
  open();
  const a = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
  lin = { pmId: a.pm.id, conversationId: a.conversation.id, sessionId: a.sessionId };
  changes = [];
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const post = (conversationId: ConversationId, text: string, extra: { workerPick?: WorkerPick } = {}): MessageId => {
  now += 100;
  return ledger.postUserMessage({ conversationId, clientId: `c${++clientSeq}`, text, ...extra }).messageId;
};

const deliverAndProcess = (sessionId: SessionId, messageIds: MessageId[]) => {
  ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds, at: ++now });
  ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds, at: ++now });
};

describe("ledger.rewindLastUserMessage", () => {
  it("排队中被停止取消（cancelled）的用户消息（带 workerPick）可回退，标记 meta.rewound 并推送 message.updated", () => {
    const pick: WorkerPick = { vendor: "codex", model: "gpt-5.4", effort: "high" };
    const id = post(lin.conversationId, "把这个模块拆出来", { workerPick: pick });
    ledger.requestStop(lin.conversationId);
    expect(ledger.getMessage(id)?.status).toBe("cancelled");

    changes = [];
    const rewound = ledger.rewindLastUserMessage(lin.conversationId);
    expect(rewound).not.toBeNull();
    expect(rewound?.id).toBe(id);
    expect(rewound?.text).toBe("把这个模块拆出来");
    expect(workerPickOf(rewound!)).toEqual(pick);
    expect(isRewoundMessage(rewound!)).toBe(true);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: "message.updated", data: { message: { id, meta: { workerPick: pick, rewound: true } } } });

    // 快照重新读取仍然保持 rewound 标记
    const snapMsg = ledger.snapshot().conversations.find((c) => c.conversation.id === lin.conversationId)?.messages.find((m) => m.id === id);
    expect(snapMsg && isRewoundMessage(snapMsg)).toBe(true);
  });

  it("正在停止（stopping）期间消息尚在 processing 时紧接着回退立即生效，后续驱动层上报 interrupted 不会抹掉 rewound", () => {
    const id = post(lin.conversationId, "先查一下日志");
    deliverAndProcess(lin.sessionId, [id]);
    ledger.applyDriverEvent(lin.sessionId, { type: "agent.tool", uuid: "u1", toolUseId: "t1", name: "Bash", input: { command: "ls" }, at: ++now });
    ledger.requestStop(lin.conversationId);

    const rewound = ledger.rewindLastUserMessage(lin.conversationId);
    expect(rewound?.id).toBe(id);
    expect(isRewoundMessage(rewound!)).toBe(true);

    // 驱动层随后才结束这一轮，标为 stopped，rewound 标记不能丢
    ledger.applyDriverEvent(lin.sessionId, { type: "turn.ended", ok: false, interrupted: true, durationMs: 50, messageIds: [id], at: ++now });
    const after = ledger.getMessage(id)!;
    expect(after.status).toBe("stopped");
    expect(isRewoundMessage(after)).toBe(true);
    expect(after.meta?.deliveryConfirmed).toBe(true);
  });

  it("幂等与历史边界：回退一次后连按不再返回任何消息，也不会掏出更早一轮的历史消息", () => {
    const m1 = post(lin.conversationId, "第一句被停掉的话");
    deliverAndProcess(lin.sessionId, [m1]);
    ledger.applyDriverEvent(lin.sessionId, { type: "turn.ended", ok: false, interrupted: true, durationMs: 50, messageIds: [m1], at: ++now });

    const m2 = post(lin.conversationId, "第二句刚停掉的话");
    ledger.requestStop(lin.conversationId);

    expect(ledger.rewindLastUserMessage(lin.conversationId)?.id).toBe(m2);
    changes = [];
    // 再调第二次、第三次：不会重复返回 m2，也绝不会翻出更早的 m1
    expect(ledger.rewindLastUserMessage(lin.conversationId)).toBeNull();
    expect(ledger.rewindLastUserMessage(lin.conversationId)).toBeNull();
    expect(changes).toHaveLength(0);
    expect(isRewoundMessage(ledger.getMessage(m1)!)).toBe(false);
  });

  it("已完成（replied）、发送失败（failed）或正常执行中未点停止（working）的消息不能回退", () => {
    const replied = post(lin.conversationId, "正常问答");
    deliverAndProcess(lin.sessionId, [replied]);
    // 正在执行、尚未停止时不能直接回退
    expect(ledger.rewindLastUserMessage(lin.conversationId)).toBeNull();

    ledger.applyDriverEvent(lin.sessionId, { type: "agent.text", uuid: "a1", text: "答复完了", at: ++now });
    ledger.applyDriverEvent(lin.sessionId, { type: "turn.ended", ok: true, interrupted: false, durationMs: 50, messageIds: [replied], at: ++now });
    expect(ledger.rewindLastUserMessage(lin.conversationId)).toBeNull();

    const failed = post(lin.conversationId, "会失败的一句");
    ledger.applyDriverEvent(lin.sessionId, { type: "driver.error", code: "internal_error", message: "boom", messageIds: [failed], at: ++now });
    expect(ledger.getMessage(failed)?.status).toBe("failed");
    expect(ledger.rewindLastUserMessage(lin.conversationId)).toBeNull();
  });

  it("单轮包含大量工具调用步骤（> 50 条）后暂停，仍能通过索引精确找到该轮用户消息回退", () => {
    const id = post(lin.conversationId, "跑很多步工具");
    deliverAndProcess(lin.sessionId, [id]);
    for (let i = 0; i < 65; i++) {
      ledger.applyDriverEvent(lin.sessionId, { type: "agent.tool", uuid: `u-${i}`, toolUseId: `t-${i}`, name: "Read", input: { file_path: `/a/${i}.ts` }, at: ++now });
    }
    ledger.applyDriverEvent(lin.sessionId, { type: "turn.ended", ok: false, interrupted: true, durationMs: 50, messageIds: [id], at: ++now });

    const plan = db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT * FROM messages WHERE conversation_id = ? AND sender != 'agent' ORDER BY id DESC LIMIT 20",
      lin.conversationId,
    );
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING INDEX messages_conversation/);

    const rewound = ledger.rewindLastUserMessage(lin.conversationId);
    expect(rewound?.id).toBe(id);
    expect(rewound?.text).toBe("跑很多步工具");
  });

  it("Worker 对话同样生效；若之后项目经理又发了新打回意见，或 Worker 已收工，则不再允许回退旧消息", () => {
    const projectDir = join(root, "proj");
    mkdirSync(projectDir, { recursive: true });
    ledger.hubCall(lin.sessionId, "project.create", { folder: projectDir, name: "proj" });
    const { worker } = ledger.hubCall(lin.sessionId, "worker.start", { title: "修按钮", task: "先看按钮", noWorktree: true }).data;
    const workerConvId = worker.workerConversationId;
    const workerSession = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ?", workerConvId)!;

    // 只有项目经理的任务说明时，按回退不会把项目经理的任务当用户消息退掉
    ledger.requestStop(workerConvId);
    expect(ledger.rewindLastUserMessage(workerConvId)).toBeNull();

    // 用户直接对 Worker 说了一句并暂停：可回退
    const u1 = post(workerConvId, "顺便把圆角改成 12px");
    ledger.requestStop(workerConvId);
    expect(ledger.rewindLastUserMessage(workerConvId)?.id).toBe(u1);

    // 用户又发了一句 u2 并暂停，但项目经理随后发了新的指示：不能越过项目经理的新指示回退 u2
    const u2 = post(workerConvId, "再改一下间距");
    deliverAndProcess(workerSession.id, [u2]);
    ledger.applyDriverEvent(workerSession.id, { type: "turn.ended", ok: false, interrupted: true, durationMs: 50, messageIds: [u2], at: ++now });
    ledger.hubCall(lin.sessionId, "worker.send", { workerId: worker.id, text: "先别改间距" });
    expect(ledger.rewindLastUserMessage(workerConvId)).toBeNull();

    // Worker 收工后调回退抛 conflict；不存在的对话抛 ConversationNotFoundError
    ledger.hubCall(lin.sessionId, "worker.end", { workerId: worker.id });
    expect(() => ledger.rewindLastUserMessage(workerConvId)).toThrow(LedgerRequestError);
    expect(() => ledger.rewindLastUserMessage(999_999)).toThrow(ConversationNotFoundError);
  });
});

describe("POST /api/conversations/:id/rewind", () => {
  it("调用 ledger.rewindLastUserMessage 并返回 200 { message }，不存在的对话返回 404", async () => {
    const fake = new FakeLedger();
    const msg = { ...makeFakeMessage(7, 1, "撤回这句"), status: "cancelled" as const };
    fake.messages.push(msg);
    const dir = mkdtempSync(join(tmpdir(), "ui-rewind-"));
    const token = "t".repeat(32);
    const app = createUiServer({
      ledger: fake.asLedger(),
      token,
      staticDir: dir,
      uploadsDir: join(dir, "u"),
      sentFilesDir: join(dir, "s"),
      port: 4317,
    });
    try {
      const authRes = await app.inject({
        method: "POST",
        url: "/auth",
        headers: { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317", "content-type": "application/json" },
        payload: { token },
      });
      const cookie = authRes.headers["set-cookie"];
      const headers = {
        host: "127.0.0.1:4317",
        origin: "http://127.0.0.1:4317",
        cookie: Array.isArray(cookie) ? cookie[0]!.split(";")[0]! : String(cookie).split(";")[0]!,
      };

      const ok = await app.inject({ method: "POST", url: API_PATHS.rewind(1), headers });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ message: { id: 7, text: "撤回这句", meta: { rewound: true } } });

      const again = await app.inject({ method: "POST", url: API_PATHS.rewind(1), headers });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ message: null });

      const missing = await app.inject({ method: "POST", url: API_PATHS.rewind(999), headers });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

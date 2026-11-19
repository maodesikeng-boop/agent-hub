// agent 的文字消息入库时存副本、meta 记 files（ledger/sent-files.ts、messages.ts 的 agent.text）。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Change } from "../../shared/api.ts";
import { MAX_PENDING_DRIVER_EVENTS_PER_SESSION } from "../../shared/limits.ts";
import type { ConversationId, Message, SessionId } from "../../shared/domain.ts";
import { workerWorktreePath } from "../../shared/paths.ts";
import { sentFilesOf } from "../../shared/sent-files.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger } from "./index.ts";
import type { LedgerOptions, SqliteLedger } from "./index.ts";

/** 拦住某个文件的 open，模拟读得很慢的附件（网络盘、被占用）：opened 表示已经开始读，放行后 closed 表示那个句柄已关。 */
type Gate = { promise: Promise<void>; resolve: () => void };
const slowOpen = vi.hoisted(() => ({ hold: null as null | { path: string; opened: Gate; release: Gate; closed: Gate } }));

vi.mock("../platform/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../platform/index.ts")>();
  return {
    ...original,
    openRegularFileNoFollow: async (...args: Parameters<typeof original.openRegularFileNoFollow>) => {
      const hold = slowOpen.hold;
      if (hold === null || args[0] !== hold.path) return original.openRegularFileNoFollow(...args);
      hold.opened.resolve();
      await hold.release.promise;
      const handle = await original.openRegularFileNoFollow(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        hold.closed.resolve();
      };
      return handle;
    },
  };
});

function gate(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function holdOpen(path: string) {
  const hold = { path, opened: gate(), release: gate(), closed: gate() };
  slowOpen.hold = hold;
  return hold;
}

let db: Db;
let root: string;
let dataHome: string;
let sentFilesDir: string;
let main: string;
let ledger: SqliteLedger;
let pm: { conversationId: ConversationId; sessionId: SessionId };
let projectId: number;

function options(extra: Partial<LedgerOptions> = {}): LedgerOptions {
  return {
    now: () => 1_000,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    sentFilesDir,
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    // 测试的文件都在 os.tmpdir() 下：不放行临时目录，才测得出“不在允许的文件夹里”
    shareTmpDirs: [],
    ...extra,
  };
}

function file(path: string, content = "x"): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  db = openTestDb();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-ledger-sent-")));
  dataHome = join(root, ".agent-hub");
  sentFilesDir = join(dataHome, "sent-files");
  main = join(root, "proj");
  mkdirSync(main, { recursive: true });
  ledger = createLedger(db, options());
  const created = ledger.createPm({ name: "小林", mode: "manage_only", persona: "", folder: main });
  pm = { conversationId: created.conversation.id, sessionId: created.sessionId };
  projectId = created.project!.id;
});

afterEach(() => {
  slowOpen.hold?.release.resolve();
  slowOpen.hold = null;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function lastMessage(conversationId: ConversationId): Message {
  const row = db.get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1", conversationId)!;
  return ledger.getMessage(row.id)!;
}

/** 交给账本就返回，不等落库（存副本是异步的）。 */
const send = (sessionId: SessionId, text: string, uuid = "u1") => ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid, text, at: 1 });
/** 交给账本并等它落库。 */
const say = async (sessionId: SessionId, text: string, uuid = "u1") => {
  send(sessionId, text, uuid);
  await ledger.settleDriverEvents();
};

describe("agent 文字消息入库时存副本", () => {
  it("项目经理回复里的 png：meta.files 记下、推 message.created 时就带着", async () => {
    const png = file(join(main, "shot.png"), "PNG");
    const changes: Change[] = [];
    ledger.onChange((c) => changes.push(c));
    await say(pm.sessionId, `看图：\n\n![截图](${png})`);
    const message = lastMessage(pm.conversationId);
    expect(sentFilesOf(message)).toEqual([expect.objectContaining({ href: png, path: png, name: "shot.png", status: "saved", mime: "image/png", size: 3 })]);
    const created = changes.find((c) => c.type === "message.created");
    expect(created?.type === "message.created" && sentFilesOf(created.data.message)).toHaveLength(1);
    expect(readdirSync(sentFilesDir)).toHaveLength(1);
  });

  it("回复里的大文件：存副本不占着写事务、不卡事件循环，同一会话后面的事件仍按顺序落在它后面", async () => {
    const big = file(join(main, "big.bin"));
    truncateSync(big, 40 * 1024 * 1024);
    const texts = () =>
      db
        .all<{ text: string }>("SELECT text FROM messages WHERE conversation_id = ? AND sender = 'agent' ORDER BY id", pm.conversationId)
        .map((r) => r.text);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    try {
      send(pm.sessionId, `大文件：[b](${big})`, "u-big");
      send(pm.sessionId, "后面一句", "u-next");
      await vi.waitFor(() => expect(texts()).toHaveLength(2), { timeout: 20_000 });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
    expect(texts()).toEqual([`大文件：[b](${big})`, "后面一句"]);
    const row = db.get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND text LIKE '大文件%'", pm.conversationId)!;
    expect(sentFilesOf(ledger.getMessage(row.id)!)).toEqual([expect.objectContaining({ status: "saved", size: 40 * 1024 * 1024 })]);
  });

  it("没有本机链接的回复：meta 还是 null（和老消息一样），不建 sent-files/", async () => {
    await say(pm.sessionId, "好的，[文档](https://example.com) 看这里");
    expect(lastMessage(pm.conversationId).meta).toBeNull();
    expect(existsSync(sentFilesDir)).toBe(false);
  });

  it("不在可分享的文件夹里：照样入库，状态写原因，不拷", async () => {
    await say(pm.sessionId, `[hosts](/etc/hosts) 和 [没有](${join(main, "nope.md")}) 和 [登录](/login)`);
    expect(sentFilesOf(lastMessage(pm.conversationId)).map((f) => f.status)).toEqual(["not_allowed", "missing"]);
    expect(existsSync(sentFilesDir) ? readdirSync(sentFilesDir) : []).toEqual([]);
  });

  it("重放同一条消息（重启后驱动层又交一次）：只有一条消息，不再碰文件、编号不变", async () => {
    const md = file(join(main, "a.md"), "v1");
    await say(pm.sessionId, `[a](${md})`);
    const first = lastMessage(pm.conversationId);
    rmSync(md);
    await say(pm.sessionId, `[a](${md})`);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE conversation_id = ?", pm.conversationId)!.n).toBe(first.id);
    expect(lastMessage(pm.conversationId)).toEqual(first);
    expect(readdirSync(sentFilesDir)).toEqual([sentFilesOf(first)[0]!.id]);
  });

  it("默认放行 /tmp 和系统临时目录", async () => {
    const other = createLedger(openTestDb(), options({ shareTmpDirs: undefined }));
    const created = other.createPm({ name: "阿周", mode: "manage_only", persona: "", folder: main });
    const tmp = file(join(root, "elsewhere", "t.png"));
    other.applyDriverEvent(created.sessionId, { type: "agent.text", uuid: "t", text: `![t](${tmp})`, at: 1 });
    await other.settleDriverEvents();
    expect(sentFilesOf(other.getMessage(other.messagesBefore(created.conversation.id, 1e9).messages.at(-1)!.id)!)).toEqual([
      expect.objectContaining({ status: "saved", path: tmp }),
    ]);
  });

  it("Worker 回复里的图：存在 Worker 的对话里；本项目 worktrees 目录里的文件能发（数据目录里的例外）", async () => {
    const started = ledger.hubCall(pm.sessionId, "worker.start", { title: "截图", task: "截个图", noWorktree: true });
    const worker = started.data.worker;
    const sessionId = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", worker.id)!.id;
    const shot = file(join(main, "w.png"));
    file(join(dataHome, "state", "ui-token"), "TOKEN");
    const inWorktree = file(join(workerWorktreePath(join(dataHome, "worktrees"), projectId, 99), "wt.png"));
    await say(sessionId, `![w](${shot}) ![wt](${inWorktree}) [token](${join(dataHome, "state", "ui-token")})`, "w1");
    const message = lastMessage(worker.workerConversationId);
    expect(message.sender).toBe("agent");
    expect(sentFilesOf(message).map((f) => f.status)).toEqual(["saved", "saved", "not_allowed"]);
  });
});

describe("关机与排队上限：慢附件不丢已收到的回复", () => {
  const agentTexts = () =>
    db
      .all<{ text: string; meta: string | null }>("SELECT text, meta FROM messages WHERE conversation_id = ? AND sender = 'agent' ORDER BY id", pm.conversationId)
      .map((r) => ({ text: r.text, meta: r.meta === null ? null : (JSON.parse(r.meta) as Record<string, unknown>) }));

  it("关机时附件还在读：close() 中断拷贝，已收到的两条回复按顺序同步落库；之后放行的读取不再碰库、不留副本", async () => {
    const slow = file(join(main, "slow.txt"), "ordinary attachment\n");
    const hold = holdOpen(slow);
    const errors = vi.spyOn(console, "error");
    send(pm.sessionId, `[附件](${slow})`, "first");
    send(pm.sessionId, "下一句", "second");
    await hold.opened.promise;
    ledger.close();
    expect(agentTexts()).toEqual([
      { text: `[附件](${slow})`, meta: null },
      { text: "下一句", meta: null },
    ]);
    const writes = vi.spyOn(db, "transaction");
    hold.release.resolve();
    await hold.closed.promise;
    await ledger.settleDriverEvents();
    await new Promise((resolve) => setImmediate(resolve));
    expect(writes).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(existsSync(sentFilesDir) ? readdirSync(sentFilesDir) : []).toEqual([]);
  });

  it("关机之后驱动层再交来的事件不落库", () => {
    ledger.close();
    send(pm.sessionId, "关机后才到");
    expect(agentTexts()).toEqual([]);
  });

  it(`同一会话排着的事件到 ${MAX_PENDING_DRIVER_EVENTS_PER_SESSION} 条：不再等附件，排着的按顺序直接落库`, async () => {
    const slow = file(join(main, "slow.txt"));
    const hold = holdOpen(slow);
    send(pm.sessionId, `[附件](${slow})`, "head");
    await hold.opened.promise;
    for (let i = 1; i < MAX_PENDING_DRIVER_EVENTS_PER_SESSION; i++) send(pm.sessionId, `第 ${i} 句`, `n${i}`);
    expect(agentTexts()).toEqual([]);
    send(pm.sessionId, "满了", "full");
    const texts = agentTexts();
    expect(texts).toHaveLength(MAX_PENDING_DRIVER_EVENTS_PER_SESSION + 1);
    expect(texts[0]).toEqual({ text: `[附件](${slow})`, meta: null });
    expect(texts.at(-1)!.text).toBe("满了");
    hold.release.resolve();
    await hold.closed.promise;
    await ledger.settleDriverEvents();
    expect(agentTexts()).toHaveLength(MAX_PENDING_DRIVER_EVENTS_PER_SESSION + 1);
  });
});

describe("sentFileAllows：打开原文件前再查一次", () => {
  it("项目文件夹里的能分享；文件夹外、敏感路径、数据目录的 state/ 不能；会话不存在 false", async () => {
    const inside = file(join(main, "a.txt"));
    const outside = file(join(root, "elsewhere", "b.txt"));
    const secret = file(join(dataHome, "state", "ui-token"));
    expect(ledger.sentFileAllows(pm.sessionId, inside)).toBe(true);
    expect(ledger.sentFileAllows(pm.sessionId, outside)).toBe(false);
    expect(ledger.sentFileAllows(pm.sessionId, secret)).toBe(false);
    expect(ledger.sentFileAllows(9999, inside)).toBe(false);
  });
});

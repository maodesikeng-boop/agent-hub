// agent 的文字消息入库时存副本、meta 记 files（ledger/sent-files.ts、messages.ts 的 agent.text）。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import type { ConversationId, Message, SessionId } from "../../shared/domain.ts";
import { workerWorktreePath } from "../../shared/paths.ts";
import { sentFilesOf } from "../../shared/sent-files.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger } from "./index.ts";
import type { LedgerOptions, SqliteLedger } from "./index.ts";

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
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function lastMessage(conversationId: ConversationId): Message {
  const row = db.get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1", conversationId)!;
  return ledger.getMessage(row.id)!;
}

const say = (sessionId: SessionId, text: string, uuid = "u1") => ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid, text, at: 1 });

describe("agent 文字消息入库时存副本", () => {
  it("项目经理回复里的 png：meta.files 记下、推 message.created 时就带着", () => {
    const png = file(join(main, "shot.png"), "PNG");
    const changes: Change[] = [];
    ledger.onChange((c) => changes.push(c));
    say(pm.sessionId, `看图：\n\n![截图](${png})`);
    const message = lastMessage(pm.conversationId);
    expect(sentFilesOf(message)).toEqual([expect.objectContaining({ href: png, path: png, name: "shot.png", status: "saved", mime: "image/png", size: 3 })]);
    const created = changes.find((c) => c.type === "message.created");
    expect(created?.type === "message.created" && sentFilesOf(created.data.message)).toHaveLength(1);
    expect(readdirSync(sentFilesDir)).toHaveLength(1);
  });

  it("没有本机链接的回复：meta 还是 null（和老消息一样），不建 sent-files/", () => {
    say(pm.sessionId, "好的，[文档](https://example.com) 看这里");
    expect(lastMessage(pm.conversationId).meta).toBeNull();
    expect(existsSync(sentFilesDir)).toBe(false);
  });

  it("不在可分享的文件夹里：照样入库，状态写原因，不拷", () => {
    say(pm.sessionId, `[hosts](/etc/hosts) 和 [没有](${join(main, "nope.md")}) 和 [登录](/login)`);
    expect(sentFilesOf(lastMessage(pm.conversationId)).map((f) => f.status)).toEqual(["not_allowed", "missing"]);
    expect(existsSync(sentFilesDir) ? readdirSync(sentFilesDir) : []).toEqual([]);
  });

  it("重放同一条消息（重启后驱动层又交一次）：只有一条消息，不再碰文件、编号不变", () => {
    const md = file(join(main, "a.md"), "v1");
    say(pm.sessionId, `[a](${md})`);
    const first = lastMessage(pm.conversationId);
    rmSync(md);
    say(pm.sessionId, `[a](${md})`);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE conversation_id = ?", pm.conversationId)!.n).toBe(first.id);
    expect(lastMessage(pm.conversationId)).toEqual(first);
    expect(readdirSync(sentFilesDir)).toEqual([sentFilesOf(first)[0]!.id]);
  });

  it("默认放行 /tmp 和系统临时目录", () => {
    const other = createLedger(openTestDb(), options({ shareTmpDirs: undefined }));
    const created = other.createPm({ name: "阿周", mode: "manage_only", persona: "", folder: main });
    const tmp = file(join(root, "elsewhere", "t.png"));
    other.applyDriverEvent(created.sessionId, { type: "agent.text", uuid: "t", text: `![t](${tmp})`, at: 1 });
    expect(sentFilesOf(other.getMessage(other.messagesBefore(created.conversation.id, 1e9).messages.at(-1)!.id)!)).toEqual([
      expect.objectContaining({ status: "saved", path: tmp }),
    ]);
  });

  it("Worker 回复里的图：存在 Worker 的对话里；本项目 worktrees 目录里的文件能发（数据目录里的例外）", () => {
    const started = ledger.hubCall(pm.sessionId, "worker.start", { title: "截图", task: "截个图", noWorktree: true });
    const worker = started.data.worker;
    const sessionId = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", worker.id)!.id;
    const shot = file(join(main, "w.png"));
    file(join(dataHome, "state", "ui-token"), "TOKEN");
    const inWorktree = file(join(workerWorktreePath(join(dataHome, "worktrees"), projectId, 99), "wt.png"));
    say(sessionId, `![w](${shot}) ![wt](${inWorktree}) [token](${join(dataHome, "state", "ui-token")})`, "w1");
    const message = lastMessage(worker.workerConversationId);
    expect(message.sender).toBe("agent");
    expect(sentFilesOf(message).map((f) => f.status)).toEqual(["saved", "saved", "not_allowed"]);
  });
});

describe("sentFileAllows：打开原文件前再查一次", () => {
  it("项目文件夹里的能分享；文件夹外、敏感路径、数据目录的 state/ 不能；会话不存在 false", () => {
    const inside = file(join(main, "a.txt"));
    const outside = file(join(root, "elsewhere", "b.txt"));
    const secret = file(join(dataHome, "state", "ui-token"));
    expect(ledger.sentFileAllows(pm.sessionId, inside)).toBe(true);
    expect(ledger.sentFileAllows(pm.sessionId, outside)).toBe(false);
    expect(ledger.sentFileAllows(pm.sessionId, secret)).toBe(false);
    expect(ledger.sentFileAllows(9999, inside)).toBe(false);
  });
});

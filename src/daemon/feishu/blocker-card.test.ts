// 飞书里“要你动手”提醒卡点“已处理”：和网页一样先让 ModelCatalogs 重问这家厂商，再交给账本（docs/user-blockers-design.md）。
// 厂商状态走真的 ModelCatalogs（假来源），账本只从 models.availability 读。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PmId, SessionId } from "../../shared/domain.ts";
import { AGENT_VENDORS, type VendorAvailability } from "../../shared/vendors.ts";
import { createModelCatalogs, type ModelCatalogs } from "../driver/model-catalog.ts";
import { createResolveFolder } from "../ledger/files.ts";
import { createLedger, type SqliteLedger } from "../ledger/index.ts";
import { openDatabase } from "../store/db.ts";
import type { Db } from "../store/index.ts";
import { migrate } from "../store/migrate.ts";
import { FEISHU_GROUP_MSG_SCOPE, FEISHU_REQUIRED_SCOPES } from "./scopes.ts";
import { createFeishuService, type FeishuService } from "./service.ts";
import { createFeishuStore } from "./store.ts";
import { createFakeFeishu, type FakeFeishu } from "./test-helpers.ts";

const OWNER = "ou_owner";
let root: string;
let db: Db;
let ledger: SqliteLedger;
let models: ModelCatalogs;
let fake: FakeFeishu;
let svc: FeishuService;
let claude: VendorAvailability;
let lin: { pmId: PmId; sessionId: SessionId };

beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "feishu-blocker-")));
  const dataHome = join(root, ".agent-hub");
  const repo = join(root, "repo");
  mkdirSync(join(dataHome, "state"), { recursive: true });
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  git("init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git("add", ".");
  git("commit", "-m", "init");
  claude = "signed_out";
  models = createModelCatalogs({
    sources: Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, { parse: () => null, query: async () => null, availabilityOf: () => (vendor === "claude" ? claude : "available") }])),
    log: () => {},
  });
  models.report("claude", "signed_out");
  db = openDatabase(join(root, "hub.sqlite"));
  migrate(db);
  ledger = createLedger(db, {
    pmHomeRoot: join(dataHome, "pm"),
    dataHome,
    worktreesDir: join(dataHome, "wt"),
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    models,
    osSandboxed: () => true,
  });
  const created = ledger.createPm({ name: "小林", mode: "manage_only", persona: "", folder: repo });
  lin = { pmId: created.pm.id, sessionId: created.sessionId };
  fake = createFakeFeishu();
  fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
  svc = createFeishuService({
    db,
    ledger,
    models,
    router: null,
    secretsFile: join(dataHome, "state", "feishu-secrets.json"),
    uploadsDir: join(dataHome, "u"),
    sentFilesDir: join(dataHome, "s"),
    device: { id: "11111111-2222-3333-4444-555555555555", name: "测试机" },
    log: () => {},
    createTransport: () => fake,
    register: async ({ handlers }) => {
      handlers.onUrl({ url: "https://x", expiresAt: Date.now() + 60_000 });
      return { brand: "feishu", appId: "cli_t", appSecret: "s", scannerOpenId: OWNER };
    },
  });
  await svc.start();
  await svc.setup.startRegistration();
  await vi.waitFor(() => expect(svc.setup.status().state).toBe("connected"));
  await svc.idle();
});

afterEach(async () => {
  await svc.close();
  await models.close();
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await svc.idle();
    await new Promise((resolve) => setImmediate(resolve));
  }
};

async function blockerCard() {
  ledger.hubCall(lin.sessionId, "graph.create", {
    specJson: JSON.stringify({ title: "测试图", steps: [{ key: "s1", title: "第一步", brief: "做", vendor: "claude" }] }),
  });
  await settle();
  const row = db.get<{ blocker_id: number; message_id: number }>("SELECT blocker_id, message_id FROM user_blocker_cards")!;
  const store = createFeishuStore(db);
  const chatId = store.chatOfTarget({ kind: "pm", pmId: lin.pmId })!.chatId;
  const post = store.postOf({ kind: "message", messageId: row.message_id, part: 0 })!;
  const click = () =>
    fake.click({
      messageId: post.messageId,
      chatId,
      operatorOpenId: OWNER,
      value: { fusa: 1, kind: "blocker_done", card: { kind: "blocker", askMessageId: row.message_id, blockerId: row.blocker_id } },
      formValue: null,
    });
  const status = () => db.get<{ status: string }>("SELECT status FROM user_blockers WHERE id = ?", row.blocker_id)!.status;
  return { click, status, chatId, post };
}

it("在电脑上登录好后在飞书点“已处理”：先重问这家厂商再重查，解开并把提醒卡改成定案", async () => {
  const card = await blockerCard();
  claude = "available";
  expect(card.click().toast?.type).toBe("info");
  await settle();
  expect(card.status()).not.toBe("open");
  expect(fake.callsOf("card.update").some((u) => u.card_id === card.post.cardId)).toBe(true);
});

it("还没处理好时点“已处理”：卡留着，群里说一句还不能用", async () => {
  const card = await blockerCard();
  card.click();
  await settle();
  expect(card.status()).toBe("open");
  expect(fake.sent.some((s) => s.chatId === card.chatId && s.content.includes("还不能用"))).toBe(true);
});

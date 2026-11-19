// 用假的传输层和假的 registerApp 跑。
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEISHU_BIND_CODE_TTL_MS } from "../../shared/limits.ts";
import { createLedger, type SqliteLedger } from "../ledger/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { FEISHU_GROUP_MSG_SCOPE, FEISHU_REQUIRED_SCOPES } from "./scopes.ts";
import type { FeishuRegistrationResult, registerFeishuApp } from "./sdk.ts";
import { FeishuRegistrationError } from "./transport.ts";
import { readFeishuSecrets } from "./secrets.ts";
import { createFeishuService, type FeishuService } from "./service.ts";
import { FeishuSetupError } from "./setup.ts";
import { createFakeFeishu, type FakeFeishu } from "./test-helpers.ts";

const SECRET = "very-secret-app-secret";
let root: string;
let db: Db;
let ledger: SqliteLedger;
let fake: FakeFeishu;
let svc: FeishuService;
let now: number;
let pending: { resolve: (r: FeishuRegistrationResult) => void; reject: (e: unknown) => void; signal: AbortSignal }[];
let secretsFile: string;

const register: typeof registerFeishuApp = ({ handlers, signal }) =>
  new Promise((resolve, reject) => {
    pending.push({ resolve, reject, signal });
    signal.addEventListener("abort", () => reject(new FeishuRegistrationError("abort", "aborted")));
    handlers.onUrl({ url: `https://open.feishu.cn/qr/${pending.length}`, expiresAt: now + 600_000 });
  });

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "feishu-setup-")));
  now = 1_000_000;
  db = openTestDb();
  ledger = createLedger(db, { pmHomeRoot: join(root, "pm-home"), now: () => now });
  ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
  fake = createFakeFeishu();
  fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
  pending = [];
  secretsFile = join(root, "state", "feishu-secrets.json");
  svc = createFeishuService({
    db,
    ledger,
    router: null,
    secretsFile,
    uploadsDir: join(root, "uploads"),
    sentFilesDir: join(root, "sent-files"),
    device: { id: "11111111-2222-3333-4444-555555555555", name: "东京" },
    log: () => {},
    createTransport: () => fake,
    register,
    now: () => now,
  });
});

afterEach(async () => {
  await svc.close();
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await svc.idle();
    await new Promise((resolve) => setImmediate(resolve));
  }
};
const scan = async (scanner: string | null = "ou_owner") => {
  pending.at(-1)!.resolve({ brand: "feishu", appId: "cli_scan", appSecret: SECRET, scannerOpenId: scanner });
  await vi.waitFor(() => expect(svc.setup.status().state).not.toBe("registering"));
  await settle();
};

describe("FeishuSetupService：扫码接入", () => {
  it("startRegistration 立刻返回 registering，带确认页链接和过期时间", async () => {
    await svc.start();
    const status = await svc.setup.startRegistration();
    expect(status.state).toBe("registering");
    expect(status.registration).toEqual({ url: "https://open.feishu.cn/qr/1", expiresAt: now + 600_000 });
  });

  it("扫码确认后存凭证、扫码人成为主人、状态到 connecting，不需要绑定码", async () => {
    await svc.start();
    await svc.setup.startRegistration();
    await scan();
    const status = svc.setup.status();
    expect(status).toMatchObject({ state: "connected", appId: "cli_scan", ownerOpenId: "ou_owner", registration: null });
    expect(await readFeishuSecrets(secretsFile)).toEqual({ brand: "feishu", appId: "cli_scan", appSecret: SECRET });
    expect(() => svc.setup.issueBindCode()).toThrow(FeishuSetupError);
  });

  it("再开一次扫码会取消上一次；cancelRegistration 回到原来的状态", async () => {
    await svc.start();
    await svc.setup.startRegistration();
    const second = await svc.setup.startRegistration();
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(second.registration?.url).toBe("https://open.feishu.cn/qr/2");
    expect(svc.setup.cancelRegistration().state).toBe("unconfigured");
    expect(pending[1]!.signal.aborted).toBe(true);
  });

  it("用户拒绝或过期时回到原来的状态，lastError 写原因，原有凭证不动", async () => {
    await svc.start();
    await svc.setup.startRegistration();
    await scan();
    await svc.setup.startRegistration();
    pending.at(-1)!.reject(new FeishuRegistrationError("access_denied", "denied"));
    await vi.waitFor(() => expect(svc.setup.status().state).not.toBe("registering"));
    expect(svc.setup.status()).toMatchObject({ state: "connected", appId: "cli_scan", lastError: "扫码后点了拒绝" });
    await svc.setup.startRegistration();
    pending.at(-1)!.reject(new FeishuRegistrationError("expired_token", "expired"));
    await vi.waitFor(() => expect(svc.setup.status().lastError).toContain("过期"));
    expect(await readFeishuSecrets(secretsFile)).toMatchObject({ appId: "cli_scan" });
  });
});

describe("FeishuSetupService：手动接入", () => {
  it("凭证换不到 tenant_access_token 时抛 FeishuSetupError，原有凭证和连接不动", async () => {
    await svc.start();
    await svc.setup.startRegistration();
    await scan();
    fake.failNext["bot.info"] = { code: 10014, msg: "app secret invalid" };
    await expect(svc.setup.saveCredentials({ brand: "feishu", appId: "cli_other", appSecret: "wrong" })).rejects.toThrow(FeishuSetupError);
    expect(svc.setup.status()).toMatchObject({ state: "connected", appId: "cli_scan" });
    expect(await readFeishuSecrets(secretsFile)).toMatchObject({ appId: "cli_scan" });
    await expect(svc.setup.saveCredentials({ brand: "feishu", appId: "not-an-app", appSecret: "x" })).rejects.toThrow(FeishuSetupError);
  });

  it("验过后状态是 awaiting_owner；绑定码用一次作废，过了 FEISHU_BIND_CODE_TTL_MS 失效", async () => {
    await svc.start();
    const status = await svc.setup.saveCredentials({ brand: "lark", appId: "cli_manual", appSecret: SECRET });
    await settle();
    expect(svc.setup.status().state).toBe("awaiting_owner");
    expect(status.brand).toBe("lark");
    const first = svc.setup.issueBindCode();
    expect(first.code).toMatch(/^\d{6}$/);
    const second = svc.setup.issueBindCode();
    expect(svc.setup.consumeBindCode(first.code, now)).toBe(first.code === second.code);
    expect(svc.setup.consumeBindCode(` ${second.code} `, now)).toBe(first.code !== second.code);
    expect(svc.setup.consumeBindCode(second.code, now)).toBe(false);
    const third = svc.setup.issueBindCode();
    expect(svc.setup.consumeBindCode(third.code, now + FEISHU_BIND_CODE_TTL_MS)).toBe(false);
    // 主人私聊机器人发码就认下
    const fourth = svc.setup.issueBindCode();
    fake.event({
      type: "im.message.receive_v1",
      messageId: "om_bind",
      chatId: "oc_ownerdm",
      chatType: "p2p",
      senderOpenId: "ou_me",
      senderType: "user",
      content: fourth.code,
      mentionedBot: false,
      threadId: null,
      resources: [],
      createTime: now,
    });
    await settle();
    expect(svc.setup.status()).toMatchObject({ ownerOpenId: "ou_me", state: "connected" });
  });

  it("已有主人时 issueBindCode 抛 FeishuSetupError", async () => {
    expect(() => svc.setup.issueBindCode()).toThrow(FeishuSetupError);
    await svc.start();
    await svc.setup.startRegistration();
    await scan();
    expect(() => svc.setup.issueBindCode()).toThrow(/已经认过主人/);
  });
});

describe("FeishuSetupService：设置", () => {
  it("status、startRegistration、saveCredentials 的返回值里搜不到 App Secret", async () => {
    await svc.start();
    const outputs: unknown[] = [svc.setup.status(), await svc.setup.startRegistration()];
    await scan();
    outputs.push(svc.setup.status(), await svc.setup.saveCredentials({ brand: "feishu", appId: "cli_scan", appSecret: SECRET }), await svc.setup.resync());
    for (const out of outputs) expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("setChatPolicy 改完后群里那张访客权限卡跟着改；没有这个群抛 FeishuSetupError", async () => {
    await svc.start();
    await svc.setup.startRegistration();
    await scan();
    const pmId = ledger.snapshot().pms[0]!.id;
    const chatId = svc.setup.status().chats.find((c) => c.target.kind === "pm")!.chatId;
    fake.chats.get(chatId)!.members.push({ member_id: "ou_guest", name: "李四" });
    fake.event({ type: "im.chat.member.user.added_v1", chatId, openIds: ["ou_guest"] });
    await settle();
    const view = await svc.setup.setChatPolicy({ pmId, guestTier: "observer" });
    expect(view).toMatchObject({ guestTier: "observer", triggerMode: "auto" });
    const update = fake.callsOf("card.update").at(-1)!;
    expect(update.card.data).toContain("只读");
    await expect(svc.setup.setChatPolicy({ pmId: 9999, guestTier: "observer" })).rejects.toThrow(FeishuSetupError);
  });

  it("缺必需权限时状态是 needs_permission，missing 列出缺的", async () => {
    fake.granted = FEISHU_REQUIRED_SCOPES.filter((s) => s !== "im:chat:create");
    await svc.start();
    await svc.setup.startRegistration();
    await scan();
    expect(svc.setup.status()).toMatchObject({ state: "needs_permission", missing: ["im:chat:create"] });
  });

  it("disconnect 删掉凭证文件和四张表；dissolveChats 为 true 时先解散项目群", async () => {
    await svc.start();
    await svc.setup.startRegistration();
    await scan();
    const chatIds = svc.setup.status().chats.filter((c) => c.target.kind === "pm").map((c) => c.chatId);
    expect(chatIds).toHaveLength(1);
    const status = await svc.setup.disconnect({ dissolveChats: true });
    expect(status.state).toBe("unconfigured");
    expect(fake.callsOf("chat.delete").map((c) => c.chat_id)).toEqual(chatIds);
    expect(existsSync(secretsFile)).toBe(false);
    for (const table of ["feishu_app", "feishu_chats", "feishu_posts", "feishu_avatars"]) {
      expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n).toBe(0);
    }
  });
});

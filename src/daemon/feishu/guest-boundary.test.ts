import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FEISHU_GUEST_BLOCKED_HUB_COMMANDS,
  FEISHU_GUEST_TIERS,
  feishuGuestMay,
  feishuGuestTierOrder,
  feishuGuestTierPolicy,
  feishuGuestTurnBlockReason,
  feishuOriginOf,
  resolveFeishuGuestTier,
  type FeishuChatId,
  type FeishuGuestTier,
  type FeishuMessageId,
  type FeishuMessageOrigin,
  type FeishuOpenId,
} from "../../shared/feishu.ts";
import { AGENT_VENDORS, bundledModelCatalog } from "../../shared/vendors.ts";
import { deliveryParts } from "../../shared/worker.ts";
import { runFeishuCli, type FeishuCliIo } from "../../feishu/cli.ts";
import { checkReadonlyWorkerSandbox } from "../driver/kernel-readonly.ts";
import { createResolveFolder } from "../ledger/files.ts";
import { createLedger } from "../ledger/ledger.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate, openDatabase, type Db } from "../store/index.ts";
import { writeMigrationManifest } from "../store/test-helpers.ts";
import { decodeFeishuActionValue, renderChatPolicyCard, type FeishuCardJson } from "./cards.ts";
import { routeFeishuAction, routeFeishuMessage, type FeishuRoutingContext } from "./routing.ts";
import { createFeishuStore } from "./store.ts";

const OWNER = "ou_owner1" as FeishuOpenId;
const GUEST = "ou_guest1" as FeishuOpenId;
const CHAT_ID = "oc_chat1" as FeishuChatId;
const MSG_ID = "om_msg1" as FeishuMessageId;

const tempDirs: string[] = [];
const openDbs: Db[] = [];

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()!.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function freshDb(): Db {
  const db = openDatabase(":memory:");
  migrate(db);
  openDbs.push(db);
  return db;
}

function insertPm(db: Db, name: string): number {
  const row = db.get<{ id: number }>(
    "INSERT INTO pms (name, persona, created_at) VALUES (?, '', 1) RETURNING id",
    name,
  )!;
  return row.id;
}

function makeOrigin(patch: Partial<FeishuMessageOrigin> = {}): FeishuMessageOrigin {
  return {
    kind: "feishu",
    openId: GUEST,
    name: "Guest",
    role: "guest",
    mode: "shared",
    guestTier: "chat_only",
    context: [],
    ...patch,
  };
}

function makeRoutingCtx(patch: Partial<FeishuRoutingContext> = {}): FeishuRoutingContext {
  return {
    ownerOpenId: OWNER,
    binding: { target: { kind: "pm", pmId: 1 }, archived: false },
    mode: "shared",
    triggerMode: "auto",
    guestTier: "observer",
    mentionOnlyForced: false,
    speakerName: "Guest",
    pendingContext: [],
    pendingFiles: [],
    isBindCode: () => false,
    ...patch,
  };
}

function makeInboundMsg(patch: Partial<Parameters<typeof routeFeishuMessage>[0]> = {}): Parameters<typeof routeFeishuMessage>[0] {
  return {
    kind: "message",
    messageId: MSG_ID,
    chatId: CHAT_ID,
    chatType: "group",
    senderOpenId: GUEST,
    text: "run git status",
    mentionedBot: true,
    inThread: false,
    files: [],
    droppedMedia: 0,
    at: 1000,
    ...patch,
  };
}

function collectButtonValues(card: FeishuCardJson): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const rec = node as Record<string, unknown>;
    if (rec.tag === "button" && Array.isArray(rec.behaviors)) {
      for (const b of rec.behaviors) {
        if (typeof b === "object" && b !== null && "value" in b) {
          out.push(decodeFeishuActionValue((b as { value: unknown }).value));
        }
      }
    }
    for (const v of Object.values(rec)) walk(v);
  };
  walk(card.body.elements);
  return out;
}

describe("Feishu guest security boundary (new and changed behavior)", () => {
  it("S1 & S10: resolveFeishuGuestTier fails closed to observer for missing, blank, or corrupt values", () => {
    for (const tier of FEISHU_GUEST_TIERS) {
      expect(resolveFeishuGuestTier(tier)).toBe(tier);
    }
    for (const bad of [undefined, null, "", "admin", "CHAT_ONLY", 123, {}]) {
      expect(resolveFeishuGuestTier(bad)).toBe("observer");
    }
  });

  it("S1: new PM Feishu chat bindings default to observer with zero active guest permissions and do not allow guest wakeups", () => {
    const db = freshDb();
    const pmId = insertPm(db, "Alpha");
    const store = createFeishuStore(db);
    const created = store.upsertChat(
      { chatId: CHAT_ID, target: { kind: "pm", pmId }, name: "Alpha", label: "Alpha" },
      100,
    );
    expect(created.guestTier).toBe("observer");
    expect(
      (["talk", "answer_card", "stop", "send_files"] as const).map((action) => feishuGuestMay(created.guestTier, action)),
    ).toEqual([false, false, false, false]);

    const route = routeFeishuMessage(makeInboundMsg(), makeRoutingCtx({ guestTier: created.guestTier }));
    expect(route).toEqual({
      kind: "context",
      line: { name: "Guest", role: "guest", text: "run git status", at: 1000 },
    });
  });

  it("S2: feishuGuestTierOrder puts observer first and feishuGuestTierPolicy attaches a host-privilege warning to active tiers", () => {
    expect(feishuGuestTierOrder()).toEqual(["observer", "chat_only", "collaborator"]);

    const observerPolicy = feishuGuestTierPolicy("observer");
    expect(observerPolicy.wakesUnsandboxedPm).toBe(false);
    expect(observerPolicy.hostPrivilegeWarning).toBeNull();

    for (const tier of ["chat_only", "collaborator"] as const) {
      const policy = feishuGuestTierPolicy(tier);
      expect(policy.tier).toBe(tier);
      expect(policy.wakesUnsandboxedPm).toBe(true);
      expect(policy.hostPrivilegeWarning).not.toBeNull();
      expect(policy.hostPrivilegeWarning).toMatch(/本机|宿主|外层沙箱|shell/u);
    }
  });

  it("S2: renderChatPolicyCard orders guest tiers safest-first and displays the host-privilege warning", () => {
    const catalogs = AGENT_VENDORS.map((vendor) => ({ ...bundledModelCatalog(vendor), availability: "available" as const }));
    const card = renderChatPolicyCard({
      pmId: 2,
      agent: { vendor: "claude", model: null, effort: null },
      catalogs,
      triggerMode: "auto",
      guestTier: "observer",
      mentionOnlyForced: false,
    });
    const tierActions = collectButtonValues(card).filter(
      (v): v is { kind: "set_policy"; pmId: number; guestTier: FeishuGuestTier } =>
        typeof v === "object" && v !== null && (v as Record<string, unknown>).kind === "set_policy" && "guestTier" in v,
    );
    expect(tierActions.map((a) => a.guestTier)).toEqual(["observer", "chat_only", "collaborator"]);
    const renderedText = JSON.stringify(card.body.elements);
    expect(renderedText).toMatch(/外层沙箱|本机当前用户/u);
    expect(renderedText).toMatch(/shell/iu);
  });

  it("S2 & S13: Feishu CLI policy command warns about host-privilege PM when enabling chat_only or collaborator", async () => {
    const runPolicy = async (guestTier: FeishuGuestTier) => {
      const out: string[] = [];
      const err: string[] = [];
      const io: FeishuCliIo = {
        argv: ["policy", "3", "--guest", guestTier],
        stdin: async () => "",
        stdout: { write: (t) => out.push(t) },
        stderr: { write: (t) => err.push(t) },
        admin: async () => ({
          chatId: CHAT_ID,
          target: { kind: "pm", pmId: 3 },
          name: "Alpha",
          mode: "shared",
          triggerMode: "auto",
          guestTier,
          guestCount: 1,
          archived: false,
        }),
        renderQr: () => "",
        sleep: async () => {},
      };
      const code = await runFeishuCli(io);
      return { code, out: out.join(""), err: err.join("") };
    };

    const chatOnly = await runPolicy("chat_only");
    expect(chatOnly.code).toBe(0);
    expect(chatOnly.out).toMatch(/外层沙箱|本机当前用户|shell/iu);

    const collaborator = await runPolicy("collaborator");
    expect(collaborator.code).toBe(0);
    expect(collaborator.out).toMatch(/外层沙箱|本机当前用户|shell/iu);

    const observer = await runPolicy("observer");
    expect(observer.code).toBe(0);
    expect(observer.out).not.toMatch(/外层沙箱|shell/iu);
  });

  it("S3 & S7: FEISHU_GUEST_BLOCKED_HUB_COMMANDS blocks sibling schedule and watch mutations for chat_only and observer guests", () => {
    const requiredBlocks = ["schedule.pause", "schedule.resume", "schedule.remove", "watch.add", "watch.close"] as const;
    for (const tier of ["chat_only", "observer"] as const) {
      for (const cmd of requiredBlocks) {
        expect(FEISHU_GUEST_BLOCKED_HUB_COMMANDS[tier]).toContain(cmd);
        expect(feishuGuestTurnBlockReason(cmd, makeOrigin({ guestTier: tier }))).toMatch(/访客/u);
      }
    }
  });

  it("S4: upgrading from schema 60 downgrades legacy chat_only groups to observer while preserving collaborator and observer", () => {
    const dir = mkdtempSync(join(tmpdir(), "fusa-feishu-mig-"));
    tempDirs.push(dir);
    const v60Migrations = join(dir, "m60");
    cpSync(DEFAULT_MIGRATIONS_DIR, v60Migrations, { recursive: true });
    for (const name of readdirSync(v60Migrations)) {
      const version = /^(\d+)_.*\.sql$/.exec(name)?.[1];
      if (version !== undefined && Number(version) > 60) unlinkSync(join(v60Migrations, name));
    }
    writeMigrationManifest(v60Migrations);

    const db = openDatabase(join(dir, "hub.sqlite"));
    openDbs.push(db);
    expect(migrate(db, v60Migrations).to).toBe(60);

    const pmLegacy = insertPm(db, "Legacy");
    const pmCollab = insertPm(db, "Collab");
    const pmObs = insertPm(db, "Obs");
    db.run(
      "INSERT INTO feishu_chats (chat_id, target, pm_id, name, label, guest_tier, created_at, updated_at) VALUES (?, 'pm', ?, 'Legacy', 'Legacy', 'chat_only', 1, 1)",
      "oc_legacy",
      pmLegacy,
    );
    db.run(
      "INSERT INTO feishu_chats (chat_id, target, pm_id, name, label, guest_tier, created_at, updated_at) VALUES (?, 'pm', ?, 'Collab', 'Collab', 'collaborator', 1, 1)",
      "oc_collab",
      pmCollab,
    );
    db.run(
      "INSERT INTO feishu_chats (chat_id, target, pm_id, name, label, guest_tier, created_at, updated_at) VALUES (?, 'pm', ?, 'Obs', 'Obs', 'observer', 1, 1)",
      "oc_obs",
      pmObs,
    );

    const upgrade = migrate(db, DEFAULT_MIGRATIONS_DIR);
    expect(upgrade.to).toBeGreaterThan(60);

    const store = createFeishuStore(db);
    expect(store.chatById("oc_legacy" as FeishuChatId)?.guestTier).toBe("observer");
    expect(store.chatById("oc_collab" as FeishuChatId)?.guestTier).toBe("collaborator");
    expect(store.chatById("oc_obs" as FeishuChatId)?.guestTier).toBe("observer");

    const pmAfter = insertPm(db, "AfterUpgrade");
    db.run(
      "INSERT INTO feishu_chats (chat_id, target, pm_id, name, label, created_at, updated_at) VALUES (?, 'pm', ?, 'AfterUpgrade', 'AfterUpgrade', 2, 2)",
      "oc_after",
      pmAfter,
    );
    expect(store.chatById("oc_after" as FeishuChatId)?.guestTier).toBe("observer");
  });

  it("S9: one-month volume of chats and messages preserves fail-closed defaults and guest blocks", () => {
    const db = freshDb();
    const store = createFeishuStore(db);
    db.transaction(() => {
      for (let i = 1; i <= 100; i++) {
        const pmId = insertPm(db, `PM-${i}`);
        store.upsertChat(
          { chatId: `oc_bulk_${i}` as FeishuChatId, target: { kind: "pm", pmId }, name: `PM-${i}`, label: `PM-${i}` },
          i,
        );
      }
    });
    expect(store.chats().every((c) => c.guestTier === "observer")).toBe(true);
    expect(feishuGuestTurnBlockReason("watch.add", makeOrigin({ guestTier: "chat_only" }))).toMatch(/访客/u);
  });

  it("S4 & S10 regression: upgrading from schema 60 tightens malformed guest_tier rows to observer without failing CHECK", () => {
    const dir = mkdtempSync(join(tmpdir(), "fusa-feishu-mig-dirty-"));
    tempDirs.push(dir);
    const v60Migrations = join(dir, "m60");
    cpSync(DEFAULT_MIGRATIONS_DIR, v60Migrations, { recursive: true });
    for (const name of readdirSync(v60Migrations)) {
      const version = /^(\d+)_.*\.sql$/.exec(name)?.[1];
      if (version !== undefined && Number(version) > 60) unlinkSync(join(v60Migrations, name));
    }
    writeMigrationManifest(v60Migrations);

    const db = openDatabase(join(dir, "hub.sqlite"));
    openDbs.push(db);
    expect(migrate(db, v60Migrations).to).toBe(60);

    const pmCollab = insertPm(db, "Collab");
    const pmLegacy = insertPm(db, "Legacy");
    const pmDirty = insertPm(db, "Dirty");
    const pmBlank = insertPm(db, "Blank");
    db.exec("PRAGMA ignore_check_constraints = ON");
    try {
      db.run(
        "INSERT INTO feishu_chats (chat_id, target, pm_id, name, label, guest_tier, created_at, updated_at) VALUES (?, 'pm', ?, 'Collab', 'Collab', 'collaborator', 1, 1)",
        "oc_dirty_collab",
        pmCollab,
      );
      db.run(
        "INSERT INTO feishu_chats (chat_id, target, pm_id, name, label, guest_tier, created_at, updated_at) VALUES (?, 'pm', ?, 'Legacy', 'Legacy', 'chat_only', 1, 1)",
        "oc_dirty_legacy",
        pmLegacy,
      );
      db.run(
        "INSERT INTO feishu_chats (chat_id, target, pm_id, name, label, guest_tier, created_at, updated_at) VALUES (?, 'pm', ?, 'Dirty', 'Dirty', 'legacy_admin', 1, 1)",
        "oc_dirty_bad",
        pmDirty,
      );
      db.run(
        "INSERT INTO feishu_chats (chat_id, target, pm_id, name, label, guest_tier, created_at, updated_at) VALUES (?, 'pm', ?, 'Blank', 'Blank', '', 1, 1)",
        "oc_dirty_blank",
        pmBlank,
      );
    } finally {
      db.exec("PRAGMA ignore_check_constraints = OFF");
    }

    const upgrade = migrate(db, DEFAULT_MIGRATIONS_DIR);
    expect(upgrade.to).toBeGreaterThan(60);

    const store = createFeishuStore(db);
    expect(store.chatById("oc_dirty_collab" as FeishuChatId)?.guestTier).toBe("collaborator");
    expect(store.chatById("oc_dirty_legacy" as FeishuChatId)?.guestTier).toBe("observer");
    expect(store.chatById("oc_dirty_bad" as FeishuChatId)?.guestTier).toBe("observer");
    expect(store.chatById("oc_dirty_blank" as FeishuChatId)?.guestTier).toBe("observer");
  });

  it("S10 regression: historical shared messages missing or carrying invalid guestTier preserve main delivery format while failing closed on guest auth", () => {
    const legacyMissingTier = {
      workerId: null,
      sender: "user" as const,
      text: "list open tasks",
      meta: {
        origin: {
          kind: "feishu",
          openId: GUEST,
          name: "Guest",
          role: "guest",
          mode: "shared",
          context: [{ name: "Owner", role: "owner", text: "earlier note", at: 1 }],
        },
      },
    };
    const legacyCorruptTier = {
      ...legacyMissingTier,
      meta: {
        origin: {
          ...legacyMissingTier.meta.origin,
          guestTier: "legacy_unknown",
        },
      },
    };
    const validShared = {
      ...legacyMissingTier,
      meta: {
        origin: {
          ...legacyMissingTier.meta.origin,
          guestTier: "observer",
        },
      },
    };

    expect(deliveryParts(legacyMissingTier)).toEqual({ prefixes: [], text: "list open tasks" });
    expect(deliveryParts(legacyCorruptTier)).toEqual({ prefixes: [], text: "list open tasks" });
    expect(deliveryParts(validShared)).toEqual({
      prefixes: ["【飞书 · Guest（访客）】", "群里之前的讨论（没 @机器人 的话，按时间先后）：\nOwner（主人）：earlier note"],
      text: "list open tasks",
    });

    for (const msg of [legacyMissingTier, legacyCorruptTier]) {
      const authOrigin = feishuOriginOf(msg);
      expect(authOrigin?.guestTier).toBe("observer");
      expect(feishuGuestTurnBlockReason("watch.add", authOrigin)).toMatch(/访客/u);
      expect(feishuGuestTurnBlockReason("schedule.pause", authOrigin)).toMatch(/访客/u);
    }
  });

  it("S9: migrating 100 chats, 300 finished workers, and 30,000 messages from v60 preserves defaults, messages_in_flight index, and guest blocks", () => {
    const dir = mkdtempSync(join(tmpdir(), "fusa-feishu-s9-"));
    tempDirs.push(dir);
    const v60Migrations = join(dir, "m60");
    cpSync(DEFAULT_MIGRATIONS_DIR, v60Migrations, { recursive: true });
    for (const name of readdirSync(v60Migrations)) {
      const version = /^(\d+)_.*\.sql$/.exec(name)?.[1];
      if (version !== undefined && Number(version) > 60) unlinkSync(join(v60Migrations, name));
    }
    writeMigrationManifest(v60Migrations);

    const projectDir = join(dir, "repo");
    const dataHome = join(dir, "hub-data");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(dataHome, { recursive: true });

    const db = openDatabase(join(dir, "hub.sqlite"));
    openDbs.push(db);
    expect(migrate(db, v60Migrations).to).toBe(60);

    let firstPmId = 0;
    let firstConvId = 0;
    let firstSessionId = 0;
    let firstProjectId = 0;
    db.transaction(() => {
      for (let i = 1; i <= 100; i++) {
        const pmId = insertPm(db, `VolPM-${i}`);
        const tier = i % 3 === 0 ? "collaborator" : i % 3 === 1 ? "chat_only" : "observer";
        db.run(
          "INSERT INTO feishu_chats (chat_id, target, pm_id, name, label, guest_tier, created_at, updated_at) VALUES (?, 'pm', ?, ?, ?, ?, ?, ?)",
          `oc_vol_${i}`,
          pmId,
          `VolPM-${i}`,
          `VolPM-${i}`,
          tier,
          i,
          i,
        );
        if (i === 1) {
          firstPmId = pmId;
          firstConvId = db.get<{ id: number }>(
            "INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('pm', ?, 'VolPM-1', 1) RETURNING id",
            pmId,
          )!.id;
          firstProjectId = db.get<{ id: number }>(
            "INSERT INTO projects (name, pm_id, conversation_id, created_at, updated_at) VALUES ('Repo', ?, ?, 1, 1) RETURNING id",
            pmId,
            firstConvId,
          )!.id;
          firstSessionId = db.get<{ id: number }>(
            "INSERT INTO agent_sessions (role, conversation_id, pm_id, vendor, vendor_session_id, cwd, created_at, updated_at) VALUES ('pm', ?, ?, 'claude', 'vs_vol_1', ?, 1, 1) RETURNING id",
            firstConvId,
            pmId,
            projectDir,
          )!.id;
        }
      }

      for (let w = 1; w <= 300; w++) {
        const workerConvId = db.get<{ id: number }>(
          "INSERT INTO conversations (kind, pm_id, project_id, title, created_at) VALUES ('worker', ?, ?, ?, ?) RETURNING id",
          firstPmId,
          firstProjectId,
          `Worker-${w}`,
          w,
        )!.id;
        db.run(
          `INSERT INTO workers (
             project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task,
             readonly, workspace, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'done task', 0, 'main', 'ended', ?, ?)`,
          firstProjectId,
          firstPmId,
          firstConvId,
          workerConvId,
          `Worker-${w}`,
          w,
          w,
        );
      }

      const settledMeta = JSON.stringify({
        origin: { kind: "feishu", openId: OWNER, name: "Owner", role: "owner", mode: "shared", guestTier: "observer", context: [] },
      });
      for (let m = 1; m <= 29_999; m++) {
        db.run(
          `INSERT INTO messages (
             conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at
           ) VALUES (?, ?, 'user', 'text', 'settled', ?, ?, 'replied', ?, ?)`,
          firstConvId,
          firstSessionId,
          settledMeta,
          `vol:settled:${m}`,
          m,
          m,
        );
      }
      const inFlightGuestMeta = JSON.stringify({
        origin: { kind: "feishu", openId: GUEST, name: "Guest", role: "guest", mode: "shared", guestTier: "chat_only", context: [] },
      });
      db.run(
        `INSERT INTO messages (
           conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at
         ) VALUES (?, ?, 'user', 'text', 'create watch', ?, 'vol:inflight:guest', 'processing', 30000, 30000)`,
        firstConvId,
        firstSessionId,
        inFlightGuestMeta,
      );
    });

    const upgrade = migrate(db, DEFAULT_MIGRATIONS_DIR);
    expect(upgrade.to).toBeGreaterThan(60);

    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM workers WHERE status = 'ended'")?.n).toBe(300);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM messages")?.n).toBe(30_000);

    const store = createFeishuStore(db);
    const chats = store.chats();
    expect(chats).toHaveLength(100);
    let collabCount = 0;
    let observerCount = 0;
    for (const chat of chats) {
      if (chat.guestTier === "collaborator") collabCount++;
      else if (chat.guestTier === "observer") observerCount++;
    }
    expect(collabCount).toBe(33);
    expect(observerCount).toBe(67);

    const ledger = createLedger(db, {
      pmHomeRoot: join(dataHome, "pm-home"),
      dataHome,
      worktreesDir: join(dataHome, "worktrees"),
      userHome: dir,
      resolveFolder: createResolveFolder({ dataHome, userHome: dir }),
    });
    const queries = vi.spyOn(db, "all");
    expect(() =>
      ledger.hubCall(firstSessionId, "watch.add", {
        everyMs: 60_000,
        body: "check status",
      }),
    ).toThrow(/访客/u);
    const messageQueries = queries.mock.calls.filter(([sql]) => /\bFROM\s+messages\b/iu.test(sql));
    queries.mockRestore();
    expect(messageQueries).toHaveLength(1);
    const [sql, ...params] = messageQueries[0]!;
    const plan = db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
      .map((r) => r.detail)
      .join(" ");
    expect(plan).toMatch(/\bSEARCH messages USING (?:COVERING )?INDEX messages_in_flight\b/u);
    expect(plan).toContain("messages_in_flight");
    expect(plan).not.toMatch(/\bSCAN messages\b/u);

    expect(resolveFeishuGuestTier("chat_only")).toBe("chat_only");
    expect(resolveFeishuGuestTier("bad")).toBe("observer");
    expect(
      checkReadonlyWorkerSandbox({ vendor: "pi", platform: "win32", osSandboxed: true, readonlyKernelSandboxed: false }).ok,
    ).toBe(false);
  });
});

describe("Feishu guest security boundary (unchanged-rule regressions)", () => {
  it("S1 & S3 regression: observer guest messages stay in passive context and ride along only when the owner speaks", () => {
    const guestRoute = routeFeishuMessage(makeInboundMsg(), makeRoutingCtx({ guestTier: "observer" }));
    expect(guestRoute).toEqual({
      kind: "context",
      line: { name: "Guest", role: "guest", text: "run git status", at: 1000 },
    });

    const ownerRoute = routeFeishuMessage(
      makeInboundMsg({ senderOpenId: OWNER, text: "summarize the thread", at: 2000 }),
      makeRoutingCtx({
        guestTier: "observer",
        speakerName: "Owner",
        pendingContext: [{ name: "Guest", role: "guest", text: "run git status", at: 1000 }],
      }),
    );
    expect(ownerRoute).toMatchObject({
      kind: "deliver",
      origin: {
        role: "owner",
        guestTier: "observer",
        context: [{ name: "Guest", role: "guest", text: "run git status", at: 1000 }],
      },
    });
  });

  it("S3 & S5 regression: downgrading a group from chat_only to observer stops guest wakeups immediately while preserving collaborator and owner permissions", () => {
    expect(feishuGuestMay("observer", "talk")).toBe(false);
    expect(feishuGuestMay("chat_only", "talk")).toBe(true);
    expect(feishuGuestMay("chat_only", "answer_card")).toBe(false);
    expect(feishuGuestMay("collaborator", "answer_card")).toBe(true);

    const db = freshDb();
    const pmId = insertPm(db, "Beta");
    const store = createFeishuStore(db);
    store.upsertChat({ chatId: CHAT_ID, target: { kind: "pm", pmId }, name: "Beta", label: "Beta" }, 1);
    store.setChatPolicy(pmId, { guestTier: "chat_only" }, 2);
    expect(routeFeishuMessage(makeInboundMsg(), makeRoutingCtx({ guestTier: store.chatById(CHAT_ID)!.guestTier })).kind).toBe("deliver");

    store.setChatPolicy(pmId, { guestTier: "observer" }, 3);
    expect(routeFeishuMessage(makeInboundMsg(), makeRoutingCtx({ guestTier: store.chatById(CHAT_ID)!.guestTier })).kind).toBe("context");

    expect(feishuGuestTurnBlockReason("project.attach", makeOrigin({ role: "owner", guestTier: "chat_only" }))).toBeNull();
    expect(feishuGuestTurnBlockReason("project.attach", makeOrigin({ role: "guest", guestTier: "collaborator" }))).toMatch(/访客/u);
  });

  it("S13 regression: guests in any tier cannot open settings cards or change group policy", () => {
    for (const guestTier of FEISHU_GUEST_TIERS) {
      expect(
        routeFeishuMessage(
          makeInboundMsg({ text: "/群设置", mentionedBot: false }),
          makeRoutingCtx({ guestTier }),
        ),
      ).toMatchObject({ kind: "reject", openId: GUEST });

      expect(
        routeFeishuAction(
          {
            chatId: CHAT_ID,
            messageId: MSG_ID,
            operatorOpenId: GUEST,
            value: { kind: "set_policy", pmId: 1, guestTier: "collaborator" },
            note: null,
          },
          { ownerOpenId: OWNER, binding: { target: { kind: "pm", pmId: 1 }, archived: false }, guestTier },
        ),
      ).toMatchObject({ kind: "reject" });
    }
  });
});

import { cpSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FEISHU_GUEST_BLOCKED_HUB_COMMANDS,
  FEISHU_GUEST_TIERS,
  feishuGuestMay,
  feishuGuestTierOrder,
  feishuGuestTierPolicy,
  feishuGuestTurnBlockReason,
  resolveFeishuGuestTier,
  type FeishuChatId,
  type FeishuGuestTier,
  type FeishuMessageId,
  type FeishuMessageOrigin,
  type FeishuOpenId,
} from "../../shared/feishu.ts";
import { AGENT_VENDORS, bundledModelCatalog } from "../../shared/vendors.ts";
import { runFeishuCli, type FeishuCliIo } from "../../feishu/cli.ts";
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

  it("S1: new PM Feishu chat bindings default to observer and do not allow guest wakeups", () => {
    const db = freshDb();
    const pmId = insertPm(db, "Alpha");
    const store = createFeishuStore(db);
    const created = store.upsertChat(
      { chatId: CHAT_ID, target: { kind: "pm", pmId }, name: "Alpha", label: "Alpha" },
      100,
    );
    expect(created.guestTier).toBe("observer");

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

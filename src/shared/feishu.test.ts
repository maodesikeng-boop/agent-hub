import { describe, expect, it } from "vitest";
import {
  FEISHU_GUEST_BLOCKED_HUB_COMMANDS,
  FEISHU_GUEST_TIERS,
  feishuDeliveryPrefixes,
  feishuGuestMay,
  feishuGuestTurnBlockReason,
  parseFeishuAppId,
  parseFeishuCardId,
  parseFeishuChatId,
  parseFeishuImageKey,
  parseFeishuMessageId,
  parseFeishuOpenId,
  type FeishuGuestAction,
  type FeishuMessageOrigin,
  type FeishuOpenId,
} from "./feishu.ts";
import { HUB_COMMANDS } from "./hub.ts";

const origin = (patch: Partial<FeishuMessageOrigin> = {}): FeishuMessageOrigin => ({
  kind: "feishu",
  openId: "ou_owner" as FeishuOpenId,
  name: "张三",
  role: "owner",
  mode: "solo",
  guestTier: "chat_only",
  context: [],
  ...patch,
});

describe("parseFeishu*", () => {
  it("cli_ / ou_ / oc_ / om_ 开头且形状对时返回品牌值，前缀不对、空串、非字符串返回 null", () => {
    expect(parseFeishuAppId("cli_a1b2")).toBe("cli_a1b2");
    expect(parseFeishuOpenId("ou_abc123")).toBe("ou_abc123");
    expect(parseFeishuChatId("oc_abc123")).toBe("oc_abc123");
    expect(parseFeishuMessageId("om_abc123")).toBe("om_abc123");
    for (const parse of [parseFeishuAppId, parseFeishuOpenId, parseFeishuChatId, parseFeishuMessageId]) {
      expect(parse("")).toBeNull();
      expect(parse(42)).toBeNull();
      expect(parse(null)).toBeNull();
      expect(parse("xx_abc")).toBeNull();
    }
    expect(parseFeishuAppId("ou_abc")).toBeNull();
    expect(parseFeishuChatId("oc_")).toBeNull();
    expect(parseFeishuOpenId("ou_a b")).toBeNull();
  });

  it("卡片编号只认非空字母数字，image_key 只认非空字符串", () => {
    expect(parseFeishuCardId("7355abcDEF")).toBe("7355abcDEF");
    expect(parseFeishuCardId("")).toBeNull();
    expect(parseFeishuCardId("a-b")).toBeNull();
    expect(parseFeishuCardId(7)).toBeNull();
    expect(parseFeishuImageKey("img_v3_xx-yy")).toBe("img_v3_xx-yy");
    expect(parseFeishuImageKey("")).toBeNull();
    expect(parseFeishuImageKey(undefined)).toBeNull();
  });
});

const ACTIONS: FeishuGuestAction[] = ["talk", "answer_card", "stop", "send_files"];

describe("feishuGuestMay", () => {
  it("chat_only：能 talk，不能 answer_card、stop、send_files", () => {
    expect(ACTIONS.map((a) => feishuGuestMay("chat_only", a))).toEqual([true, false, false, false]);
  });

  it("collaborator：talk、answer_card、stop、send_files 都能", () => {
    expect(ACTIONS.map((a) => feishuGuestMay("collaborator", a))).toEqual([true, true, true, true]);
  });

  it("observer：四件都不能（说的话只记成背景，由 routing 处理）", () => {
    expect(ACTIONS.map((a) => feishuGuestMay("observer", a))).toEqual([false, false, false, false]);
  });
});

describe("feishuDeliveryPrefixes", () => {
  it("solo 下主人的话、没有背景时返回空数组", () => {
    expect(feishuDeliveryPrefixes(origin())).toEqual([]);
  });

  it("shared 下主人和访客的话各有一行署名，写明显示名和（主人）或（访客）", () => {
    expect(feishuDeliveryPrefixes(origin({ mode: "shared" }))).toEqual(["【飞书 · 张三（主人）】"]);
    expect(feishuDeliveryPrefixes(origin({ mode: "shared", role: "guest", name: "李四" }))).toEqual(["【飞书 · 李四（访客）】"]);
  });

  it("有背景时多一段“群里之前的讨论”，每行“名字（身份）：原话”，按时间先后", () => {
    const prefixes = feishuDeliveryPrefixes(
      origin({
        mode: "shared",
        context: [
          { name: "李四", role: "guest", text: "先看登录页", at: 1 },
          { name: "张三", role: "owner", text: "好，顺便看注册", at: 2 },
        ],
      }),
    );
    expect(prefixes).toHaveLength(2);
    const [, context] = prefixes as [string, string];
    expect(context).toContain("群里之前的讨论");
    const lines = context.split("\n").slice(1);
    expect(lines).toEqual(["李四（访客）：先看登录页", "张三（主人）：好，顺便看注册"]);
  });
});

describe("feishuGuestTurnBlockReason", () => {
  it("每一档访客的话触发的轮次里，本档 FEISHU_GUEST_BLOCKED_HUB_COMMANDS 中的每个命令都返回拒绝原因", () => {
    for (const tier of FEISHU_GUEST_TIERS) {
      for (const command of FEISHU_GUEST_BLOCKED_HUB_COMMANDS[tier]) {
        expect(feishuGuestTurnBlockReason(command, origin({ role: "guest", guestTier: tier, mode: "shared" }))).toMatch(/访客/);
      }
    }
  });

  it("collaborator 档访客的话触发的轮次里 graph.decide、schedule.add 放行", () => {
    const guest = origin({ role: "guest", guestTier: "collaborator", mode: "shared" });
    expect(feishuGuestTurnBlockReason("graph.decide", guest)).toBeNull();
    expect(feishuGuestTurnBlockReason("schedule.add", guest)).toBeNull();
    expect(feishuGuestTurnBlockReason("project.attach", guest)).not.toBeNull();
  });

  it("主人的话、网页的话（origin 为 null）、表外命令返回 null", () => {
    for (const command of HUB_COMMANDS) {
      expect(feishuGuestTurnBlockReason(command, origin({ role: "owner", guestTier: "chat_only" }))).toBeNull();
      expect(feishuGuestTurnBlockReason(command, null)).toBeNull();
    }
    expect(feishuGuestTurnBlockReason("status", origin({ role: "guest" }))).toBeNull();
    expect(feishuGuestTurnBlockReason("ask", origin({ role: "guest", guestTier: "observer" }))).toBeNull();
  });
});

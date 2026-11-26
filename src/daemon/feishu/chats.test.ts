import { describe, expect, it } from "vitest";
import type { Pm } from "../../shared/domain.ts";
import type { FeishuChatId } from "../../shared/feishu.ts";
import { PM_FRUITS, pmFruitOf } from "../../shared/fruits.ts";
import { FEISHU_CHAT_NAME_MAX_CHARS, FEISHU_CHAT_UUID_MAX_CHARS } from "../../shared/limits.ts";
import { defaultLookOf, resolvePmLook } from "../../shared/slimes.ts";
import { desiredFeishuChats, feishuChatCreateUuid, feishuChatMarker, planFeishuChatSync } from "./chats.ts";
import type { FeishuChatBinding } from "./store.ts";

const DEVICE = { id: "11111111-2222-3333-4444-555555555555", name: "东京" };
const pm = (id: number, name: string, archivedAt: number | null = null): Pm => ({
  id,
  name,
  mode: "manage_only",
  vendor: "claude",
  defaultModel: null,
  effort: null,
  personaFile: null,
  createdAt: 1,
  archivedAt,
});
const binding = (pmId: number | null, patch: Partial<FeishuChatBinding> = {}): FeishuChatBinding => ({
  chatId: `oc_${pmId ?? "gone"}` as FeishuChatId,
  target: pmId === null ? { kind: "pm", pmId: null } : { kind: "pm", pmId },
  name: "小林",
  label: "小林",
  avatarLook: defaultLookOf(pmId ?? 0),
  triggerMode: "auto",
  guestTier: "chat_only",
  archivedAt: null,
  createdAt: 1,
  lastMessageId: null,
  lastRouterEventId: null,
  ...patch,
});
const plan = (pms: Pm[], bindings: FeishuChatBinding[], marked: [string, string][] = []) =>
  planFeishuChatSync(desiredFeishuChats(pms, DEVICE), bindings, new Map(marked as [FeishuChatId, string][]), DEVICE.id);

describe("desiredFeishuChats", () => {
  it("每个项目经理一个（含已归档的），群名是项目经理名字，最长 60 字", () => {
    const long = "长".repeat(FEISHU_CHAT_NAME_MAX_CHARS + 10);
    const specs = desiredFeishuChats([pm(1, "小林"), pm(2, long, 5)], DEVICE);
    expect(specs.map((s) => [s.pmId, s.archived])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(specs[0]!.name).toBe("小林");
    expect([...specs[1]!.name]).toHaveLength(FEISHU_CHAT_NAME_MAX_CHARS);
    expect(specs[1]!.label).toBe(long);
    expect(specs[0]!.name).not.toContain("东京");
  });

  it("形象和网页上项目经理的头像一致（同一份 shared/slimes.ts）；群说明带 feishuChatMarker", () => {
    const specs = desiredFeishuChats(Array.from({ length: PM_FRUITS.length + 2 }, (_, i) => pm(i, `p${i}`)), DEVICE);
    for (const spec of specs) {
      expect(spec.look).toBe(defaultLookOf(spec.pmId));
      expect(spec.description.endsWith(feishuChatMarker(DEVICE.id, spec.pmId))).toBe(true);
      expect(spec.description).toContain("东京");
    }
  });
});

describe("feishuChatMarker / feishuChatCreateUuid", () => {
  it("同一组输入总是同一个值，不同项目经理不同", () => {
    expect(feishuChatMarker(DEVICE.id, 1)).toBe(feishuChatMarker(DEVICE.id, 1));
    expect(feishuChatMarker(DEVICE.id, 1)).not.toBe(feishuChatMarker(DEVICE.id, 2));
    expect(feishuChatCreateUuid("cli_a", DEVICE.id, 1, 0)).toBe(feishuChatCreateUuid("cli_a", DEVICE.id, 1, 0));
    expect(feishuChatCreateUuid("cli_a", DEVICE.id, 1, 0)).not.toBe(feishuChatCreateUuid("cli_a", DEVICE.id, 2, 0));
    expect(feishuChatCreateUuid("cli_a", DEVICE.id, 1, 0)).not.toBe(feishuChatCreateUuid("cli_b", DEVICE.id, 1, 0));
  });

  it("generation 不同时 uuid 不同（取消归档重建的群不会被当成重复请求）", () => {
    expect(feishuChatCreateUuid("cli_a", DEVICE.id, 1, 0)).not.toBe(feishuChatCreateUuid("cli_a", DEVICE.id, 1, 1_700_000_000_000));
  });

  it("uuid 不超过 50 字", () => {
    expect(feishuChatCreateUuid("cli_" + "a".repeat(100), DEVICE.id, 123456, 1_700_000_000_000).length).toBeLessThanOrEqual(FEISHU_CHAT_UUID_MAX_CHARS);
  });
});

describe("planFeishuChatSync", () => {
  it("没有记录的未归档项目经理 create（generation 0）；机器人所在群里有它的标记时 adopt，不新建", () => {
    expect(plan([pm(1, "小林")], [])).toMatchObject([{ kind: "create", generation: 0, spec: { pmId: 1 } }]);
    expect(plan([pm(1, "小林")], [], [["oc_found", feishuChatMarker(DEVICE.id, 1)]])).toMatchObject([{ kind: "adopt", chatId: "oc_found", spec: { pmId: 1 } }]);
    expect(plan([pm(1, "小林")], [], [["oc_other", feishuChatMarker("99999999-2222-3333-4444-555555555555", 1)]])).toMatchObject([{ kind: "create" }]);
  });

  it("没有记录的已归档项目经理什么都不做", () => {
    expect(plan([pm(1, "小林", 5)], [])).toEqual([]);
  });

  it("项目经理改名 rename；飞书里被人改了群名（label 没变）不改回去", () => {
    expect(plan([pm(1, "小周")], [binding(1)])).toEqual([{ kind: "rename", chatId: "oc_1", name: "小周", label: "小周" }]);
    expect(plan([pm(1, "小林")], [binding(1, { name: "别人改的名字" })])).toEqual([]);
  });

  it("没记过头像 set_avatar", () => {
    expect(plan([pm(1, "小林")], [binding(1, { avatarLook: null })])).toEqual([{ kind: "set_avatar", chatId: "oc_1", look: defaultLookOf(1) }]);
  });

  it("头像图片换了被清空（avatarLook 是 null）：只出 set_avatar，用户在飞书里改过的群名不出 rename", () => {
    expect(plan([pm(1, "小林")], [binding(1, { avatarLook: null, name: "用户在飞书里改的名" })])).toEqual([{ kind: "set_avatar", chatId: "oc_1", look: defaultLookOf(1) }]);
  });

  it("记录的形象和应有的不同（造型不同）也 set_avatar", () => {
    const other = PM_FRUITS.find((f) => f !== pmFruitOf(1))!;
    expect(plan([pm(1, "小林")], [binding(1, { avatarLook: { fruit: other, color: other } })])).toEqual([{ kind: "set_avatar", chatId: "oc_1", look: defaultLookOf(1) }]);
  });

  it("项目经理归档 → dissolve；已归档的记录不再出 rename、set_avatar", () => {
    expect(plan([pm(1, "小林", 5)], [binding(1)])).toEqual([{ kind: "dissolve", chatId: "oc_1" }]);
    expect(plan([pm(1, "改名了", 5)], [binding(1, { archivedAt: 5, avatarLook: null })])).toEqual([]);
  });

  it("取消归档 → create，generation 是记录的 archivedAt", () => {
    expect(plan([pm(1, "小林")], [binding(1, { archivedAt: 1234 })])).toMatchObject([{ kind: "create", generation: 1234, spec: { pmId: 1 } }]);
  });

  it("pm_id 为 null 的记录 retire，记录已归档时 dissolved 为 true", () => {
    expect(plan([], [binding(null)])).toEqual([{ kind: "retire", chatId: "oc_gone", dissolved: false }]);
    expect(plan([], [binding(null, { archivedAt: 9 })])).toEqual([{ kind: "retire", chatId: "oc_gone", dissolved: true }]);
  });

  it("已对齐时返回空数组；同一份输入算两次结果相同", () => {
    const pms = [pm(1, "小林"), pm(2, "阿周", 3), pm(3, "新来的")];
    const bindings = [binding(1), binding(2, { archivedAt: 3 })];
    expect(plan(pms, bindings)).toEqual(plan(pms, bindings));
    expect(plan([pm(1, "小林")], [binding(1)])).toEqual([]);
  });
});

describe("群头像跟着项目经理的形象（docs/slime-cohesion-design.md）", () => {
  it("desiredFeishuChats：每个群要的头像是 resolvePmLook(项目经理)，换过造型、颜色的按换过的", () => {
    const pms = [{ ...pm(1, "小林"), avatarFruit: "persimmon", avatarColor: "sky" } as const, { ...pm(2, "阿周"), avatarColor: "teal" } as const, pm(3, "新来的")];
    expect(desiredFeishuChats(pms, DEVICE).map((s) => s.look)).toEqual(pms.map((p) => resolvePmLook(p)));
    expect(desiredFeishuChats(pms, DEVICE)[0]!.look).toEqual({ fruit: "persimmon", color: "sky" });
    expect(desiredFeishuChats(pms, DEVICE)[1]!.look).toEqual({ fruit: pmFruitOf(2), color: "teal" });
  });

  it("项目经理换了颜色：下一次对齐给它的群原地换头像，别的群不动", () => {
    const recolored = { ...pm(1, "小林"), avatarColor: "sakura" } as const;
    expect(plan([recolored, pm(2, "阿周")], [binding(1), binding(2, { name: "阿周", label: "阿周" })])).toEqual([{ kind: "set_avatar", chatId: "oc_1", look: { fruit: pmFruitOf(1), color: "sakura" } }]);
  });
});

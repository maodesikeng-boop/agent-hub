// 同源三合一拍板动作（decision-actions.ts）单元测试：
// 覆盖 router_item 与 gate 两种来源的一键纯点选、点选+补充备注、纯文字自定义答复与空输入拦截。
import { describe, expect, it, vi } from "vitest";
import type { PendingDecision } from "../shared/index.ts";
import { cleanOptionLabel, recommendedIndexOf, submitDecision } from "./decision-actions.ts";

function makeRouterDecision(over: Partial<PendingDecision> = {}): PendingDecision {
  return {
    key: "item:local:42",
    deviceId: "local",
    pmId: 1,
    pmName: "小林",
    projectId: 10,
    projectName: "agent-hub",
    conversationId: 1,
    question: "用哪种缓存策略？",
    context: "需要兼顾多设备同步",
    options: ["(Recommended) WeakMap 按引用缓存", "LRU 定时过期"],
    askMessageId: 100,
    createdAt: 1_000,
    updatedAt: 1_000,
    source: { kind: "router_item", itemId: 42 },
    ...over,
  };
}

function makeGateDecision(over: Partial<PendingDecision> = {}): PendingDecision {
  return {
    key: "gate:local:7:pick-db",
    deviceId: "local",
    pmId: 2,
    pmName: "阿青",
    projectId: 20,
    projectName: "core-db",
    conversationId: 2,
    question: "是否开启 WAL 模式？",
    context: "下游 2 个节点等此门禁解锁",
    options: ["开启 WAL", "保持默认"],
    askMessageId: 200,
    createdAt: 2_000,
    updatedAt: 2_000,
    source: {
      kind: "gate",
      graphId: 7,
      graphTitle: "存储升级",
      nodeKey: "pick-db",
      nodeTitle: "确认 WAL",
      blockedNodeCount: 2,
      nextNodeTitles: ["迁移脚本", "压测"],
      recommended: "开启 WAL",
    },
    ...over,
  };
}

describe("recommendedIndexOf 与 cleanOptionLabel", () => {
  it("gate 来源优先认 source.recommended，router_item 认 (Recommended) / （推荐）前缀并剥离显示标签", () => {
    const gate = makeGateDecision();
    expect(recommendedIndexOf(gate)).toBe(0);
    expect(cleanOptionLabel("开启 WAL")).toBe("开启 WAL");

    const item = makeRouterDecision();
    expect(recommendedIndexOf(item)).toBe(0);
    expect(cleanOptionLabel(item.options[0]!)).toBe("WeakMap 按引用缓存");
    expect(cleanOptionLabel("（推荐）直接上线")).toBe("直接上线");

    const plain = makeRouterDecision({ options: ["方案一", "方案二"] });
    expect(recommendedIndexOf(plain)).toBeNull();
  });
});

describe("submitDecision：三合一拍板提交", () => {
  it("router_item：一键纯点选秒定（note 为空时不传 note）", async () => {
    const postResolveRouterItem = vi.fn().mockResolvedValue({ item: {}, messageId: 301 });
    const postTaskGraphDecide = vi.fn();
    await submitDecision(
      { postResolveRouterItem, postTaskGraphDecide },
      makeRouterDecision(),
      { optionIndex: 1, note: "   ", clientId: "cid-1" },
    );
    expect(postResolveRouterItem).toHaveBeenCalledWith(42, {
      clientId: "cid-1",
      optionIndex: 1,
    });
    expect(postTaskGraphDecide).not.toHaveBeenCalled();
  });

  it("router_item：点选 + 附带单行补充备注", async () => {
    const postResolveRouterItem = vi.fn().mockResolvedValue({ item: {}, messageId: 302 });
    const postTaskGraphDecide = vi.fn();
    await submitDecision(
      { postResolveRouterItem, postTaskGraphDecide },
      makeRouterDecision(),
      { optionIndex: 0, note: "  加上容量上限守卫  ", clientId: "cid-2" },
    );
    expect(postResolveRouterItem).toHaveBeenCalledWith(42, {
      clientId: "cid-2",
      optionIndex: 0,
      note: "加上容量上限守卫",
    });
  });

  it("router_item：不点选项、纯文字回车自定义答复（optionIndex: null）", async () => {
    const postResolveRouterItem = vi.fn().mockResolvedValue({ item: {}, messageId: 303 });
    const postTaskGraphDecide = vi.fn();
    await submitDecision(
      { postResolveRouterItem, postTaskGraphDecide },
      makeRouterDecision(),
      { optionIndex: null, note: "先缓一缓，等压测结果", clientId: "cid-3" },
    );
    expect(postResolveRouterItem).toHaveBeenCalledWith(42, {
      clientId: "cid-3",
      optionIndex: null,
      note: "先缓一缓，等压测结果",
    });
  });

  it("gate：点选方案（保留原始选项文本）+ 备注，以及纯文字意见（choice: null）", async () => {
    const postResolveRouterItem = vi.fn();
    const postTaskGraphDecide = vi.fn().mockResolvedValue({ graph: {}, messageId: 401 });
    const gate = makeGateDecision();

    await submitDecision(
      { postResolveRouterItem, postTaskGraphDecide },
      gate,
      { optionIndex: 0, note: "同步加上 busy_timeout", clientId: "cid-4" },
    );
    expect(postTaskGraphDecide).toHaveBeenCalledWith(7, "pick-db", {
      clientId: "cid-4",
      choice: "开启 WAL",
      note: "同步加上 busy_timeout",
    });

    await submitDecision(
      { postResolveRouterItem, postTaskGraphDecide },
      gate,
      { optionIndex: null, note: "先只读压测一轮", clientId: "cid-5" },
    );
    expect(postTaskGraphDecide).toHaveBeenLastCalledWith(7, "pick-db", {
      clientId: "cid-5",
      choice: null,
      note: "先只读压测一轮",
    });
    expect(postResolveRouterItem).not.toHaveBeenCalled();
  });

  it("既没选方案也没填文字、或下标越界时直接拒绝", async () => {
    const client = { postResolveRouterItem: vi.fn(), postTaskGraphDecide: vi.fn() };
    await expect(submitDecision(client, makeRouterDecision(), { optionIndex: null, note: "   " })).rejects.toThrow();
    await expect(submitDecision(client, makeRouterDecision(), { optionIndex: 9, note: "" })).rejects.toThrow();
    expect(client.postResolveRouterItem).not.toHaveBeenCalled();
  });
});

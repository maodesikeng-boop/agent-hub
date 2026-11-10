// useComposerSuggest 里 agent-hub 自己的命令（/hub:worker）和它的多级参数列表。
// 名单从 react-query 的 ["models", 设备] 里来（和资料页同一份缓存），测试直接往缓存里放。
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledModelCatalog, HUB_COMPOSER_COMMANDS, type AgentVendor, type ComposerCommand, type ModelCatalog } from "../shared/index.ts";
import { type ComposerSource, useComposerSuggest } from "./composer-suggest.ts";
import { ModelCatalogProvider } from "./models.tsx";
import { queryClient } from "./query-client.ts";

const VENDOR_COMMANDS: ComposerCommand[] = [
  { name: "review", description: "复查改动" },
  { name: "compact", description: "压缩上下文" },
];

const catalog = (vendor: AgentVendor, over: Partial<ModelCatalog> = {}): ModelCatalog => ({ ...bundledModelCatalog(vendor), ...over });
// 没登录的那家排第一：高亮要跳过它
const CATALOGS: ModelCatalog[] = [
  catalog("agy", { label: "Antigravity", availability: "signed_out" }),
  catalog("claude", {
    label: "Claude Code",
    availability: "available",
    models: [{ id: "opus", label: "Opus", description: null, efforts: ["low", "high"] }],
    defaultModel: "Opus",
    defaultEfforts: ["low", "high"],
    efforts: ["low", "high"],
  }),
];

function source(over: Partial<ComposerSource> = {}): ComposerSource {
  return { commands: vi.fn(async () => VENDOR_COMMANDS), files: vi.fn(async () => ({ entries: [], truncated: false })), hubCommands: HUB_COMPOSER_COMMANDS, ...over };
}

function setup(src: ComposerSource, initial: string, wrapper?: (props: { children: ReactNode }) => ReactNode) {
  const onReplace = vi.fn();
  const hook = renderHook(({ value }) => useComposerSuggest({ source: src, value, cursor: value.length, enabled: true, onReplace }), {
    initialProps: { value: initial },
    wrapper,
  });
  return { hook, onReplace, menu: () => hook.result.current.menu };
}

const key = (k: string) => ({ key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, keyCode: 0, nativeEvent: { isComposing: false }, stopPropagation() {} }) as never;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("“/” 列表里的 hub 命令", () => {
  it("项目经理对话：hub 命令排在厂商命令最前面", async () => {
    const { menu } = setup(source(), "/");
    await waitFor(() => expect(menu()?.items).toHaveLength(3));
    expect(menu()?.items.map((i) => i.label)).toEqual(["/hub:worker", "/review", "/compact"]);
    expect(menu()?.items[0]?.detail).toBe("Pick provider, model and effort for Workers");
  });

  it("筛选时同一档里 hub 命令也在前面", async () => {
    const { menu } = setup(source(), "/o");
    await waitFor(() => expect(menu()?.items.map((i) => i.label)).toEqual(["/hub:worker", "/compact"]));
  });

  it("厂商命令拉失败：hub 命令照样出现", async () => {
    const src = source({ commands: vi.fn(async () => Promise.reject(new Error("boom"))) });
    const { menu } = setup(src, "/");
    await waitFor(() => expect(src.commands).toHaveBeenCalled());
    await act(async () => {});
    expect(menu()?.items.map((i) => i.label)).toEqual(["/hub:worker"]);
  });

  it("厂商名单里也有同名的：只列一个（hub 的）", async () => {
    const src = source({ commands: vi.fn(async () => [{ name: "hub:worker", description: "user plugin" }, ...VENDOR_COMMANDS]) });
    const { menu } = setup(src, "/");
    await waitFor(() => expect(menu()?.items).toHaveLength(3));
    expect(menu()?.items.filter((i) => i.label === "/hub:worker").map((i) => i.detail)).toEqual(["Pick provider, model and effort for Workers"]);
  });

  it("不是项目经理对话（source 不带 hub 命令）：没有 /hub:worker，打了也不弹参数列表", async () => {
    const src = source({ hubCommands: undefined });
    const { menu, hook } = setup(src, "/");
    await waitFor(() => expect(menu()?.items).toHaveLength(2));
    expect(menu()?.items.map((i) => i.label)).not.toContain("/hub:worker");
    hook.rerender({ value: "/hub:worker " });
    await act(async () => {});
    expect(menu()).toBeNull();
  });
});

describe("/hub:worker 的三级列表", () => {
  it("厂商 → 模型 → 思考程度，每级插入 id 和一个空格", async () => {
    queryClient.setQueryData(["models", ""], CATALOGS);
    const { hook, menu, onReplace } = setup(source(), "/hub:worker ");
    expect(menu()?.kind).toBe("vendor");
    expect(menu()?.items.map((i) => i.label)).toEqual(["Antigravity", "Claude Code"]);
    act(() => hook.result.current.select(menu()!.items[1]!));
    expect(onReplace).toHaveBeenLastCalledWith("/hub:worker claude ", 19);

    hook.rerender({ value: "/hub:worker claude " });
    expect(menu()?.kind).toBe("model");
    expect(menu()?.items.map((i) => i.label)).toEqual(["Default", "Opus"]);
    act(() => hook.result.current.select(menu()!.items[1]!));
    expect(onReplace).toHaveBeenLastCalledWith("/hub:worker claude opus ", 24);

    hook.rerender({ value: "/hub:worker claude opus " });
    expect(menu()?.kind).toBe("effort");
    act(() => hook.result.current.select(menu()!.items[2]!));
    // PR2 的终点：完整命令留在文字里，列表收起（变小标签是 PR3）
    expect(onReplace).toHaveBeenLastCalledWith("/hub:worker claude opus high ", 29);
    hook.rerender({ value: "/hub:worker claude opus high " });
    expect(menu()).toBeNull();
  });

  it("没登录的厂商：高亮默认跳过它，↑↓ 也跳过；点了不选，Enter 吞掉（不发送也不插入）", () => {
    queryClient.setQueryData(["models", ""], CATALOGS);
    const { hook, menu, onReplace } = setup(source(), "/hub:worker ");
    expect(menu()?.items[0]?.disabled).toBe(true);
    expect(menu()?.activeIndex).toBe(1);
    act(() => void hook.result.current.handleKey(key("ArrowDown")));
    expect(menu()?.activeIndex).toBe(1);
    act(() => hook.result.current.select(menu()!.items[0]!));
    expect(onReplace).not.toHaveBeenCalled();

    // 只剩不能选的那一行：Enter 也算处理了（不让它把半截命令发出去）
    hook.rerender({ value: "/hub:worker anti" });
    expect(menu()?.items.map((i) => i.label)).toEqual(["Antigravity"]);
    expect(menu()?.activeIndex).toBe(-1);
    let handled = false;
    act(() => void (handled = hook.result.current.handleKey(key("Enter"))));
    expect(handled).toBe(true);
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("没有匹配：空列表（界面写 No matching …），Enter 不拦", () => {
    queryClient.setQueryData(["models", ""], CATALOGS);
    const { hook, menu } = setup(source(), "/hub:worker zzz");
    expect(menu()).toMatchObject({ kind: "vendor", items: [] });
    expect(hook.result.current.handleKey(key("Enter"))).toBe(false);
  });

  it("同一份名单、同样的文字：列表是同一个数组（不让列表组件白重画）", () => {
    queryClient.setQueryData(["models", ""], CATALOGS);
    const { hook, menu } = setup(source(), "/hub:worker cl");
    const items = menu()?.items;
    hook.rerender({ value: "/hub:worker cl" });
    expect(menu()?.items).toBe(items);
  });

  it("名单还没拉到：先用打包的名单，不等请求", () => {
    const { menu } = setup(source(), "/hub:worker ");
    expect(menu()?.kind).toBe("vendor");
    expect(menu()?.items.length).toBeGreaterThan(0);
  });
});

describe("模型名单的请求：只在打开 “/” 列表时拉一次，打字不发", () => {
  it("普通打字不拉；打 / 时拉一次；之后选厂商、打字筛都不再拉", async () => {
    const fetchModels = vi.fn(async () => new Response(JSON.stringify({ catalogs: CATALOGS }), { headers: { "content-type": "application/json" } }));
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/api/models") ? fetchModels() : realFetch(input, init),
    );
    const wrapper = ({ children }: { children: ReactNode }) => createElement(ModelCatalogProvider, null, children);
    const src = source();
    const { hook, menu } = setup(src, "", wrapper);
    for (const value of ["h", "he", "hello"]) hook.rerender({ value });
    await act(async () => {});
    expect(fetchModels).not.toHaveBeenCalled();

    hook.rerender({ value: "/" });
    await waitFor(() => expect(fetchModels).toHaveBeenCalledTimes(1));
    for (const value of ["/h", "/hub:worker", "/hub:worker ", "/hub:worker c", "/hub:worker cl", "/hub:worker claude ", "/hub:worker claude o"]) {
      hook.rerender({ value });
      await act(async () => {});
    }
    expect(menu()?.items.map((i) => i.label)).toEqual(["Opus", "Default"]);
    expect(fetchModels).toHaveBeenCalledTimes(1);
  });
});

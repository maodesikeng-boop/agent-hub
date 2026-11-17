import { describe, it } from "vitest";

describe("visibleCapabilityGroups", () => {
  it.todo("按名字和说明搜索，不分大小写");
  it.todo("filter 为 on 时只留开着的项");
  it.todo("一项都不剩的组不返回");
  it.todo("组里全开、全关、部分开分别是 on、off、mixed");
  it.todo("同一个 view、同样的 query 和 filter 返回同一个数组");
});

describe("capabilitySummary", () => {
  it.todo("返回这一类开着的项数");
  it.todo("这一类没有项时返回 null");
});

describe("sharedVendorLabels", () => {
  it.todo("列出这一组里只能共用全局配置的厂商");
});

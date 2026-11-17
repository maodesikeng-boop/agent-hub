import { describe, it } from "vitest";

describe("PmCapabilitiesRows", () => {
  it.todo("三行显示开着的项数，没有项的那一类不显示");
  it.todo("点一行调 onOpen 并带上这一类");
});

describe("CapabilityList", () => {
  it.todo("输入搜索词后只剩匹配的项和它们的组");
  it.todo("点项的开关立刻 PATCH，失败时退回并在那一行下写原因");
  it.todo("点组开关一次 PATCH 整组");
  it.todo("New items 改成 Off 时 PATCH base");
  it.todo("只能共用全局配置的厂商在组里显示 Shared 标签");
});

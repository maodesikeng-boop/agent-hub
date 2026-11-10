// 左栏的三档布局（Sidebar 的 layout）：wide 300px、rail 72px、page 手机整屏（铺满、不标选中）；layout 优先，没传时按窗口宽度。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Sidebar, type SidebarLayout } from "./components/Sidebar.tsx";
import type { ConversationEntry } from "./selectors.ts";
import { makeMessage } from "./test-utils.ts";

afterEach(cleanup);

const entry: ConversationEntry = { id: 1, name: "小林", avatarKey: 1, lastMessage: makeMessage({ id: 9, text: "好的" }), lastAt: 1, pm: null, project: null, folders: [] };
const groups = [{ key: "", name: "本机", platform: "darwin", status: "online" as const, lastOnlineAt: null, entries: [entry] }];
const props = { waiting: new Set<string>(), asking: new Set<string>(), notify: { permission: "granted" as const, enabled: true, setEnabled: async () => {} }, quota: [], onNewPm: () => {} };

const sidebar = (extra: { layout?: SidebarLayout } = {}) => {
  render(<Sidebar groups={groups} active={{ device: "", id: 1 }} onSelect={() => {}} {...props} {...extra} />);
  return screen.getByRole("complementary", { name: "Sidebar" });
};

describe("Sidebar layout", () => {
  it("wide：300px，当前行有选中标记", () => {
    const aside = sidebar({ layout: "wide" });
    expect(aside).toHaveClass("w-75");
    expect(screen.getByRole("button", { name: /小林/ })).toHaveAttribute("aria-current", "true");
  });

  it("rail：72px 头像窄栏", () => {
    const aside = sidebar({ layout: "rail" });
    expect(aside).toHaveClass("w-18", "border-r");
    expect(screen.getByRole("button", { name: "小林" })).toHaveAttribute("aria-current", "true");
  });

  it("page：整屏宽，宽栏的内容，不显示选中（没有选中底色、没有 aria-current）", () => {
    const aside = sidebar({ layout: "page" });
    expect(aside).toHaveClass("w-full");
    expect(aside).not.toHaveClass("w-75", "w-18");
    expect(screen.getByRole("searchbox", { name: "Search" })).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /小林/ });
    expect(row).not.toHaveAttribute("aria-current");
    expect(row).not.toHaveClass("bg-jelly");
  });

  it("没传 layout 时按媒体查询（默认宽屏）", () => {
    expect(sidebar()).toHaveClass("w-75");
  });
});

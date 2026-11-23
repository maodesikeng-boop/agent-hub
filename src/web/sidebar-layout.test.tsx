// ProjectList 的三档布局：column（桌面可调列）、strip（72px 头像条）、page（手机整屏：铺满、不标选中）。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectList, type ProjectListLayout } from "./components/ProjectList.tsx";
import { LOCAL_DEVICE } from "./devices.ts";
import type { ConversationEntry } from "./selectors.ts";
import { makeMessage } from "./test-utils.ts";

import { defaultLookOf } from "../shared/slimes.ts";
afterEach(cleanup);

const entry: ConversationEntry = { id: 1, name: "小林", look: defaultLookOf(1), lastMessage: makeMessage({ id: 9, text: "好的" }), lastAt: 1, pm: null, project: null, folders: [] };
const baseProps = {
  computer: { key: LOCAL_DEVICE, name: "本机", status: "online" as const },
  switchable: false,
  entries: [entry],
  active: { device: LOCAL_DEVICE, id: 1 },
  waiting: new Set<string>(),
  asking: new Set<string>(),
  readOnly: false,
  onSelect: () => {},
  onNewPm: () => {},
  onTogglePin: () => {},
  onOpenPmSettings: () => {},
  onOpenComputers: () => {},
};

const listRegion = (layout: ProjectListLayout) => {
  render(<ProjectList layout={layout} {...baseProps} />);
  return screen.getByRole("region", { name: "本机" });
};

describe("ProjectList layout", () => {
  it("column：填满容器宽，当前行有选中标记", () => {
    const region = listRegion("column");
    expect(region).toHaveClass("h-full");
    expect(screen.getByRole("button", { name: /小林/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /小林/ }).closest(".project-row")).toHaveClass("border-select-line", "bg-background");
  });

  it("strip：72px 头像窄条", () => {
    const region = listRegion("strip");
    expect(region).toHaveClass("w-18", "shrink-0");
    expect(screen.getByRole("button", { name: "小林" })).toHaveAttribute("aria-current", "page");
  });

  it("page：整屏宽，带搜索框，不显示选中（没有选中底色、没有 aria-current）", () => {
    const region = listRegion("page");
    expect(region).toHaveClass("flex-1");
    expect(region).not.toHaveClass("w-18");
    expect(screen.getByRole("searchbox", { name: "Search conversations" })).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /小林/ });
    expect(row).not.toHaveAttribute("aria-current");
    expect(row.closest(".project-row")).not.toHaveClass("border-select-line", "bg-background");
  });
});

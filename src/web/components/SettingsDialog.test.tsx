// 设置弹窗右栏的宽度约束（docs/ui-standard.md 第 10 条）：任何宽度下行右边的按钮（Sign out、Show QR code、Sign in……）都完整可见。
// jsdom 不排版，所以这里守住的是让浏览器做对的那几个类名（根因：放不下的内容把右栏撑出弹窗，按钮被 overflow 裁掉）；真实排版的截图见 PR。
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionInfo } from "../../shared/index.ts";
import type { NotifySettings } from "../notify.ts";
import { FakeApi, makeSnapshot } from "../test-utils.ts";
import { SettingsDialog } from "./SettingsDialog.tsx";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";

const sessions: BrowserSessionInfo[] = [
  { id: "android", userAgent: ANDROID, createdAt: 0, lastSeenAt: Date.now(), current: false },
  { id: "mac", userAgent: MAC, createdAt: 0, lastSeenAt: Date.now(), current: true },
];
const notify: NotifySettings = { permission: "granted", enabled: false, setEnabled: vi.fn(async () => {}) };
const devices = {
  devices: [],
  onChanged: vi.fn(),
};

const classOf = (el: Element) => el.className.split(/\s+/);

beforeEach(() => {
  const api = new FakeApi(makeSnapshot({}));
  api.browserSessions = () => ({ status: 200, body: { sessions } });
  api.install();
});

async function openSecurity() {
  const user = userEvent.setup();
  render(<SettingsDialog open onOpenChange={() => {}} notify={notify} devices={devices} />);
  await user.click(screen.getByRole("tab", { name: "Security & Access" }));
  const panel = screen.getByRole("tabpanel", { name: "Security & Access" });
  await user.click(within(panel).getByRole("button", { name: /Signed-in browsers/ }));
  await within(panel).findByText("Android Chrome");
  return panel;
}

const rowOf = (el: HTMLElement) => el.closest("[data-slot='settings-row']") as HTMLElement;
/** 行里放控件（按钮、输入框）的那一块：SettingsRow 的第二个子块。 */
const controlsOf = (row: HTMLElement) => row.firstElementChild!.lastElementChild as HTMLElement;

describe("设置弹窗：右栏宽度跟着弹窗走，按钮不被挤出去", () => {
  it("右栏 min-w-0、分组那一列 grid-cols-1：内容再长也撑不开右栏（长内容曾把按钮挤到弹窗外面）", async () => {
    const panel = await openSecurity();
    expect(classOf(panel)).toContain("min-w-0");
    const scroller = panel.lastElementChild as HTMLElement;
    expect(classOf(scroller)).toContain("grid-cols-1");
    expect(classOf(scroller)).toContain("overflow-y-auto");
    for (const group of within(panel).getAllByRole("region")) {
      // 自己是 grid 的分组（带标题的）列宽也不跟内容走
      if (classOf(group).includes("grid")) expect(classOf(group)).toContain("grid-cols-1");
    }
  });

  it("会话那一行：Sign out 在行右边那块里，那块靠右、不收缩、不比行宽；左边名字和小字能收（截断、换行）让路", async () => {
    const panel = await openSecurity();
    const row = rowOf(within(panel).getByText("Android Chrome"));
    const controls = controlsOf(row);
    expect(within(controls).getByRole("button", { name: /^Sign out/ })).toBeVisible();
    expect(classOf(controls)).toEqual(expect.arrayContaining(["ml-auto", "shrink-0", "max-w-full"]));
    const line = row.firstElementChild as HTMLElement;
    expect(classOf(line)).toContain("flex-wrap"); // 放不下时按钮换到下一行，不出界
    const left = line.firstElementChild as HTMLElement;
    expect(classOf(left)).toEqual(expect.arrayContaining(["min-w-32", "flex-1"]));
    expect(classOf(within(row).getByText("Android Chrome"))).toContain("line-clamp-2");
  });

  it("所有行的右边块（Sign out、Sign out all、Show QR code）都是同一套：靠右、不收缩、不比行宽", async () => {
    const panel = await openSecurity();
    for (const name of ["Show QR code", "Sign out Mac Chrome", "Sign out all"]) {
      const controls = controlsOf(rowOf(within(panel).getByRole("button", { name })));
      expect(classOf(controls)).toEqual(expect.arrayContaining(["ml-auto", "shrink-0", "max-w-full"]));
    }
  });

  it("切到别的分类（General、Capabilities、Computers）右栏同一套约束", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onOpenChange={() => {}} notify={notify} devices={devices} />);
    for (const name of ["General", "Capabilities", "Computers"]) {
      await user.click(screen.getByRole("tab", { name }));
      const panel = screen.getByRole("tabpanel", { name });
      expect(classOf(panel)).toContain("min-w-0");
      await waitFor(() => expect(classOf(panel.lastElementChild!)).toContain("grid-cols-1"));
    }
  });

  it("从别处点进能力页：defaultSection 直接落在 Capabilities", async () => {
    render(<SettingsDialog open onOpenChange={() => {}} notify={notify} devices={devices} defaultSection="capabilities" />);
    expect(screen.getByRole("tab", { name: "Capabilities" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("region", { name: "MCP servers" })).toBeInTheDocument();
  });
});

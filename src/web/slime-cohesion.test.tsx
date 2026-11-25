import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { JELLY_COLOR_IDS, lookKey, opticalLiftOf, routerBellPaths, slimePaths, type SlimeLook } from "../shared/slimes.ts";
import { App } from "./App.tsx";
import { createClient } from "./client.ts";
import { Avatar } from "./components/Avatar.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { RouterAvatar } from "./components/RouterAvatar.tsx";
import { SlimePicker } from "./components/SlimePicker.tsx";
import { AppRail } from "./components/AppRail.tsx";
import { ProjectList, type ProjectListLayout } from "./components/ProjectList.tsx";
import { LOCAL_DEVICE } from "./devices.ts";
import { avatarTileFillOf } from "./lib/palette.ts";
import { DeviceScope } from "./device-scope.tsx";
import { serverInfoFor } from "../shared/index.ts";
import { FakeApi, FakeWebSocket, installFakeWebSocket, makeConvSnapshot, makeMessage, makePm, makeSnapshot, makeUserMessage, openFirstConversation, type Reply } from "./test-utils.ts";

const look: SlimeLook = { fruit: "orange", color: "sky" };
const avatarArt = (root: ParentNode) => [...root.querySelectorAll("svg path")].map((path) => ({ d: path.getAttribute("d"), fill: path.getAttribute("fill") }));

function deferredReply() {
  let resolve!: (reply: Reply) => void;
  const promise = new Promise<Reply>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("史莱姆与总助", () => {
  it("嫩芽铃用共享像素稿、透明头像与 rem 尺寸，只有工作时摇摆", () => {
    const { container, rerender } = render(<RouterAvatar size={48} />);
    const root = container.querySelector('[data-slot="router-avatar"]');
    expect(root?.getAttribute("style")).toContain("width: 3rem");
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(avatarArt(container)).toEqual(routerBellPaths());
    expect(container.querySelector("svg")).not.toHaveAttribute("data-working");
    rerender(<RouterAvatar size={48} working />);
    expect(container.querySelector("svg")).toHaveAttribute("data-working", "true");
  });

  it("史莱姆按身体上移，便签小灵跟随颜色且与水果造型无关", () => {
    const { container, rerender } = render(<Avatar look={look} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("viewBox", `0 ${opticalLiftOf(look.fruit, "main")} 12 12`);
    expect(svg).toHaveClass("overflow-visible");
    expect(avatarArt(container)).toEqual(slimePaths(look, "main"));
    rerender(<Avatar look={look} neutral />);
    const piece = avatarArt(container);
    expect(piece).toEqual(slimePaths(look, "piece"));
    expect(container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 12 12");
    rerender(<Avatar look={{ fruit: "kiwi", color: look.color }} neutral />);
    expect(avatarArt(container)).toEqual(piece);
    rerender(<Avatar look={{ fruit: "kiwi", color: "teal" }} neutral />);
    expect(avatarArt(container)).not.toEqual(piece);
  });

  it.each<ProjectListLayout>(["column", "page"])("%s 左栏列表与 AppRail 保持紧凑头像框与 slot 按钮样式（单行列表用项目经理颜色的圆角方块）", (layout) => {
    const entries = [
      { id: 1, name: "Juniper", lastMessage: makeMessage({ id: 10, text: "One update" }), lastAt: 1 },
      { id: 2, name: "Fern", lastMessage: null, lastAt: 0 },
    ].map((entry) => ({ ...entry, look, pm: null, project: null, folders: [] }));
    render(
      <DeviceScope client={createClient(null)} server={serverInfoFor("darwin")}>
        <div className="flex">
          <AppRail
            router={{ active: false, pendingCount: 2, working: false, onSelect: vi.fn() }}
            computers={[]}
            selectedComputer={LOCAL_DEVICE}
            meter={null}
            quota={[]}
            quotaFetchable={false}
            onSelectComputer={vi.fn()}
            onOpenSettings={vi.fn()}
            onOpenUpdates={vi.fn()}
            onOpenAccount={vi.fn()}
          />
          <ProjectList
            layout={layout}
            computer={{ key: LOCAL_DEVICE, name: "This computer", status: "online" }}
            switchable={false}
            entries={entries}
            active={null}
            waiting={new Set()}
            asking={new Set()}
            readOnly={false}
            query=""
            onQueryChange={vi.fn()}
            onSelect={vi.fn()}
            onNewPm={vi.fn()}
            onTogglePin={vi.fn()}
            onOpenComputers={vi.fn()}
          />
        </div>
      </DeviceScope>,
    );
    expect(screen.getByRole("button", { name: "Router (2 waiting)" }).querySelector('[data-slot="router-avatar"]')?.getAttribute("style")).toContain("width: 2.25rem");
    for (const name of ["Juniper", "Fern"]) {
      const tile = screen.getByRole("button", { name: new RegExp(name) }).querySelector(".avatar-tile");
      expect(tile).toHaveAttribute("data-look", lookKey(look));
      expect(tile).toHaveStyle({ backgroundColor: avatarTileFillOf(look.color) });
    }
    expect(screen.getByRole("button", { name: "New project manager" })).toHaveClass("btn-honey");
  });
});

describe("换水果和颜色", () => {
  it("先选造型再选颜色，预览跟着更新，浮层保持打开", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    const picker = (value: SlimeLook) => <SlimePicker look={value} onChange={change}><button>Change look</button></SlimePicker>;
    const { rerender } = render(picker(look));
    await user.click(screen.getByRole("button", { name: "Change look" }));
    const fruit = screen.getByRole("radiogroup", { name: "Fruit" });
    const color = screen.getByRole("radiogroup", { name: "Color" });
    expect(within(fruit).getAllByRole("radio")).toHaveLength(20);
    expect(within(color).getAllByRole("radio")).toHaveLength(JELLY_COLOR_IDS.length);
    for (const avatar of fruit.querySelectorAll("[data-look]")) expect(avatar.getAttribute("data-look")).toMatch(/:sky$/);
    const selected = within(fruit).getByRole("radio", { checked: true });
    expect(selected).toHaveClass("tile-open");
    expect(within(color).getByRole("radio", { checked: true })).toHaveClass("tile-open");
    expect(selected).toHaveFocus();
    await user.keyboard("{ArrowRight}{Enter}");
    const next = change.mock.lastCall?.[0];
    expect(next).toMatchObject({ color: "sky" });
    expect(next.fruit).not.toBe(look.fruit);
    rerender(picker(next));
    await user.click(within(color).getByRole("radio", { name: /teal/i }));
    expect(change).toHaveBeenLastCalledWith({ fruit: next.fruit, color: "teal" });
    expect(screen.getByRole("radiogroup", { name: "Fruit" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("radiogroup", { name: "Fruit" })).not.toBeInTheDocument();
  });

  it("连点换色再点回原色，旧请求的回推不会让资料页头像闪回", async () => {
    const user = userEvent.setup();
    const orange = makePm({ id: 1, name: "Fern", avatarFruit: "orange", avatarColor: "orange" });
    const sky = { ...orange, avatarColor: "sky" } satisfies typeof orange;
    const snapshot = makeSnapshot({
      pms: [orange],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "Fern" } })],
    });
    openFirstConversation(snapshot);
    const api = new FakeApi(snapshot);
    const first = deferredReply();
    const second = deferredReply();
    api.putPmLook = (_id, body) => body.color === "sky" ? first.promise : second.promise;
    api.install();
    installFakeWebSocket();
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.last.open());
    await user.click(await screen.findByRole("button", { name: "View Fern's profile" }));
    const trigger = await screen.findByRole("button", { name: "Change look" });
    await user.click(trigger);
    const colors = within(screen.getByRole("radiogroup", { name: "Color" }));
    const avatar = () => trigger.querySelector("[data-look]");
    await user.click(colors.getByRole("radio", { name: "Sky" }));
    expect(avatar()).toHaveAttribute("data-look", "orange:sky");
    await user.click(colors.getByRole("radio", { name: "Orange" }));
    expect(avatar()).toHaveAttribute("data-look", "orange:orange");

    await act(async () => first.resolve({ status: 200, body: { pm: sky } }));
    await waitFor(() => expect(api.calls.filter((call) => call.method === "PUT" && call.path === "/api/pms/1/look")).toHaveLength(2));
    await act(async () => second.resolve({ status: 200, body: { pm: orange } }));
    const pushLook = (seq: number, pm: typeof orange) => act(() => FakeWebSocket.last.push({ seq, type: "pm.updated", data: { pm } }));
    pushLook(snapshot.seq + 1, sky);
    expect(avatar()).toHaveAttribute("data-look", "orange:orange");
    pushLook(snapshot.seq + 2, orange);
    expect(avatar()).toHaveAttribute("data-look", "orange:orange");
    pushLook(snapshot.seq + 3, sky);
    expect(avatar()).toHaveAttribute("data-look", "orange:sky");
  });

  it("资料页保存失败后恢复旧形象，新建弹窗也能打开选择器", async () => {
    const user = userEvent.setup();
    const snapshot = makeSnapshot({
      pms: [makePm({ id: 1, name: "Fern", avatarFruit: "orange", avatarColor: "sky" })],
      conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "Fern" } })],
    });
    openFirstConversation(snapshot);
    const api = new FakeApi(snapshot);
    api.putPmLook = () => ({ status: 500, body: { error: "save failed" } });
    api.install();
    installFakeWebSocket();
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.last.open());
    await user.click(await screen.findByRole("button", { name: "View Fern's profile" }));
    const trigger = await screen.findByRole("button", { name: "Change look" });
    await user.click(trigger);
    await user.click(within(screen.getByRole("radiogroup", { name: "Color" })).getByRole("radio", { name: /teal/i }));
    expect(await within(screen.getByRole("dialog", { name: "Change look" })).findByRole("alert")).toBeVisible();
    expect(trigger.querySelector("[data-look]")).toHaveAttribute("data-look", "orange:sky");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "New project manager" }));
    await user.click(await screen.findByRole("button", { name: "Change look" }));
    expect(screen.getByRole("radiogroup", { name: "Fruit" })).toBeVisible();
  });
});

describe("消息流当前轮", () => {
  const messages = [
    makeUserMessage({ id: 1, text: "First" }), makeMessage({ id: 2, text: "Previous response" }),
    makeUserMessage({ id: 3, text: "Second" }), makeMessage({ id: 4, text: "Current response" }),
  ];
  it.each([false, true])("只有当前轮头像跟跳，结束就停下（Piece=%s）", (neutral) => {
    const identity = { name: "Fern", look, neutral };
    const list = (status: ReactNode) => <MessageList
      messages={messages} pending={[]} agentOf={() => identity} statusAgent={identity} hasMore={false} older={undefined}
      onLoadOlder={() => {}} onRetry={() => {}} status={status}
      actions={{ retry: {}, onOpenWorker: () => {}, onRetryMessage: () => {}, onRevertPersona: async () => {} }}
    />;
    const { container, rerender } = render(list(<span>Working…</span>));
    const heads = [...container.querySelectorAll('[data-slot="agent-head"]')];
    expect(heads).toHaveLength(2);
    expect(heads[0]?.querySelector("svg")).not.toHaveAttribute("data-working");
    expect(heads[1]?.querySelector("svg")).toHaveAttribute("data-working", "true");
    rerender(list(null));
    expect(container.querySelector("svg[data-working]")).toBeNull();
  });
});

// 交付物在四处的显示：对话里的提问卡（AskCard）、右栏 Needs You 和果皮轨门禁卡、总助拍板卡、总助简报（components/Deliverables.tsx）。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_PATHS,
  emptyRouterSlice,
  FILE_EXPIRED_TEXT,
  sentFileMime,
  serverInfoFor,
  type Deliverable,
  type DeviceInfo,
  type Message,
  type RouterDecisionItem,
  type RouterReportItem,
  type StateSnapshot,
  type TaskGraph,
  type TaskNode,
} from "../shared/index.ts";
import { App } from "./App.tsx";
import { createClient } from "./client.ts";
import { DeliverableFiles } from "./components/Deliverables.tsx";
import { RightRail } from "./components/RightRail.tsx";
import { DeviceScope } from "./device-scope.tsx";
import { resetQueryClient } from "./query-client.ts";
import {
  FakeApi,
  FakeWebSocket,
  installFakeNotification,
  installFakeWebSocket,
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeProject,
  makeSnapshot,
  openFirstConversation,
} from "./test-utils.ts";

const LOCAL_ID = "00000000-0000-4000-8000-000000000001";
const TOKYO_ID = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";

let seq = 0;
function d(label: string, name: string, over: Partial<Deliverable> = {}): Deliverable {
  seq += 1;
  return {
    label,
    id: seq.toString(16).padStart(16, "0"),
    name,
    mime: sentFileMime(name),
    size: 100,
    href: `/tmp/${name}`,
    origin: { messageId: 7, index: seq % 4 },
    ...over,
  };
}

const plan = d("方案", "plan.md");
const verdict = d("验收结论", "verdict.md");
const shot = d("桌面截图", "desktop.png");
const rec = d("录屏", "rec.mp4");
const all = [plan, shot, verdict, rec];

beforeEach(() => {
  resetQueryClient();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response("# 方案", { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const user = userEvent.setup();
const thumbOf = (root: HTMLElement, label: string) => within(root).getByRole("button", { name: label });

describe("DeliverableFiles", () => {
  it("md、pdf 显示成一行文件链接，标签是交付物的 label", () => {
    const pdf = d("评审记录", "review.pdf");
    const { container } = render(<DeliverableFiles deliverables={[plan, pdf, shot]} />);
    const docs = container.querySelector("[data-deliverable-documents]") as HTMLElement;
    expect(within(docs).getAllByRole("button").map((b) => b.textContent)).toEqual(["方案", "评审记录"]);
    expect(within(docs).getByRole("button", { name: "方案" })).toHaveAttribute("data-file-link");
  });

  it("png 显示成 96px 高的缩略图，点开预览窗看大图", async () => {
    const { container } = render(<DeliverableFiles deliverables={[shot]} />);
    const media = container.querySelector("[data-deliverable-media]") as HTMLElement;
    const img = within(media).getByRole("img", { name: "桌面截图" });
    expect(img).toHaveAttribute("src", API_PATHS.sentFile(shot.id, shot.name));
    expect(img).toHaveClass("h-24");
    await user.click(thumbOf(media, "桌面截图"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("img")).toHaveAttribute("src", `${API_PATHS.sentFile(shot.id, shot.name)}?inline=1`);
  });

  it("mp4 显示成带播放键的缩略图，点开预览窗里是原生播放器", async () => {
    const { container } = render(<DeliverableFiles deliverables={[rec]} />);
    const media = container.querySelector("[data-deliverable-media]") as HTMLElement;
    const thumb = media.querySelector("video") as HTMLVideoElement;
    expect(thumb).toHaveAttribute("preload", "metadata");
    expect(thumb.autoplay).toBe(false);
    expect(media.querySelector("[data-play-badge]")).not.toBeNull();
    await user.click(thumbOf(media, "录屏"));
    const dialog = await screen.findByRole("dialog");
    const player = dialog.querySelector("video") as HTMLVideoElement;
    expect(player).toHaveAttribute("controls");
  });

  it("副本取不到（404）时显示“文件已过期”，不留破图", () => {
    const { container } = render(<DeliverableFiles deliverables={[shot, rec]} />);
    fireEvent.error(container.querySelector("img")!);
    fireEvent.error(container.querySelector("video")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getAllByText(FILE_EXPIRED_TEXT)).toHaveLength(2);
  });

  it("列表为空时不渲染任何东西", () => {
    const { container } = render(<DeliverableFiles deliverables={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("别的设备的条目，文件地址走那台设备的 client.url", () => {
    const { container } = render(
      <DeviceScope client={createClient(TOKYO_ID)} server={serverInfoFor("linux")}>
        <DeliverableFiles deliverables={[shot]} />
      </DeviceScope>,
    );
    expect(container.querySelector("img")).toHaveAttribute("src", `/d/${TOKYO_ID}${API_PATHS.sentFile(shot.id, shot.name)}`);
  });
});

function makeNode(over: Partial<TaskNode> & Pick<TaskNode, "key" | "title">): TaskNode {
  return {
    status: "pending",
    waitingFor: null,
    skipped: false,
    sortOrder: 0,
    activeWorkerId: null,
    workerIds: [],
    artifact: null,
    gateQuestion: null,
    gateOptions: [],
    gateSummaryMd: null,
    gateRecommended: null,
    gateAskMessageId: null,
    decision: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

function gateGraph(): TaskGraph {
  return {
    id: 5,
    projectId: 10,
    pmId: 1,
    conversationId: 1,
    title: "交付物",
    status: "active",
    originMsgId: null,
    nodes: [
      makeNode({
        key: "impl",
        title: "实现",
        status: "waiting",
        waitingFor: "user",
        activeWorkerId: 31,
        workerIds: [31],
        artifact: { summary: "做完了", deliverables: all },
        gateQuestion: "请确认步骤「实现」的结果",
        gateOptions: ["通过", "打回"],
        gateSummaryMd: "**摘要**：做完了",
        gateRecommended: "通过",
        gateAskMessageId: 77,
        gateCheckpoint: true,
      }),
    ],
    edges: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: null,
  };
}

const askMessage = (over: Partial<Message> & Pick<Message, "id">): Message =>
  makeMessage({ dedupeKey: `ask:1:${over.id}`, createdAt: 5_000, ...over });

async function bootApp(snapshot: StateSnapshot) {
  installFakeWebSocket();
  installFakeNotification("default");
  const api = new FakeApi(snapshot);
  api.install();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  act(() => {
    for (const ws of FakeWebSocket.instances) if (ws.readyState === 0) ws.open();
  });
  return api;
}

describe("四处入口", () => {
  it("对话里的提问卡：AskMeta.deliverables 列在卡片正文下面", async () => {
    const ask = askMessage({
      id: 50,
      text: "方案好了，请验收\n\n补充说明",
      meta: { needsUser: true, options: ["通过", "打回"], deliverables: [plan, shot] },
    });
    const snapshot = makeSnapshot({ conversations: [makeConvSnapshot([ask])] });
    openFirstConversation(snapshot);
    await bootApp(snapshot);
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-ask-card]");
      expect(el).not.toBeNull();
      return el!;
    });
    const files = card.querySelector<HTMLElement>("[data-deliverables]")!;
    expect(files).not.toBeNull();
    expect(within(files).getByRole("button", { name: "方案" })).toBeInTheDocument();
    expect(within(files).getByRole("img", { name: "桌面截图" })).toBeInTheDocument();
    // 在选项上面
    const options = within(card).getByRole("group", { name: "Options" });
    expect(files.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("对话里的提问卡：正文里写了同一个本机链接时，链接也能点开预览", async () => {
    const ask = askMessage({
      id: 51,
      text: `请看[方案](${plan.href})再拍板`,
      meta: { needsUser: true, options: ["通过", "打回"], deliverables: [plan] },
    });
    const snapshot = makeSnapshot({ conversations: [makeConvSnapshot([ask])] });
    openFirstConversation(snapshot);
    await bootApp(snapshot);
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-ask-card]");
      expect(el).not.toBeNull();
      return el!;
    });
    const titleLinks = [...card.querySelectorAll<HTMLElement>("[data-file-link]")].filter((el) => !el.closest("[data-deliverables]"));
    expect(titleLinks.map((el) => el.textContent)).toEqual(["方案"]);
    expect(card.querySelector(`a[href="${plan.href}"]`)).toBeNull();
  });

  it("右栏 Needs You 的提问行展开后列出交付物", async () => {
    const ask = askMessage({ id: 52, text: "方案好了，请验收", meta: { needsUser: true, deliverables: [plan, rec] } });
    render(
      <RightRail asks={[ask]} workers={[]} activeGraphs={[]} openWorkerId={null} layout="side" avatarKey={1} onOpenAsk={() => {}} onOpenWorker={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: /方案好了，请验收/ }));
    const files = document.querySelector<HTMLElement>("[data-deliverables]")!;
    expect(files).not.toBeNull();
    expect(within(files).getByRole("button", { name: "方案" })).toBeInTheDocument();
    expect(within(files).getByRole("button", { name: "录屏" })).toBeInTheDocument();
  });

  it("果皮轨门禁卡列出该步 artifact.deliverables", () => {
    render(
      <RightRail asks={[]} workers={[]} activeGraphs={[gateGraph()]} openWorkerId={null} layout="side" avatarKey={1} onOpenAsk={() => {}} onOpenWorker={() => {}} />,
    );
    const card = screen.getByTestId("peel-gate-card");
    const files = card.querySelector<HTMLElement>("[data-deliverables]")!;
    expect(within(files).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["方案", "验收结论", "桌面截图", "录屏"]);
  });

  describe("总助", () => {
    function decisionItem(over: Partial<RouterDecisionItem> = {}): RouterDecisionItem {
      return {
        id: 101,
        kind: "decision",
        status: "pending",
        pmId: 1,
        projectId: 10,
        conversationId: 1,
        question: "方案标准改好了，请验收",
        context: "",
        options: ["通过", "打回"],
        askMessageId: null,
        resolution: null,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
        ...over,
      };
    }
    function reportItem(over: Partial<RouterReportItem> = {}): RouterReportItem {
      return {
        id: 201,
        kind: "report",
        status: "archived",
        pmId: 1,
        projectId: 10,
        conversationId: 1,
        summary: "任务图 #22 做完了",
        links: [{ label: "PR #333", target: "https://github.com/o/r/pull/333" }],
        createdAt: Date.now() - 30_000,
        updatedAt: Date.now() - 30_000,
        ...over,
      };
    }
    function snapshotWith(over: Partial<StateSnapshot>): StateSnapshot {
      return makeSnapshot({
        pms: [makePm({ id: 1, name: "小林" })],
        projects: [makeProject({ id: 10, name: "agent-hub", pmId: 1, conversationId: 1 })],
        conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, projectId: 10, title: "小林" } })],
        ...over,
      });
    }

    /** 本机 + 可选的 Tokyo：Tokyo 的接口走 /d/<编号>/ 代理。 */
    function installFleet(local: StateSnapshot, tokyo?: StateSnapshot) {
      installFakeWebSocket();
      installFakeNotification("default");
      const localApi = new FakeApi(local);
      const tokyoApi = tokyo ? new FakeApi(tokyo) : null;
      const devices: DeviceInfo[] = [
        { id: LOCAL_ID, name: "MacBook", self: true, platform: "darwin", url: null },
        ...(tokyoApi ? [{ id: TOKYO_ID, name: "Tokyo", self: false, platform: "linux", url: "https://tokyo.tailnet.ts.net" }] : []),
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = new URL(String(input), "http://127.0.0.1:1");
          if (url.pathname === "/api/devices") return new Response(JSON.stringify({ devices }), { status: 200, headers: { "content-type": "application/json" } });
          const peer = /^\/d\/([^/]+)(\/.*)$/.exec(url.pathname);
          if (peer && tokyoApi) return tokyoApi.fetch(peer[2]! + url.search, init);
          if (url.pathname === "/api/router/commands") {
            return new Response(JSON.stringify({ commands: [], nextCursor: null, hasMore: false }), { status: 200, headers: { "content-type": "application/json" } });
          }
          return localApi.fetch(input, init);
        }),
      );
    }

    async function openRouter() {
      render(<App />);
      await screen.findByRole("heading", { level: 1, name: "Router" });
      act(() => {
        for (const ws of FakeWebSocket.instances) if (ws.readyState === 0) ws.open();
      });
    }

    it("总助拍板卡：门禁步骤列出该步交付物，独立待决项列出 router 条目上的", async () => {
      const item = decisionItem({ deliverables: [verdict] });
      installFleet(snapshotWith({ router: { ...emptyRouterSlice(), items: [item] }, activeTaskGraphs: [gateGraph()] }));
      await openRouter();
      const tray = await screen.findByRole("region", { name: "Needs You" });
      const gateCard = await within(tray).findByRole("article", { name: "请确认步骤「实现」的结果" });
      expect(within(gateCard.querySelector<HTMLElement>("[data-deliverables]")!).getByRole("button", { name: "录屏" })).toBeInTheDocument();
      await user.click(within(tray).getByRole("button", { name: /方案标准改好了，请验收/ }));
      const itemCard = await within(tray).findByRole("article", { name: "方案标准改好了，请验收" });
      expect(within(itemCard.querySelector<HTMLElement>("[data-deliverables]")!).getByRole("button", { name: "验收结论" })).toBeInTheDocument();
    });

    it("总助简报：deliverables 列在正文下面，链接行只剩网址、Worker、对话", async () => {
      installFleet(snapshotWith({ router: { ...emptyRouterSlice(), items: [reportItem({ deliverables: [plan, rec] })] } }));
      await openRouter();
      const briefing = await waitFor(() => {
        const el = document.querySelector<HTMLElement>("[data-router-briefing]");
        expect(el).not.toBeNull();
        return el!;
      });
      const files = briefing.querySelector<HTMLElement>("[data-deliverables]")!;
      expect(within(files).getByRole("button", { name: "方案" })).toBeInTheDocument();
      expect(within(files).getByRole("button", { name: "录屏" })).toBeInTheDocument();
      expect(within(briefing).getByRole("link", { name: /PR #333/ })).toBeInTheDocument();
    });

    it("别的设备的拍板卡，缩略图地址走那台设备的代理", async () => {
      const local = snapshotWith({});
      const tokyo = makeSnapshot({
        pms: [makePm({ id: 2, name: "阿青" })],
        projects: [makeProject({ id: 20, name: "tokyo-api", pmId: 2, conversationId: 2 })],
        conversations: [makeConvSnapshot([], { conversation: { id: 2, pmId: 2, projectId: 20, title: "阿青" } })],
        router: { ...emptyRouterSlice(), items: [decisionItem({ id: 901, pmId: 2, projectId: 20, conversationId: 2, deliverables: [shot] })] },
      });
      installFleet(local, tokyo);
      await openRouter();
      const tray = await screen.findByRole("region", { name: "Needs You" });
      const img = await within(tray).findByRole("img", { name: "桌面截图" });
      expect(img).toHaveAttribute("src", `/d/${TOKYO_ID}${API_PATHS.sentFile(shot.id, shot.name)}`);
    });

    it("老条目（没有 deliverables 字段）照原样显示，不报错", async () => {
      installFleet(snapshotWith({ router: { ...emptyRouterSlice(), items: [decisionItem(), reportItem()] } }));
      await openRouter();
      const tray = await screen.findByRole("region", { name: "Needs You" });
      await within(tray).findByRole("article", { name: "方案标准改好了，请验收" });
      expect(document.querySelector("[data-deliverables]")).toBeNull();
      expect(document.querySelector("[data-router-briefing]")).not.toBeNull();
    });
  });
});

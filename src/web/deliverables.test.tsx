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
import { TaskGraphDialog } from "./components/TaskGraphDialog.tsx";
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

import { defaultLookOf } from "../shared/slimes.ts";
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
    expect(img).toHaveClass("h-(--deliverable-media-height)");
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

/** 卡片正文（不算下面的文件行）里能点开预览的文件链接；本机路径不留成普通链接。 */
function expectBodyFileLinks(card: HTMLElement, labels: string[]) {
  const links = [...card.querySelectorAll<HTMLElement>("[data-file-link]")].filter((el) => !el.closest("[data-deliverables]"));
  expect(links.map((el) => el.textContent)).toEqual(labels);
  expect(card.querySelector('a[href^="/tmp/"]')).toBeNull();
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

/** 拍板卡只在放大全览弹窗里画（右栏果皮轨里那一步只有一行）。 */
const renderGateDialog = (graph: TaskGraph) =>
  render(<TaskGraphDialog open graph={graph} workers={[]} color={defaultLookOf(1).color} onOpenChange={() => {}} onOpenWorker={() => {}} />);

const LONG_DETAILS = "**交棒要点**：\n" + "改了卡片的顺序，".repeat(40) + "\n\n提交 `22f68fed` · PR https://github.com/o/r/pull/333";
const CHECKPOINT_TEXT = `**摘要**：做完了\n\n${LONG_DETAILS}`;

/** 细节默认收起：只看得到摘要和文件；Show more 展开后细节排在文件后面，Show less 收回。 */
async function expectLeadFilesThenDetails(card: HTMLElement) {
  const files = card.querySelector<HTMLElement>("[data-deliverables]")!;
  expect(files).not.toBeNull();
  const lead = within(card).getByText(/做完了/);
  expect(lead.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(card).queryByText(/交棒要点/)).toBeNull();
  expect(within(card).queryByText(/22f68fed/)).toBeNull();
  const more = within(card).getByRole("button", { name: "Show more" });
  expect(more).toHaveAttribute("aria-expanded", "false");
  await user.click(more);
  const details = within(card).getByText(/交棒要点/);
  expect(files.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(card).getByText(/22f68fed/)).toBeInTheDocument();
  await user.click(within(card).getByRole("button", { name: "Show less" }));
  expect(within(card).queryByText(/交棒要点/)).toBeNull();
}

/** jsdom 不排版：细节框按文字算高度，每 40 字一行、一行 22px（15px 字），比两行矮就是“一行放得下”。 */
function layoutDetailsByText() {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (!this.hasAttribute("data-card-details")) return original.call(this);
    const height = Math.ceil((this.textContent ?? "").length / 40) * 22;
    return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: height, width: 600, height, toJSON: () => ({}) } as DOMRect;
  });
}

describe("细节只占一行时直接显示，不收起（各处同一个规则）", () => {
  beforeEach(() => layoutDetailsByText());

  it("全览弹窗的门禁卡：细节只有一行提交号，直接显示、不出 Show more", () => {
    const graph = gateGraph();
    graph.nodes[0] = { ...graph.nodes[0]!, gateSummaryMd: "**摘要**：做完了\n\n提交 `22f68fed`" };
    renderGateDialog(graph);
    const card = screen.getByTestId("peel-gate-card");
    const files = card.querySelector<HTMLElement>("[data-deliverables]")!;
    const details = within(card).getByText(/22f68fed/);
    expect(files.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /Show (more|less)/ })).toBeNull();
  });

  it("全览弹窗的门禁卡：细节超过一行照旧收起", async () => {
    const graph = gateGraph();
    graph.nodes[0] = { ...graph.nodes[0]!, gateSummaryMd: CHECKPOINT_TEXT };
    renderGateDialog(graph);
    await expectLeadFilesThenDetails(screen.getByTestId("peel-gate-card"));
  });
});

describe("各处入口", () => {
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

  it("对话里的提问卡：摘要 → 文件 → 细节，交棒、提交、PR 默认收起", async () => {
    const ask = askMessage({
      id: 53,
      text: `请确认步骤「实现」的结果\n\n${CHECKPOINT_TEXT}`,
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
    await expectLeadFilesThenDetails(card);
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

  describe("带文件的提问卡什么时候了结", () => {
    const cardOf = (id: number) => document.querySelector<HTMLElement>(`[data-message-id="${id}"] [data-ask-card]`)!;
    const optionsOf = (card: HTMLElement) => within(card).getAllByRole("button").filter((b) => b.hasAttribute("data-ask-option"));
    async function expectPlanOpens(card: HTMLElement) {
      const files = card.querySelector<HTMLElement>("[data-deliverables]")!;
      await user.click(within(files).getByRole("button", { name: "方案" }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
    }

    it("用户在输入框发一条普通消息：卡还在等，文件行还能点开", async () => {
      const ask = askMessage({ id: 60, text: "方案好了，请验收", meta: { needsUser: true, options: ["通过", "打回"], deliverables: [plan] } });
      const snapshot = makeSnapshot({ conversations: [makeConvSnapshot([ask])] });
      openFirstConversation(snapshot);
      const api = await bootApp(snapshot);
      await waitFor(() => expect(cardOf(60)).not.toBeNull());
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "先看看再说" } });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      await waitFor(() => expect(api.calls.some((c) => c.path === "/api/conversations/1/messages")).toBe(true));
      for (const b of optionsOf(cardOf(60))) expect(b).not.toBeDisabled();
      await expectPlanOpens(cardOf(60));
    });

    it("两张卡答掉一张：另一张带文件的卡还在等，文件行还能点开", async () => {
      const withFiles = askMessage({ id: 61, text: "方案好了，请验收", meta: { needsUser: true, options: ["通过", "打回"], deliverables: [plan, shot] } });
      const other = askMessage({ id: 62, text: "用 A 还是 B？", meta: { needsUser: true, options: ["A", "B"] } });
      const snapshot = makeSnapshot({ conversations: [makeConvSnapshot([withFiles, other])] });
      openFirstConversation(snapshot);
      const api = await bootApp(snapshot);
      await waitFor(() => expect(cardOf(62)).not.toBeNull());
      await user.click(optionsOf(cardOf(62))[1]!);
      await waitFor(() => expect(api.calls.filter((c) => c.path === "/api/asks/62/answer")).toHaveLength(1));
      expect(api.calls.filter((c) => c.path === "/api/asks/61/answer")).toEqual([]);
      for (const b of optionsOf(cardOf(61))) expect(b).not.toBeDisabled();
      expect(within(cardOf(61).querySelector<HTMLElement>("[data-deliverables]")!).getByRole("img", { name: "桌面截图" })).toBeInTheDocument();
      await expectPlanOpens(cardOf(61));
    });

    it("同一个对话里还挂着 Waiting on you 提醒卡：提醒卡能点 Done，带文件的卡照样在等、文件能点开", async () => {
      const blocker = askMessage({ id: 64, text: "这台设备的 Antigravity 没登录", meta: { needsUser: true, blockerRef: { blockerId: 5 } } });
      const withFiles = askMessage({ id: 65, text: "方案好了，请验收", meta: { needsUser: true, options: ["通过", "打回"], deliverables: [plan, shot] } });
      const snapshot = makeSnapshot({ conversations: [makeConvSnapshot([blocker, withFiles])] });
      openFirstConversation(snapshot);
      const api = await bootApp(snapshot);
      await waitFor(() => expect(cardOf(65)).not.toBeNull());
      const reminder = document.querySelector<HTMLElement>('[data-message-id="64"] [data-testid="user-blocker-card"]')!;
      expect(reminder.querySelector("[data-ask-card]")).toBeNull();
      expect(within(reminder).getByText("Waiting on you")).toBeInTheDocument();
      await user.click(within(reminder).getByRole("button", { name: "Done" }));
      await waitFor(() => expect(api.calls.filter((c) => c.path === "/api/user-blockers/5/recheck")).toHaveLength(1));
      expect(api.calls.filter((c) => c.path === "/api/asks/65/answer")).toEqual([]);
      for (const b of optionsOf(cardOf(65))) expect(b).not.toBeDisabled();
      await expectPlanOpens(cardOf(65));
    });

    it("了结后的卡：文件行在上，回答那一行、Closed 在下，文件照样能点开", async () => {
      const answeredCard = askMessage({
        id: 63,
        text: "方案好了，请验收",
        meta: { needsUser: true, answered: true, options: ["通过", "打回"], chosenOption: "通过", answerNote: "看过了", deliverables: [plan] },
      });
      const closedCard = askMessage({ id: 64, text: "截图对吗？", meta: { needsUser: true, answered: true, closed: true, deliverables: [shot] } });
      const snapshot = makeSnapshot({ conversations: [makeConvSnapshot([answeredCard, closedCard])] });
      openFirstConversation(snapshot);
      await bootApp(snapshot);
      await waitFor(() => expect(cardOf(64)).not.toBeNull());

      const answered = cardOf(63);
      const files = answered.querySelector<HTMLElement>("[data-deliverables]")!;
      const answer = answered.querySelector<HTMLElement>("[data-ask-answer]")!;
      expect(answer).toHaveTextContent("看过了");
      expect(files.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(answered).queryByText("Closed")).toBeNull();

      const closed = cardOf(64);
      const closedFiles = closed.querySelector<HTMLElement>("[data-deliverables]")!;
      const closedMark = within(closed).getByText("Closed");
      expect(within(closedFiles).getByRole("img", { name: "桌面截图" })).toBeInTheDocument();
      expect(closedFiles.compareDocumentPosition(closedMark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(closed).queryByRole("textbox")).toBeNull();
      await expectPlanOpens(answered);
    });
  });

  it("全览弹窗的门禁卡：摘要里写了交付物的同一个本机链接，链接也能点开预览", () => {
    const graph = gateGraph();
    graph.nodes[0] = { ...graph.nodes[0]!, gateSummaryMd: `**摘要**：做完了，结论见[验收结论](${verdict.href})` };
    renderGateDialog(graph);
    expectBodyFileLinks(screen.getByTestId("peel-gate-card"), ["验收结论"]);
  });

  it("右栏 Needs You 的提问行只有一行：不展开、不列交付物（文件在对话里那张卡上看），点了交给 onOpenAsk", async () => {
    const ask = askMessage({ id: 52, text: `方案好了，请验收\n\n${CHECKPOINT_TEXT}`, meta: { needsUser: true, deliverables: [plan, rec] } });
    const onOpenAsk = vi.fn();
    render(
      <RightRail asks={[ask]} workers={[]} activeGraphs={[]} openWorkerId={null} layout="side" look={defaultLookOf(1)} onOpenAsk={onOpenAsk} onOpenWorker={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: /方案好了，请验收/ }));
    expect(onOpenAsk).toHaveBeenCalledWith(52);
    expect(document.querySelector("[data-deliverables]")).toBeNull();
    expect(screen.queryByText(/做完了/)).toBeNull();
  });

  it("右栏果皮轨里等拍板的步骤只有一行：不列交付物、不出选项", () => {
    render(
      <RightRail asks={[]} workers={[]} activeGraphs={[gateGraph()]} openWorkerId={null} layout="side" look={defaultLookOf(1)} onOpenAsk={() => {}} onOpenWorker={() => {}} />,
    );
    expect(screen.getByTestId("peel-gate-row")).toBeInTheDocument();
    expect(screen.queryByTestId("peel-gate-card")).toBeNull();
    expect(document.querySelector("[data-deliverables]")).toBeNull();
  });

  it("全览弹窗的门禁卡：摘要 → 文件 → 细节", async () => {
    const graph = gateGraph();
    graph.nodes[0] = { ...graph.nodes[0]!, gateSummaryMd: CHECKPOINT_TEXT };
    renderGateDialog(graph);
    await expectLeadFilesThenDetails(screen.getByTestId("peel-gate-card"));
  });

  it("全览弹窗的门禁卡列出该步 artifact.deliverables", () => {
    renderGateDialog(gateGraph());
    const card = screen.getByTestId("peel-gate-card");
    const files = card.querySelector<HTMLElement>("[data-deliverables]")!;
    expect(within(files).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["方案", "验收结论", "桌面截图", "录屏"]);
  });

  it("全览弹窗的门禁卡：长问题、长选项不把列撑得比卡宽（选项那列 grid-cols-1，长词能换行），Recommended 留在按钮里", () => {
    const longWord = "release/2026-11-16-hotfix-database-migration-rollback-plan-without-spaces-0123456789";
    const graph = gateGraph();
    graph.nodes[0] = { ...graph.nodes[0]!, gateQuestion: longWord, gateOptions: [longWord, "短"], gateRecommended: longWord, gateSummaryMd: "" };
    renderGateDialog(graph);
    const card = screen.getByTestId("peel-gate-card");
    const longOption = within(card).getByRole("button", { name: new RegExp(`^${longWord}`) });
    expect(longOption.parentElement).toHaveClass("grid-cols-1");
    expect(longOption.firstElementChild).toHaveClass("wrap-anywhere");
    expect(within(longOption).getByText("Recommended")).toHaveClass("shrink-0");
    expect(within(card).getAllByText(longWord)[0]).toHaveClass("wrap-anywhere");
  });

  it("全览弹窗：同一张图里一步等拍板带文件、一步挂着要你动手的提醒卡，各是各的卡", async () => {
    const graph = gateGraph();
    graph.nodes.push(
      makeNode({
        key: "verify",
        title: "验收",
        status: "waiting",
        waitingFor: "user",
        sortOrder: 1,
        artifact: { summary: "上一轮", deliverables: [rec] },
        userBlocker: { id: 5, kind: "vendor_signed_out", vendor: "agy", device: "东京", recheckedAs: null },
      }),
    );
    renderGateDialog(graph);
    const reminder = screen.getByTestId("user-blocker-card");
    expect(within(reminder).getByRole("button", { name: "Done" })).toBeEnabled();
    expect(reminder.querySelector("[data-deliverables]")).toBeNull();
    const gates = screen.getAllByTestId("peel-gate-card");
    expect(gates).toHaveLength(1);
    await user.click(within(gates[0]!.querySelector<HTMLElement>("[data-deliverables]")!).getByRole("button", { name: "方案" }));
    // 预览窗叠在全览弹窗上面，底下那层被 Radix 标成 aria-hidden
    await waitFor(() => expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2));
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
        { id: LOCAL_ID, name: "MacBook", self: true, platform: "darwin", online: true, link: "local" as const, fingerprint: null },
        ...(tokyoApi ? [{ id: TOKYO_ID, name: "Tokyo", self: false, platform: "linux", online: true, link: "relay" as const, fingerprint: null }] : []),
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
      const itemCard = await within(tray).findByRole("article", { name: "方案标准改好了，请验收" });
      expect(within(itemCard.querySelector<HTMLElement>("[data-deliverables]")!).getByRole("button", { name: "验收结论" })).toBeInTheDocument();
      await user.click(within(tray).getByRole("button", { name: /请确认步骤「实现」的结果/ }));
      const gateCard = await within(tray).findByRole("article", { name: "请确认步骤「实现」的结果" });
      expect(within(gateCard.querySelector<HTMLElement>("[data-deliverables]")!).getByRole("button", { name: "录屏" })).toBeInTheDocument();
    });

    it("总助拍板卡、简报：正文里写了交付物的同一个本机链接，链接也能点开预览", async () => {
      layoutDetailsByText();
      const item = decisionItem({ context: `请看[方案](${plan.href})`, deliverables: [plan] });
      const report = reportItem({ summary: `做完了，结论见[验收结论](${verdict.href})`, deliverables: [verdict] });
      installFleet(snapshotWith({ router: { ...emptyRouterSlice(), items: [item, report] } }));
      await openRouter();
      const tray = await screen.findByRole("region", { name: "Needs You" });
      expectBodyFileLinks(await within(tray).findByRole("article", { name: "方案标准改好了，请验收" }), ["方案"]);
      const briefing = await waitFor(() => {
        const el = document.querySelector<HTMLElement>("[data-router-briefing]");
        expect(el).not.toBeNull();
        return el!;
      });
      expectBodyFileLinks(briefing, ["验收结论"]);
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
      await user.click(within(briefing).getByRole("button", { name: "Show more" }));
      expect(within(briefing).getByRole("link", { name: /PR #333/ })).toBeInTheDocument();
    });

    it("总助拍板卡：摘要 → 文件 → 细节，“downstream step waiting”也收在细节里", async () => {
      const graph = gateGraph();
      graph.nodes[0] = { ...graph.nodes[0]!, gateSummaryMd: CHECKPOINT_TEXT };
      graph.nodes.push(makeNode({ key: "verify", title: "验收" }));
      graph.edges.push({ fromKey: "impl", toKey: "verify" });
      installFleet(snapshotWith({ activeTaskGraphs: [graph] }));
      await openRouter();
      const tray = await screen.findByRole("region", { name: "Needs You" });
      const card = await within(tray).findByRole("article", { name: "请确认步骤「实现」的结果" });
      expect(within(card).queryByText(/downstream step/)).toBeNull();
      await expectLeadFilesThenDetails(card);
      await user.click(within(card).getByRole("button", { name: "Show more" }));
      expect(within(card).getByText("1 downstream step waiting")).toBeInTheDocument();
    });

    it("总助简报：摘要 → 文件 → 细节，链接行也收在细节里", async () => {
      installFleet(snapshotWith({ router: { ...emptyRouterSlice(), items: [reportItem({ summary: CHECKPOINT_TEXT, deliverables: [plan, rec] })] } }));
      await openRouter();
      const briefing = await waitFor(() => {
        const el = document.querySelector<HTMLElement>("[data-router-briefing]");
        expect(el).not.toBeNull();
        return el!;
      });
      expect(within(briefing).queryByRole("link", { name: /PR #333/ })).toBeNull();
      await expectLeadFilesThenDetails(briefing);
      await user.click(within(briefing).getByRole("button", { name: "Show more" }));
      expect(within(briefing).getByRole("link", { name: /PR #333/ })).toBeInTheDocument();
    });

    it("总助简报：细节只有一个 PR 链接时直接显示，不收起", async () => {
      layoutDetailsByText();
      installFleet(snapshotWith({ router: { ...emptyRouterSlice(), items: [reportItem({ summary: "任务图 #22 做完了", deliverables: [plan] })] } }));
      await openRouter();
      const briefing = await waitFor(() => {
        const el = document.querySelector<HTMLElement>("[data-router-briefing]");
        expect(el).not.toBeNull();
        return el!;
      });
      expect(within(briefing).getByRole("link", { name: /PR #333/ })).toBeInTheDocument();
      expect(within(briefing).queryByRole("button", { name: /Show (more|less)/ })).toBeNull();
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

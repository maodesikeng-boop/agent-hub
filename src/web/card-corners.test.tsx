import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkConcentricCornerGeometry } from "../../scripts/verify-card-corners.ts";
import {
  ROUTER_COMMAND_MAX_CHARS,
  type Message,
  type RouterDecisionItem,
  type StateSnapshot,
  type TaskGraph,
  type TaskNode,
} from "../shared/index.ts";
import { defaultLookOf } from "../shared/slimes.ts";
import { App } from "./App.tsx";
import { CodeView } from "./components/CodeBlock.tsx";
import { CardNoteForm } from "./components/Deliverables.tsx";
import { RouterDecisionCard } from "./components/RouterDecisionCard.tsx";
import { TaskGraphDialog } from "./components/TaskGraphDialog.tsx";
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
  makeSession,
  makeSnapshot,
  makeSystemMessage,
  makeWorkerLine,
  messageChange,
} from "./test-utils.ts";

const WEB_DIR = resolve("src/web");

function collectWebSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectWebSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

function makeGateNode(over: Partial<TaskNode> = {}): TaskNode {
  return {
    key: "review",
    title: "Confirm plan",
    status: "waiting",
    waitingFor: "user",
    skipped: false,
    sortOrder: 0,
    activeWorkerId: 11,
    workerIds: [11],
    artifact: null,
    gateQuestion: "Approve the corner fix plan?",
    gateOptions: ["Approve", "Revise"],
    gateSummaryMd: "Concentric inner corners for decision cards.",
    gateRecommended: "Approve",
    gateAskMessageId: 50,
    gateCheckpoint: true,
    decision: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

function makeGateGraph(): TaskGraph {
  return {
    id: 9,
    projectId: 10,
    pmId: 1,
    conversationId: 1,
    title: "Corner polish",
    status: "active",
    originMsgId: null,
    nodes: [makeGateNode()],
    edges: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: null,
    readySince: null,
  };
}

function makeDecision(over: Partial<RouterDecisionItem> = {}): RouterDecisionItem {
  return {
    id: 101,
    kind: "decision",
    status: "pending",
    pmId: 1,
    projectId: 10,
    conversationId: 1,
    question: "Ship concentric card corners?",
    context: "Applies to all decision cards and reply popovers.",
    options: ["(Recommended) Ship now", "Wait"],
    askMessageId: null,
    resolution: null,
    createdAt: 20_000,
    updatedAt: 20_000,
    ...over,
  };
}

function askMsg(over: Partial<Message> & Pick<Message, "id">): Message {
  return makeMessage({
    conversationId: 1,
    dedupeKey: `ask:1:${over.id}`,
    createdAt: 10_000 + over.id,
    meta: { needsUser: true, options: ["Option A", "Option B"] },
    ...over,
  });
}

function makeChatSnapshot(messages: Message[]): StateSnapshot {
  return makeSnapshot({
    projects: [makeProject({ id: 10, name: "Bellwood" })],
    pms: [makePm({ id: 1, name: "Lin" })],
    conversations: [makeConvSnapshot(messages, { conversation: { id: 1, pmId: 1, title: "Lin" } })],
    sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 })],
  });
}

async function bootApp(snapshot: StateSnapshot, hash = "#/c/1"): Promise<{ api: FakeApi; ws: FakeWebSocket }> {
  window.history.replaceState(null, "", `/${hash}`);
  installFakeWebSocket();
  installFakeNotification("default");
  const api = new FakeApi(snapshot);
  api.install();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const ws = FakeWebSocket.last;
  act(() => {
    for (const sock of FakeWebSocket.instances) if (sock.readyState === 0) sock.open();
  });
  await screen.findByRole("log", { name: "Messages" });
  return { api, ws };
}

beforeEach(() => {
  resetQueryClient();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("concentric inner corners acceptance suite (new and changed behavior)", () => {
  it("defines --card-inner-radius and .card-reply-row focus, invalid, and reduced-motion recipes in styles.css", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/--card-inner-radius:\s*calc\(var\(--radius-sm\)\s*-\s*1px\);/);
    expect(css).toMatch(/\.card-reply-row\s*\{[^}]*border-end-start-radius:\s*var\(--card-inner-radius\);[^}]*border-end-end-radius:\s*var\(--card-inner-radius\);/s);
    expect(css).toMatch(/\.card-reply-row:focus-within\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--border-focus\);/s);
    expect(css).toMatch(/\.card-reply-row\[data-invalid="true"\][^{]*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--danger\);/s);
    const focusIdx = css.indexOf(".card-reply-row:focus-within");
    const invalidIdx = css.indexOf('.card-reply-row[data-invalid="true"]');
    expect(focusIdx).toBeGreaterThan(-1);
    expect(invalidIdx).toBeGreaterThan(focusIdx);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.card-reply-row[\s\S]*transition:\s*none;/);
  });

  it("defines .event-strip-shell and .event-strip-trigger concentric corner rules in styles.css", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/\.event-strip-trigger\s*\{[^}]*border-radius:\s*0;/s);
    expect(css).toMatch(/\.event-strip-trigger\[data-state="closed"\]\s*\{[^}]*border-radius:\s*var\(--radius-sm\);/s);
    expect(css).toMatch(/\.event-strip-trigger\[data-state="open"\]\s*\{[^}]*border-start-start-radius:\s*var\(--radius-sm\);[^}]*border-start-end-radius:\s*var\(--radius-sm\);/s);
    expect(css).toMatch(/\.event-strip-shell\s*>\s*:first-child\s+\.event-strip-trigger\s*\{[^}]*border-start-start-radius:\s*var\(--radius-sm\);[^}]*border-start-end-radius:\s*var\(--radius-sm\);/s);
    expect(css).toMatch(/\.event-strip-shell\s*>\s*:last-child\s+\.event-strip-trigger\s*\{[^}]*border-end-start-radius:\s*var\(--radius-sm\);[^}]*border-end-end-radius:\s*var\(--radius-sm\);/s);
  });

  it("applies .card-reply-row on AskCard without inline inset shadow utilities and reflects invalid state via data-invalid", async () => {
    await bootApp(makeChatSnapshot([askMsg({ id: 1, text: "Pick a corner strategy" })]));
    const card = document.querySelector('[data-message-id="1"] [data-ask-card]') as HTMLElement;
    const row = within(card).getByRole("textbox", { name: "Your reply" }).closest<HTMLElement>("[data-card-reply]")!;
    expect(row).toHaveClass("card-reply-row");
    expect(row.className).not.toMatch(/shadow-\[inset_/);
    expect(row).not.toHaveAttribute("data-invalid");

    const { container } = render(
      <CardNoteForm
        variant="row"
        disabled={false}
        pending={false}
        value="too long"
        invalid="Too long"
        onSubmitNote={() => {}}
      />,
    );
    const invalidRow = container.querySelector<HTMLElement>("[data-card-reply]")!;
    expect(invalidRow).toHaveClass("card-reply-row");
    expect(invalidRow).toHaveAttribute("data-invalid", "true");
    expect(invalidRow.className).not.toMatch(/shadow-\[inset_/);
  });

  it("applies .card-reply-row on RouterDecisionCard inside its overflow-hidden rounded-sm frame", () => {
    const decision = makeDecision();
    render(
      <RouterDecisionCard
        entry={{
          deviceKey: "local",
          deviceId: "00000000-0000-4000-8000-000000000001",
          deviceName: "MacBook",
          self: true,
          online: true,
          look: defaultLookOf(0),
          decision: {
            ...decision,
            key: "d:101",
            deviceId: "00000000-0000-4000-8000-000000000001",
            pmName: "Lin",
            projectName: "Bellwood",
            deliverables: [],
            source: { kind: "router_item", itemId: 101 },
          },
        }}
        multiDevice={false}
        busy={false}
        error={null}
        onNoteFocus={() => {}}
        onNoteChange={() => {}}
        onSubmit={() => {}}
        onOpenConversation={() => {}}
      />,
    );
    const article = screen.getByRole("article", { name: decision.question });
    expect(article).toHaveClass("overflow-hidden", "rounded-sm", "border");
    const row = within(article).getByRole("textbox", { name: "Your reply" }).closest<HTMLElement>("[data-card-reply]")!;
    expect(row).toHaveClass("card-reply-row");
    expect(row.className).not.toMatch(/shadow-\[inset_/);
  });

  it("applies .card-reply-row on GateDecisionCard while preserving compact negative margins", () => {
    render(
      <TaskGraphDialog
        open
        graph={makeGateGraph()}
        workers={[]}
        color={defaultLookOf(1).color}
        onOpenChange={() => {}}
        onOpenWorker={() => {}}
      />,
    );
    const card = screen.getByTestId("peel-gate-card");
    expect(card).toHaveClass("overflow-hidden", "rounded-sm", "border", "border-select-line");
    const row = within(card).getByRole("textbox", { name: "Your reply" }).closest<HTMLElement>("[data-card-reply]")!;
    expect(row).toHaveClass("card-reply-row", "-mx-3.5", "-mb-3", "pl-3.5");
    expect(row.className).not.toMatch(/shadow-\[inset_/);
  });

  it("applies .card-reply-row and toggles data-invalid on RouterTopBarPopover when reply exceeds ROUTER_COMMAND_MAX_CHARS", async () => {
    await bootApp(makeChatSnapshot([makeMessage({ id: 1, conversationId: 1, text: "Ready", createdAt: 10_000 })]));
    const user = userEvent.setup();
    const topInput = await screen.findByRole("textbox", { name: "Message Router" });
    await user.click(topInput);
    await user.type(topInput, "status{Enter}");

    const dialog = await screen.findByRole("dialog", { name: "Router" });
    const reply = within(dialog).getByRole("textbox", { name: "Reply to Router" });
    const row = reply.closest<HTMLElement>("[data-card-reply]")!;
    expect(row).toHaveClass("card-reply-row", "mx-0", "mb-0");
    expect(row).not.toHaveAttribute("data-invalid");

    fireEvent.change(reply, { target: { value: "x".repeat(ROUTER_COMMAND_MAX_CHARS + 1) } });
    fireEvent.keyDown(reply, { key: "Enter" });
    await waitFor(() => expect(row).toHaveAttribute("data-invalid", "true"));
    expect(reply).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(reply, { target: { value: "short reply" } });
    await waitFor(() => expect(row).not.toHaveAttribute("data-invalid"));
    expect(reply).not.toHaveAttribute("aria-invalid");
  });

  it("deletes the unused CardNoteForm variant='field' branch from Deliverables.tsx", () => {
    const src = readFileSync("src/web/components/Deliverables.tsx", "utf8");
    expect(src).not.toMatch(/variant\s*=\s*"field"/);
    expect(src).not.toContain("shadow-[var(--shadow-tile)]");
  });

  it("applies .event-strip-trigger without rounded-none on CollapsibleEvent triggers (ScheduleRun, WakeupNotice, SessionRenewed)", async () => {
    await bootApp(
      makeChatSnapshot([
        makeSystemMessage({
          id: 2,
          conversationId: 1,
          text: "【Nightly check】Run smoke verification",
          createdAt: 10_002,
          event: { event: "schedule.run", scheduleId: 1, name: "Nightly check", scheduledAt: 10_000, catchUp: false },
        }),
        makeSystemMessage({
          id: 3,
          conversationId: 1,
          text: "Handover summary body",
          createdAt: 10_003,
          event: { event: "session.renewed", sessionId: 2, fromSessionId: 1, auto: true },
        }),
      ]),
    );
    const scheduleTrigger = screen.getByRole("button", { name: "Nightly check" });
    expect(scheduleTrigger).toHaveClass("event-strip-trigger");
    expect(scheduleTrigger).not.toHaveClass("rounded-none");
    expect(scheduleTrigger).toHaveAttribute("data-state", "closed");

    fireEvent.click(scheduleTrigger);
    expect(scheduleTrigger).toHaveAttribute("data-state", "open");
    expect(scheduleTrigger).toHaveClass("event-strip-trigger");
  });

  it("applies .event-strip-shell and .event-strip-trigger without rounded-none on EventStripShell and WorkerNoticeRow", async () => {
    await bootApp(
      makeChatSnapshot([
        makeWorkerLine({
          id: 4,
          conversationId: 1,
          createdAt: 10_004,
          line: {
            event: "user_message",
            workerId: 21,
            workerConversationId: 201,
            title: "Worker One",
            summary: "Check logs",
          },
        }),
        makeWorkerLine({
          id: 5,
          conversationId: 1,
          createdAt: 10_005,
          line: {
            event: "user_message",
            workerId: 22,
            workerConversationId: 202,
            title: "Worker Two",
            summary: "Check tests",
          },
        }),
      ]),
    );
    const first = screen.getByRole("button", { name: /Worker One/ });
    const last = screen.getByRole("button", { name: /Worker Two/ });
    const shell = first.closest<HTMLElement>("[data-event-group]")!;
    expect(shell).toHaveClass("event-strip-shell", "overflow-hidden", "rounded-sm");
    for (const trigger of [first, last]) {
      expect(trigger).toHaveClass("event-strip-trigger");
      expect(trigger).not.toHaveClass("rounded-none");
    }
  });

  it("keeps CodeBlock BarButton focus outline inside .md-code with focus-visible:outline-offset-[-2px]", () => {
    render(<CodeView code="const radius = 7;" language="ts" />);
    const copyBtn = screen.getByRole("button", { name: "Copy code" });
    expect(copyBtn).toHaveClass("focus-visible:outline-2", "focus-visible:outline-border-focus", "focus-visible:outline-offset-[-2px]");
  });

  it("checkConcentricCornerGeometry catches clipped bottom corners inside a 1px-bordered 8px card and passes concentric 7px corners", () => {
    const clipped = checkConcentricCornerGeometry({
      label: "AskCard reply row",
      containerRadius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 },
      containerBorder: { top: 1, right: 1, bottom: 1, left: 1 },
      childRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
      touchesEdges: { top: false, right: true, bottom: true, left: true },
      hasInsetStroke: true,
    });
    expect(clipped).toEqual([
      { label: "AskCard reply row", corner: "bottomRight", expectedMinRadiusPx: 7, actualRadiusPx: 0 },
      { label: "AskCard reply row", corner: "bottomLeft", expectedMinRadiusPx: 7, actualRadiusPx: 0 },
    ]);

    const concentric = checkConcentricCornerGeometry({
      label: "AskCard reply row",
      containerRadius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 },
      containerBorder: { top: 1, right: 1, bottom: 1, left: 1 },
      childRadius: { topLeft: 0, topRight: 0, bottomRight: 7, bottomLeft: 7 },
      touchesEdges: { top: false, right: true, bottom: true, left: true },
      hasInsetStroke: true,
    });
    expect(concentric).toEqual([]);
  });

  it("checkConcentricCornerGeometry checks borderless 8px event strip triggers and skips rows without inset strokes", () => {
    const collapsedClipped = checkConcentricCornerGeometry({
      label: "CollapsibleEvent closed",
      containerRadius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 },
      containerBorder: { top: 0, right: 0, bottom: 0, left: 0 },
      childRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
      touchesEdges: { top: true, right: true, bottom: true, left: true },
      hasInsetStroke: true,
    });
    expect(collapsedClipped.map((i) => i.corner)).toEqual(["topLeft", "topRight", "bottomRight", "bottomLeft"]);

    const expandedOk = checkConcentricCornerGeometry({
      label: "CollapsibleEvent open",
      containerRadius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 },
      containerBorder: { top: 0, right: 0, bottom: 0, left: 0 },
      childRadius: { topLeft: 8, topRight: 8, bottomRight: 0, bottomLeft: 0 },
      touchesEdges: { top: true, right: true, bottom: false, left: true },
      hasInsetStroke: true,
    });
    expect(expandedOk).toEqual([]);

    const middleRowOk = checkConcentricCornerGeometry({
      label: "EventStrip middle row",
      containerRadius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 },
      containerBorder: { top: 0, right: 0, bottom: 0, left: 0 },
      childRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
      touchesEdges: { top: false, right: true, bottom: false, left: true },
      hasInsetStroke: true,
    });
    expect(middleRowOk).toEqual([]);

    const noStrokeIgnored = checkConcentricCornerGeometry({
      label: "Resting hover row",
      containerRadius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 },
      containerBorder: { top: 1, right: 1, bottom: 1, left: 1 },
      childRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
      touchesEdges: { top: false, right: true, bottom: true, left: true },
      hasInsetStroke: false,
    });
    expect(noStrokeIgnored).toEqual([]);
  });

  it("structural guard: no non-test file in src/web writes inline inset focus or danger shadow utilities", () => {
    const hits: string[] = [];
    const inlineInsetRing = /shadow-\[inset_0_0_0_1px_var\(--(?:border-focus|danger)\)\]/;
    for (const file of collectWebSourceFiles(WEB_DIR)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        if (inlineInsetRing.test(line)) hits.push(`${relative(WEB_DIR, file)}:${idx + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("concentric inner corners regression suite (unchanged existing rules)", () => {
  it("preserves AskCard single-frame shell, square middle OptionRows, and flush settled bottom across two consecutive ask turns", async () => {
    const { api } = await bootApp(
      makeChatSnapshot([
        askMsg({ id: 11, text: "First decision" }),
        askMsg({ id: 12, text: "Second decision" }),
      ]),
    );
    const firstCard = document.querySelector('[data-message-id="11"] [data-ask-card]') as HTMLElement;
    const secondCard = document.querySelector('[data-message-id="12"] [data-ask-card]') as HTMLElement;
    expect(firstCard).toHaveClass("overflow-hidden", "rounded-sm", "border", "border-border");
    for (const opt of within(firstCard).getAllByRole("button").filter((b) => b.hasAttribute("data-ask-option"))) {
      expect(opt).toHaveClass("rounded-none");
    }

    const firstInput = within(firstCard).getByRole("textbox", { name: "Your reply" });
    fireEvent.change(firstInput, { target: { value: "Proceed with A" } });
    fireEvent.keyDown(firstInput, { key: "Enter" });
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/asks\/11\/answer$/)).toHaveLength(1));
    expect(within(firstCard).queryByRole("textbox")).toBeNull();
    expect(firstCard.querySelector("[role='group']")).toHaveClass("-mb-4");

    const secondInput = within(secondCard).getByRole("textbox", { name: "Your reply" });
    expect(secondInput).toHaveValue("");
    fireEvent.change(secondInput, { target: { value: "Proceed with B" } });
    fireEvent.keyDown(secondInput, { key: "Enter" });
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/asks\/12\/answer$/)).toHaveLength(1));
  });

  it("preserves draft on failed AskCard submission with inline alert above reply row and keeps unsent draft on remote settlement", async () => {
    const { api, ws } = await bootApp(makeChatSnapshot([askMsg({ id: 21, text: "Deploy now?" })]));
    api.answerAsk = () => ({ status: 500, body: { error: "Temporary failure" } });

    const card = document.querySelector('[data-message-id="21"] [data-ask-card]') as HTMLElement;
    const input = within(card).getByRole("textbox", { name: "Your reply" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Hold until CI passes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toMatch(/500|Temporary failure/);
    expect(input.value).toBe("Hold until CI passes");
    const row = input.closest("[data-card-reply]")!;
    expect(alert.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    act(() => {
      ws.push(
        messageChange(
          50,
          "message.updated",
          askMsg({
            id: 21,
            text: "Deploy now?",
            meta: { needsUser: true, options: ["Option A", "Option B"], answered: true, chosenOption: "Option A" },
          }),
        ),
      );
    });
    await waitFor(() => expect(within(card).queryByRole("textbox")).toBeNull());
    expect(within(card).getByText("Unsent reply")).toBeInTheDocument();
    expect(within(card).getByText("Hold until CI passes")).toBeInTheDocument();
  });

  it("keeps RouterTopBarPopover non-modal frame, appends two consecutive turns, and blocks empty or over-limit replies", async () => {
    const { api } = await bootApp(makeChatSnapshot([makeMessage({ id: 1, conversationId: 1, text: "Ready", createdAt: 10_000 })]));
    const user = userEvent.setup();
    const topInput = await screen.findByRole("textbox", { name: "Message Router" });
    await user.click(topInput);
    await user.type(topInput, "first turn{Enter}");

    const dialog = await screen.findByRole("dialog", { name: "Router" });
    expect(dialog).toHaveClass("overflow-hidden", "rounded-sm", "border");
    const reply = within(dialog).getByRole("textbox", { name: "Reply to Router" });
    const sendBtn = within(dialog).getByRole("button", { name: "Send" });

    fireEvent.change(reply, { target: { value: "   " } });
    expect(sendBtn).toBeDisabled();
    fireEvent.keyDown(reply, { key: "Enter" });
    expect(api.callsTo("POST", /^\/api\/router\/commands$/)).toHaveLength(1);

    fireEvent.change(reply, { target: { value: "second turn" } });
    fireEvent.keyDown(reply, { key: "Enter" });
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/router\/commands$/)).toHaveLength(2));
  });

  it("handles malformed and edge cards cleanly: AskCard with no options, whitespace-only submit, and disabled CollapsibleEvent", async () => {
    const { api } = await bootApp(
      makeChatSnapshot([
        askMsg({ id: 31, text: "Free-form question", meta: { needsUser: true, options: [] } }),
        makeSystemMessage({
          id: 32,
          conversationId: 1,
          text: "【Empty run】",
          createdAt: 10_032,
          event: { event: "schedule.run", scheduleId: 2, name: "Empty run", scheduledAt: 10_030, catchUp: false },
        }),
      ]),
    );
    const card = document.querySelector('[data-message-id="31"] [data-ask-card]') as HTMLElement;
    const input = within(card).getByRole("textbox", { name: "Your reply" });
    fireEvent.change(input, { target: { value: "   \n  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.callsTo("POST", /^\/api\/asks\/31\/answer$/)).toEqual([]);
    expect(within(card).getByRole("button", { name: "Send" })).toBeDisabled();

    const emptyTrigger = screen.getByRole("button", { name: "Empty run" });
    expect(emptyTrigger).toBeDisabled();
  });
});

import { QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Message, MessageId } from "../../shared/index.ts";
import { defaultLookOf } from "../../shared/slimes.ts";
import { MessageList } from "../components/MessageList.tsx";
import type { AgentIdentity, MessageActions } from "../components/Messages.tsx";
import { queryClient } from "../query-client.ts";
import "../styles.css";

const IDENTITY: AgentIdentity = { name: "Bench PM", look: defaultLookOf(1) };
const agentOf = () => IDENTITY;
const ACTIONS: MessageActions = { retry: {}, onOpenWorker: () => {}, onRetryMessage: () => {}, onRevertPersona: () => Promise.resolve(), onAnswerAsk: () => Promise.resolve() };
const noop = () => {};

const CODE = ["```ts", "export function total(rows: { price: number; qty: number }[]): number {", "  let sum = 0;", "  for (const row of rows) {", "    sum += row.price * row.qty;", "  }", "  return sum;", "}", "", "console.log(total([{ price: 3, qty: 2 }]));", "```"].join("\n");
const TABLE = ["| Step | Owner | Status | Notes |", "| --- | --- | --- | --- |", "| Build | Worker 12 | Done | 4.1 s |", "| Review | Worker 13 | Running | waiting on CI |", "| Merge | PM | Queued | after review |"].join("\n");
const LONG = Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}: the daemon replays the ledger, rebuilds the scheduler queue, and reconciles every worker session before it accepts new commands.`).join("\n\n");

const chartPath = (i: number) => `/Users/bench/charts/chart-${i}.svg`;
const chartFile = (i: number) => ({ href: chartPath(i), path: chartPath(i), id: `chart${i}`, name: `chart-${i}.svg`, size: 2048, mime: "image/svg+xml", status: "saved", mtime: null });

function text(i: number): string {
  switch (i % 10) {
    case 1:
      return `Plan for item ${i}:\n\n- read the failing test\n- find the boundary where the state goes wrong\n- fix it there and **delete** the workaround\n\nThen run the targeted tests.`;
    case 2:
      return `Here is the helper for ${i}:\n\n${CODE}`;
    case 4:
      return `Status table ${i}:\n\n${TABLE}`;
    case 5:
      return `Rendered chart ${i}:\n\n![chart ${i}](${chartPath(i)})`;
    case 8:
      return LONG;
    case 9:
      return `## Summary ${i}\n\n> The cache is bounded by \`MAX_ROWS\`.\n\nUse \`pnpm verify\` before handing off, and keep comments short.`;
    default:
      return `Reply ${i}: done. The change touched two files and the targeted tests pass.`;
  }
}

function makeMessage(id: number): Message {
  const user = id % 10 === 0 || id % 10 === 3;
  const tool = id % 10 === 6;
  const ask = id % 10 === 7;
  const at = 1_700_000_000_000 + id * 1_000;
  return {
    id,
    conversationId: 1,
    sessionId: user ? null : 1,
    workerId: null,
    sender: user ? "user" : "agent",
    kind: tool ? "tool" : "text",
    text: user ? (id % 10 === 3 ? `Can you also check item ${id}? ${"The previous run looked slow on the long chat. ".repeat(3)}` : `Next step for ${id}`) : tool ? `Bash: pnpm vitest run src/web/item-${id}.test.tsx` : ask ? `Pick a rollout for ${id}` : text(id),
    meta: tool
      ? { toolUseId: `t${id}`, name: "Bash", input: {} }
      : ask
        ? { needsUser: true, options: ["Ship now", "Wait for CI"], recommended: "Wait for CI" }
        : id % 10 === 5
          ? { files: [chartFile(id)] }
          : null,
    collapsed: tool,
    dedupeKey: user ? `client:1:c${id}` : `session:1:u${id}`,
    status: user ? "replied" : null,
    failureReason: null,
    createdAt: at,
    updatedAt: at,
  };
}

interface HarnessState {
  messages: Message[];
  streamingText: string | null;
  hasMore: boolean;
  focus: { id: MessageId; n: number } | null;
}

type HarnessUpdate = (update: (s: HarnessState) => HarnessState) => void;

const OLDER_PAGE = 50;
const OLDER_DELAY_MS = 200;
const IDLE_STATE = { streamingText: null, hasMore: false, focus: null };

let setHarness: HarnessUpdate | null = null;
let loadingOlder = false;
let olderLoads = 0;

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => makeMessage(from + i));

function loadOlder() {
  if (loadingOlder) return;
  loadingOlder = true;
  setTimeout(() => {
    setHarness?.((s) => {
      const first = s.messages[0]?.id ?? 1;
      const from = Math.max(1, first - OLDER_PAGE);
      return { ...s, messages: [...range(from, first - 1), ...s.messages], hasMore: from > 1 };
    });
    olderLoads += 1;
    loadingOlder = false;
  }, OLDER_DELAY_MS);
}

function Harness({ initial }: { initial: HarnessState }) {
  const [state, setState] = useState(initial);
  setHarness = setState;
  const busy = state.streamingText !== null;
  const clearFocus = useCallback(() => setState((s) => ({ ...s, focus: null })), []);
  return (
    <div className="flex h-screen flex-col">
      <div className="relative min-h-0 flex-1">
        <MessageList
          messages={state.messages}
          pending={[]}
          agentOf={agentOf}
          hasMore={state.hasMore}
          older={undefined}
          onLoadOlder={loadOlder}
          onRetry={noop}
          actions={ACTIONS}
          focus={state.focus}
          onFocusDone={clearFocus}
          status={busy ? <span>Working…</span> : undefined}
          statusAgent={IDENTITY}
          streamingText={state.streamingText}
        />
      </div>
    </div>
  );
}

const NEXT_TASK_MS = 0;
const afterPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, NEXT_TASK_MS)));

let lastCommitMs = 0;

async function timed(update: () => void): Promise<number> {
  const start = performance.now();
  flushSync(update);
  lastCommitMs = performance.now() - start;
  await afterPaint();
  return performance.now() - start;
}

const userMessage = (id: number): Message => ({ ...makeMessage(10), id, dedupeKey: `client:1:c${id}`, text: `Next step for ${id}` });

// Id 10 is a user message in `makeMessage`, so ids 2 to 9 between two user messages form one agent turn.
const TALL_TURN_FIRST = 2;
const TALL_TURN_LAST = 9;

const root = createRoot(document.getElementById("root")!);
let nextId = 0;

const bench = {
  /** Mounts `count` messages; with `older`, they are the newest page and `older` more load on scroll to top. */
  async mount(count: number, older = 0): Promise<number> {
    nextId = older + count;
    const initial = { ...IDLE_STATE, messages: range(older + 1, older + count), hasMore: older > 0 };
    return timed(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness initial={initial} />
        </QueryClientProvider>,
      ),
    );
  },
  /** Mounts one tall turn (an ask, long replies, another ask) followed by `tail` ordinary messages, and returns the two ask ids. */
  async mountTallTurn(tail: number): Promise<[MessageId, MessageId]> {
    const ask = (id: number) => ({ ...makeMessage(7), id, dedupeKey: `session:1:u${id}`, text: `Pick a rollout for ${id}` });
    const long = (id: number) => ({ ...makeMessage(8), id, dedupeKey: `session:1:u${id}` });
    const replies = Array.from({ length: TALL_TURN_LAST - TALL_TURN_FIRST - 1 }, (_, i) => long(TALL_TURN_FIRST + 1 + i));
    const turn = [userMessage(TALL_TURN_FIRST - 1), ask(TALL_TURN_FIRST), ...replies, ask(TALL_TURN_LAST)];
    nextId = TALL_TURN_LAST + tail;
    const initial = { ...IDLE_STATE, messages: [...turn, ...range(TALL_TURN_LAST + 1, nextId)] };
    await timed(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness initial={initial} />
        </QueryClientProvider>,
      ),
    );
    return [TALL_TURN_FIRST, TALL_TURN_LAST];
  },
  /** Appends a user message and an agent reply in turn, so every append adds a new row. */
  append(): Promise<number> {
    nextId += 1;
    const message =
      nextId % 2 === 0
        ? userMessage(nextId)
        : { ...makeMessage(nextId), sender: "agent" as const, sessionId: 1, kind: "text" as const, meta: null, collapsed: false, status: null, dedupeKey: `session:1:u${nextId}`, text: text(1) };
    return timed(() => setHarness?.((s) => ({ ...s, messages: [...s.messages, message], streamingText: null })));
  },
  stream(chunk: string): Promise<number> {
    return timed(() => setHarness?.((s) => ({ ...s, streamingText: `${s.streamingText ?? ""}${chunk}` })));
  },
  focus(id: MessageId) {
    setHarness?.((s) => ({ ...s, focus: { id, n: (s.focus?.n ?? 0) + 1 } }));
  },
  olderLoads: () => olderLoads,
  lastCommitMs: () => lastCommitMs,
  gapFromBottom: () => {
    const log = document.querySelector('[role="log"]')!;
    return log.scrollHeight - log.scrollTop - log.clientHeight;
  },
  imageCount: () => document.querySelectorAll('[role="log"] img').length,
  nodeCount: () => document.querySelectorAll("*").length,
  rowCount: () => document.querySelectorAll("[data-message-id], [data-turn], [data-side]").length,
};

Object.assign(window, { __bench: bench });

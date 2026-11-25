import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type MutationState } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_VENDOR,
  ROUTER_STREAM_LIVE_MAX,
  type PostRouterCommandResponse,
  type RouterCommandRecord,
} from "../shared/index.ts";
import {
  ROUTER_COMMAND_MUTATION_KEY,
  buildPendingRouterTurns,
  pruneRouterCommandMutations,
  retryStateOf,
  useRouterCommands,
  type RawRouterMutation,
  type RouterCommandVariables,
} from "./router-commands.ts";
import { turnEntryOfCommand, type RouterTurnEntry } from "./router-stream.ts";
import { FakeApi, makeSnapshot } from "./test-utils.ts";

function command(over: Partial<RouterCommandRecord> = {}): RouterCommandRecord {
  return {
    id: 1,
    clientId: "c1",
    inputText: "hello",
    vendor: DEFAULT_AGENT_VENDOR,
    model: null,
    effort: null,
    status: "answered",
    plan: { intent: "answer", reply: "hi", actions: [] },
    dispatched: null,
    error: null,
    durationMs: 10,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

function vars(clientId: string, text = `text ${clientId}`): RouterCommandVariables {
  return { clientId, text, attachments: [], attachmentIds: [], createdAt: 2_000 };
}

function raw(clientId: string, status: RawRouterMutation["status"], over: Partial<RawRouterMutation> = {}): RawRouterMutation {
  return { clientId, variables: vars(clientId), status, data: undefined, error: null, ...over };
}

function seedMutation(qc: QueryClient, clientId: string, status: MutationState["status"], data?: PostRouterCommandResponse) {
  const state: MutationState<PostRouterCommandResponse, unknown, RouterCommandVariables, unknown> = {
    context: undefined,
    data,
    error: status === "error" ? new Error("down") : null,
    failureCount: 0,
    failureReason: null,
    isPaused: false,
    status,
    variables: vars(clientId),
    submittedAt: 1,
  };
  return qc.getMutationCache().build(qc, { mutationKey: ROUTER_COMMAND_MUTATION_KEY }, state);
}

const clientIdsIn = (qc: QueryClient) =>
  qc
    .getMutationCache()
    .findAll({ mutationKey: ROUTER_COMMAND_MUTATION_KEY })
    .map((m) => (m.state.variables as RouterCommandVariables).clientId);

describe("pruneRouterCommandMutations", () => {
  it("removes succeeded mutations once their clientId appears in confirmedClientIds", () => {
    const qc = new QueryClient();
    seedMutation(qc, "done", "success", { command: command({ clientId: "done" }) });
    seedMutation(qc, "waiting", "success", { command: command({ clientId: "waiting" }) });
    seedMutation(qc, "failed", "error");
    pruneRouterCommandMutations(qc, new Set(["done", "failed"]));
    expect(clientIdsIn(qc)).toEqual(["waiting", "failed"]);
  });

  it("evicts oldest non-pending mutations beyond ROUTER_STREAM_LIVE_MAX while preserving pending ones", () => {
    const qc = new QueryClient();
    seedMutation(qc, "pending-oldest", "pending");
    for (let i = 0; i < ROUTER_STREAM_LIVE_MAX + 1; i++) seedMutation(qc, `m${i}`, "error");
    pruneRouterCommandMutations(qc, new Set());
    const left = clientIdsIn(qc);
    expect(left).toHaveLength(ROUTER_STREAM_LIVE_MAX);
    expect(left[0]).toBe("pending-oldest");
    expect(left).not.toContain("m0");
    expect(left).not.toContain("m1");
    expect(left.at(-1)).toBe(`m${ROUTER_STREAM_LIVE_MAX}`);
  });
});

describe("buildPendingRouterTurns", () => {
  it("omits mutations whose clientId is already present in liveTurns", () => {
    const live = [turnEntryOfCommand(command({ clientId: "sent" }), undefined, true)];
    const turns = buildPendingRouterTurns([raw("sent", "success", { data: { command: command({ clientId: "sent" }) } }), raw("new", "pending")], live, undefined, []);
    expect(turns.map((t) => t.clientId)).toEqual(["new"]);
  });

  it("deduplicates repeated retries for the same clientId, keeping the latest mutation state", () => {
    const turns = buildPendingRouterTurns([raw("a", "error"), raw("b", "pending"), raw("a", "pending")], [], undefined, []);
    expect(turns.map((t) => [t.clientId, t.status])).toEqual([
      ["a", "sending"],
      ["b", "sending"],
    ]);
  });

  it("turns succeeded mutations with command data into live RouterTurnEntry records", () => {
    const cmd = command({ clientId: "ok", status: "planning", plan: null });
    const [turn] = buildPendingRouterTurns([raw("ok", "success", { data: { command: cmd } })], [], undefined, []);
    expect(turn).toBe(turnEntryOfCommand(cmd, undefined, true));
    expect(turn).toMatchObject({ status: "planning", live: true, command: cmd });
  });

  it("marks pending mutations as sending and errored mutations as send_failed with unsentError", () => {
    const error = new Error("offline");
    const turns = buildPendingRouterTurns([raw("p", "pending"), raw("e", "error", { error })], [], undefined, []);
    expect(turns).toEqual([
      expect.objectContaining({ key: "turn:p", status: "sending", command: null, inputText: "text p", live: true }),
      expect.objectContaining({ key: "turn:e", status: "send_failed", unsentError: error }),
    ]);
    expect(turns[0]).not.toHaveProperty("unsentError");
  });

  it("returns prev by === reference when entry keys, statuses, commands, and errors are unchanged", () => {
    const first = buildPendingRouterTurns([raw("p", "pending")], [], undefined, []);
    expect(buildPendingRouterTurns([raw("p", "pending")], [], undefined, first)).toBe(first);
    expect(buildPendingRouterTurns([raw("p", "error")], [], undefined, first)).not.toBe(first);
    expect(buildPendingRouterTurns([], [], undefined, first)).toEqual([]);
  });
});

describe("retryStateOf", () => {
  it("marks a failed command as retrying only while the retry targets its current updatedAt", () => {
    const failed = turnEntryOfCommand(command({ id: 5, status: "failed", updatedAt: 50 }), undefined, true);
    expect(retryStateOf(failed, { 5: 50 }, {})).toEqual({ retryPending: true, retryError: undefined });
    expect(retryStateOf(failed, { 5: 49 }, {})).toEqual({ retryPending: false, retryError: undefined });
    expect(retryStateOf(failed, {}, { 5: "Router is offline" })).toEqual({ retryPending: false, retryError: "Router is offline" });
    const pending: RouterTurnEntry = { ...failed, command: null };
    expect(retryStateOf(pending, { 5: 50 }, { 5: "x" })).toEqual({ retryPending: false, retryError: undefined });
  });
});

describe("useRouterCommands", () => {
  let api: FakeApi;
  let qc: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);

  beforeEach(() => {
    api = new FakeApi(makeSnapshot());
    api.install();
    qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    qc.clear();
  });

  it("dispatches POST /api/router/commands under ROUTER_COMMAND_MUTATION_KEY and returns the generated clientId", async () => {
    const { result } = renderHook(() => useRouterCommands([], undefined), { wrapper });
    let clientId = "";
    act(() => {
      clientId = result.current.send({ text: "status?" });
    });
    expect(clientId).not.toBe("");
    await waitFor(() => expect(result.current.pendingTurns.map((t) => [t.clientId, t.status])).toEqual([[clientId, "planning"]]));
    const [call] = api.callsTo("POST", /^\/api\/router\/commands$/);
    expect(call?.body).toEqual({ clientId, text: "status?" });
    expect(clientIdsIn(qc)).toEqual([clientId]);
  });

  it("retries an unsent mutation after removing its failed cache entry", async () => {
    let fail = true;
    const ok = api.postRouterCommand;
    api.postRouterCommand = (body) => (fail ? { status: 503, body: { error: "busy" } } : ok(body));
    const { result } = renderHook(() => useRouterCommands([], undefined), { wrapper });
    let clientId = "";
    act(() => {
      clientId = result.current.send({ text: "again" });
    });
    await waitFor(() => expect(result.current.pendingTurns[0]?.status).toBe("send_failed"));
    fail = false;
    act(() => result.current.retryUnsent(clientId));
    await waitFor(() => expect(result.current.pendingTurns[0]?.status).toBe("planning"));
    expect(result.current.pendingTurns.map((t) => t.clientId)).toEqual([clientId]);
    expect(clientIdsIn(qc)).toEqual([clientId]);
    expect(api.callsTo("POST", /^\/api\/router\/commands$/).map((c) => c.body)).toEqual([
      { clientId, text: "again" },
      { clientId, text: "again" },
    ]);
  });

  it("retries a failed server command via POST /api/router/commands/:id/retry and clears retry state once updatedAt advances", async () => {
    const failed = turnEntryOfCommand(command({ id: 7, clientId: "f", status: "failed", updatedAt: 70 }), undefined, true);
    const { result, rerender } = renderHook(({ live }) => useRouterCommands(live, undefined), { wrapper, initialProps: { live: [failed] } });
    act(() => result.current.retryCommand(7, 70));
    expect(result.current.retryingMap).toEqual({ 7: 70 });
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/router\/commands\/7\/retry$/)).toHaveLength(1));
    expect(result.current.retryingMap).toEqual({ 7: 70 });
    const running = turnEntryOfCommand(command({ id: 7, clientId: "f", status: "planning", plan: null, updatedAt: 71 }), undefined, true);
    rerender({ live: [running] });
    await waitFor(() => expect(result.current.retryingMap).toEqual({}));
  });

  it("keeps the retry error until the command stops failing", async () => {
    api.retryRouterCommand = () => ({ status: 409, body: { error: "busy" } });
    const failed = turnEntryOfCommand(command({ id: 8, clientId: "g", status: "failed", updatedAt: 80 }), undefined, true);
    const { result } = renderHook(() => useRouterCommands([failed], undefined), { wrapper });
    act(() => result.current.retryCommand(8, 80));
    await waitFor(() => expect(result.current.retryErrors[8]).toMatchObject({ raw: "busy" }));
    expect(result.current.retryingMap).toEqual({});
  });
});

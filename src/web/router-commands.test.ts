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
  ROUTER_RETRY_MUTATION_KEY,
  buildPendingRouterTurns,
  buildRouterRetryState,
  pruneRouterCommandMutations,
  pruneRouterRetryMutations,
  retryStateOf,
  useRouterCommands,
  type RawRouterMutation,
  type RawRouterRetry,
  type RouterCommandVariables,
  type RouterRetryVariables,
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

describe("buildRouterRetryState", () => {
  const retry = (commandId: number, status: RawRouterRetry["status"], version = commandId * 10, error: unknown = null): RawRouterRetry => ({
    commandId,
    version,
    status,
    error,
  });

  it("keeps each command's latest retry: posting while in flight, the retried version once accepted, the error once failed", () => {
    const state = buildRouterRetryState(
      [
        retry(1, "error", 10, new Error("x")),
        retry(1, "pending", 11),
        retry(2, "success"),
        retry(3, "error", 30, new Error("down")),
        retry(4, "idle"),
        { commandId: 5, version: undefined, status: "success", error: null },
        null,
      ],
      { retryingMap: {}, retryErrors: {} },
    );
    expect(state.retryingMap).toEqual({ 1: "posting", 2: 20, 4: "posting" });
    expect(Object.keys(state.retryErrors)).toEqual(["3"]);
  });

  it("returns prev, or prev's unchanged record, by === reference", () => {
    const error = new Error("down");
    const first = buildRouterRetryState([retry(1, "pending"), retry(2, "error", 20, error)], { retryingMap: {}, retryErrors: {} });
    expect(buildRouterRetryState([retry(1, "pending"), retry(2, "error", 20, error)], first)).toBe(first);
    const accepted = buildRouterRetryState([retry(1, "success"), retry(2, "error", 20, error)], first);
    expect(accepted.retryingMap).toEqual({ 1: 10 });
    expect(accepted.retryErrors).toBe(first.retryErrors);
    expect(buildRouterRetryState([retry(1, "success"), retry(2, "error", 20, error)], accepted)).toBe(accepted);
    const cleared = buildRouterRetryState([retry(2, "error", 20, error)], accepted);
    expect(cleared.retryingMap).toEqual({});
    expect(cleared.retryErrors).toBe(first.retryErrors);
  });
});

describe("pruneRouterRetryMutations", () => {
  function seedRetry(qc: QueryClient, commandId: number, version: number, status: MutationState["status"]) {
    const state: MutationState<PostRouterCommandResponse, unknown, RouterRetryVariables, unknown> = {
      context: undefined,
      data: undefined,
      error: status === "error" ? new Error("down") : null,
      failureCount: 0,
      failureReason: null,
      isPaused: false,
      status,
      variables: { commandId, version },
      submittedAt: 1,
    };
    return qc.getMutationCache().build(qc, { mutationKey: ROUTER_RETRY_MUTATION_KEY }, state);
  }
  const failedTurn = (id: number, version: number) => turnEntryOfCommand(command({ id, clientId: `c${id}`, status: "failed", updatedAt: 1_000 }), undefined, true, version);

  it("keeps in-flight retries, accepted retries whose failed version is still live, and errors of still-failing commands, even when every updatedAt matches", () => {
    const qc = new QueryClient();
    seedRetry(qc, 1, 10, "pending");
    seedRetry(qc, 2, 20, "success");
    seedRetry(qc, 3, 30, "success");
    seedRetry(qc, 4, 40, "error");
    seedRetry(qc, 5, 50, "error");
    pruneRouterRetryMutations(qc, [failedTurn(2, 20), failedTurn(3, 32), failedTurn(4, 42)]);
    const left = qc.getMutationCache().getAll().map((m) => (m.state.variables as RouterRetryVariables).commandId);
    expect(left).toEqual([1, 2, 4]);
  });
});

describe("retryStateOf", () => {
  it("marks a failed command as retrying while its retry is posting, or accepted from the version the turn still shows", () => {
    const failed = turnEntryOfCommand(command({ id: 5, status: "failed", updatedAt: 50 }), undefined, true, 7);
    expect(retryStateOf(failed, { 5: "posting" }, {})).toEqual({ retryPending: true, retryError: undefined });
    expect(retryStateOf(failed, { 5: 7 }, {})).toEqual({ retryPending: true, retryError: undefined });
    expect(retryStateOf(failed, { 5: 6 }, {})).toEqual({ retryPending: false, retryError: undefined });
    expect(retryStateOf(failed, {}, { 5: "Router is offline" })).toEqual({ retryPending: false, retryError: "Router is offline" });
    const unversioned = turnEntryOfCommand(command({ id: 5, status: "failed", updatedAt: 50 }), undefined, true);
    expect(retryStateOf(unversioned, { 5: 7 }, {})).toEqual({ retryPending: false, retryError: undefined });
    const pending: RouterTurnEntry = { ...failed, command: null };
    expect(retryStateOf(pending, { 5: "posting" }, { 5: "x" })).toEqual({ retryPending: false, retryError: undefined });
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

  const turnAt = (id: number, version: number, over: Partial<RouterCommandRecord> = {}) =>
    turnEntryOfCommand(command({ id, clientId: `c${id}`, status: "failed", error: "down", updatedAt: 70_000, ...over }), undefined, true, version);

  it("retries a failed server command via POST /api/router/commands/:id/retry and clears retry state once a newer version arrives with the same updatedAt", async () => {
    const failed = turnAt(7, 3);
    const { result, rerender } = renderHook(({ live }) => useRouterCommands(live, undefined), { wrapper, initialProps: { live: [failed] } });
    act(() => result.current.retryCommand(7, 3));
    await waitFor(() => expect(result.current.retryingMap).toEqual({ 7: 3 }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/router\/commands\/7\/retry$/)).toHaveLength(1));
    expect(retryStateOf(failed, result.current.retryingMap, result.current.retryErrors).retryPending).toBe(true);
    rerender({ live: [turnAt(7, 4, { status: "planning", error: null })] });
    await waitFor(() => expect(result.current.retryingMap).toEqual({}));
  });

  it("keeps the retry error until the command stops failing", async () => {
    api.retryRouterCommand = () => ({ status: 409, body: { error: "busy" } });
    const failed = turnAt(8, 3);
    const { result, rerender } = renderHook(({ live }) => useRouterCommands(live, undefined), { wrapper, initialProps: { live: [failed] } });
    act(() => result.current.retryCommand(8, 3));
    await waitFor(() => expect(result.current.retryErrors[8]).toMatchObject({ raw: "busy" }));
    expect(result.current.retryingMap).toEqual({});
    const other = renderHook(() => useRouterCommands([failed], undefined), { wrapper });
    expect(other.result.current.retryErrors[8]).toMatchObject({ raw: "busy" });
    rerender({ live: [turnAt(8, 4, { status: "planning", error: null })] });
    await waitFor(() => expect(result.current.retryErrors).toEqual({}));
  });

  it("reopens Retry when the retry fails again before its HTTP reply lands, though both failures share an updatedAt", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ok = api.retryRouterCommand;
    api.retryRouterCommand = async (id) => {
      await gate;
      return ok(id);
    };
    const retryCalls = () => api.callsTo("POST", /^\/api\/router\/commands\/10\/retry$/);
    const { result, rerender } = renderHook(({ live }) => useRouterCommands(live, undefined), { wrapper, initialProps: { live: [turnAt(10, 5)] } });
    act(() => result.current.retryCommand(10, 5));
    await waitFor(() => expect(retryCalls()).toHaveLength(1));

    rerender({ live: [turnAt(10, 6, { status: "planning", error: null })] });
    const failedAgain = turnAt(10, 7);
    rerender({ live: [failedAgain] });
    expect(retryStateOf(failedAgain, result.current.retryingMap, result.current.retryErrors).retryPending).toBe(true);
    act(() => result.current.retryCommand(10, 7));
    expect(retryCalls()).toHaveLength(1);

    await act(async () => release());
    await waitFor(() => expect(result.current.retryingMap).toEqual({}));
    expect(retryStateOf(failedAgain, result.current.retryingMap, result.current.retryErrors).retryPending).toBe(false);
    act(() => result.current.retryCommand(10, 7));
    await waitFor(() => expect(retryCalls()).toHaveLength(2));
  });

  it("shares one in-flight retry across surfaces, so a surface mounted mid-retry shows it running and cannot post it again", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ok = api.retryRouterCommand;
    api.retryRouterCommand = async (id) => {
      await gate;
      return ok(id);
    };
    const retryCalls = () => api.callsTo("POST", /^\/api\/router\/commands\/9\/retry$/);
    const failed = turnAt(9, 3);
    const quick = renderHook(({ live }) => useRouterCommands(live, undefined), { wrapper, initialProps: { live: [failed] } });
    act(() => quick.result.current.retryCommand(9, 3));
    act(() => quick.result.current.retryCommand(9, 3));
    await waitFor(() => expect(retryCalls()).toHaveLength(1));
    quick.unmount();

    const page = renderHook(({ live }) => useRouterCommands(live, undefined), { wrapper, initialProps: { live: [failed] } });
    expect(retryStateOf(failed, page.result.current.retryingMap, page.result.current.retryErrors)).toEqual({ retryPending: true, retryError: undefined });
    act(() => page.result.current.retryCommand(9, 3));
    await act(async () => release());
    expect(page.result.current.retryingMap).toEqual({ 9: 3 });
    act(() => page.result.current.retryCommand(9, 3));
    expect(retryCalls()).toHaveLength(1);

    page.rerender({ live: [turnAt(9, 4, { status: "planning", error: null })] });
    await waitFor(() => expect(page.result.current.retryingMap).toEqual({}));
    expect(qc.getMutationCache().getAll()).toHaveLength(0);
  });
});

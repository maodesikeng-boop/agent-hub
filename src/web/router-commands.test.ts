import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type MutationState } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_VENDOR,
  ROUTER_STREAM_LIVE_MAX,
  type PostRouterCommandResponse,
  type RetryRouterCommandRequest,
  type RouterAgentPlan,
  type RouterCommandRecord,
} from "../shared/index.ts";
import {
  ROUTER_COMMAND_MUTATION_KEY,
  ROUTER_RETRY_MUTATION_KEY,
  buildPendingRouterTurns,
  buildRouterRetries,
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

const runOf = (retryId: string): RouterAgentPlan => ({ intent: "dispatch", reply: "", actions: [], retryId });

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

describe("buildRouterRetries", () => {
  const retry = (commandId: number, status: RawRouterRetry["status"], fromRetryId: string | null = null, error: unknown = null): RawRouterRetry => ({
    commandId,
    fromRetryId,
    status,
    error,
  });

  it("keeps each command's latest retry with the run it retried, and its error once the request failed", () => {
    const retries = buildRouterRetries(
      [retry(1, "error", null, new Error("x")), retry(1, "pending", "r1"), retry(2, "success", "r2"), retry(3, "error", null, new Error("down")), retry(4, "idle"), null],
      {},
    );
    expect(retries).toEqual({
      1: { fromRetryId: "r1" },
      2: { fromRetryId: "r2" },
      3: { fromRetryId: null, error: expect.objectContaining({ raw: "down" }) },
      4: { fromRetryId: null },
    });
  });

  it("returns prev, or prev's unchanged marks, by === reference, and treats posting and accepted alike", () => {
    const error = new Error("down");
    const first = buildRouterRetries([retry(1, "pending"), retry(2, "error", "r", error)], {});
    expect(buildRouterRetries([retry(1, "pending"), retry(2, "error", "r", error)], first)).toBe(first);
    expect(buildRouterRetries([retry(1, "success"), retry(2, "error", "r", error)], first)).toBe(first);
    const next = buildRouterRetries([retry(1, "pending", "r1"), retry(2, "error", "r", error)], first);
    expect(next).toEqual({ 1: { fromRetryId: "r1" }, 2: first[2] });
    expect(next[2]).toBe(first[2]);
    const cleared = buildRouterRetries([retry(2, "error", "r", error)], next);
    expect(cleared).toEqual({ 2: first[2] });
    expect(cleared[2]).toBe(first[2]);
  });
});

describe("pruneRouterRetryMutations", () => {
  function seedRetry(qc: QueryClient, commandId: number, fromRetryId: string | null, status: MutationState["status"]) {
    const state: MutationState<PostRouterCommandResponse, unknown, RouterRetryVariables, unknown> = {
      context: undefined,
      data: undefined,
      error: status === "error" ? new Error("down") : null,
      failureCount: 0,
      failureReason: null,
      isPaused: false,
      status,
      variables: { commandId, retryId: `next-${commandId}`, fromRetryId },
      submittedAt: 1,
    };
    return qc.getMutationCache().build(qc, { mutationKey: ROUTER_RETRY_MUTATION_KEY }, state);
  }
  const turnOf = (id: number, over: Partial<RouterCommandRecord> = {}) =>
    turnEntryOfCommand(command({ id, clientId: `c${id}`, status: "failed", ...over }), undefined, true);

  it("keeps in-flight retries and settled ones whose command still fails on the run they retried, and drops the rest", () => {
    const qc = new QueryClient();
    seedRetry(qc, 1, null, "pending");
    seedRetry(qc, 2, null, "success");
    seedRetry(qc, 3, null, "success");
    seedRetry(qc, 4, "r4", "error");
    seedRetry(qc, 5, null, "error");
    seedRetry(qc, 6, null, "error");
    seedRetry(qc, 6, null, "pending");
    seedRetry(qc, 7, null, "success");
    pruneRouterRetryMutations(qc, [turnOf(2), turnOf(3, { plan: runOf("r3") }), turnOf(4, { plan: runOf("r4") }), turnOf(6), turnOf(7, { status: "planning" })]);
    const left = qc.getMutationCache().getAll().map((m) => [(m.state.variables as RouterRetryVariables).commandId, m.state.status]);
    expect(left).toEqual([
      [1, "pending"],
      [2, "success"],
      [4, "error"],
      [6, "pending"],
    ]);
  });
});

describe("retryStateOf", () => {
  it("shows a failed command as retrying only while its retry is for the run the command still shows", () => {
    const firstRun = turnEntryOfCommand(command({ id: 5, status: "failed" }), undefined, true);
    const secondRun = turnEntryOfCommand(command({ id: 5, status: "failed", plan: runOf("r1") }), undefined, true);
    expect(retryStateOf(firstRun, { 5: { fromRetryId: null } })).toEqual({ retryPending: true, retryError: undefined });
    expect(retryStateOf(secondRun, { 5: { fromRetryId: null } })).toEqual({ retryPending: false, retryError: undefined });
    expect(retryStateOf(secondRun, { 5: { fromRetryId: "r1" } })).toEqual({ retryPending: true, retryError: undefined });
    expect(retryStateOf(firstRun, { 5: { fromRetryId: null, error: "Router is offline" } })).toEqual({ retryPending: false, retryError: "Router is offline" });
    expect(retryStateOf(secondRun, { 5: { fromRetryId: null, error: "Router is offline" } })).toEqual({ retryPending: false, retryError: undefined });
    const planning = turnEntryOfCommand(command({ id: 5, status: "planning", plan: runOf("r1") }), undefined, true);
    expect(retryStateOf(planning, { 5: { fromRetryId: "r1" } })).toEqual({ retryPending: false, retryError: undefined });
    const unsent: RouterTurnEntry = { ...firstRun, command: null };
    expect(retryStateOf(unsent, { 5: { fromRetryId: null } })).toEqual({ retryPending: false, retryError: undefined });
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

  const turnAt = (id: number, over: Partial<RouterCommandRecord> = {}) =>
    turnEntryOfCommand(command({ id, clientId: `c${id}`, status: "failed", error: "down", updatedAt: 70_000, ...over }), undefined, true);
  const retryCalls = (id: number) => api.callsTo("POST", new RegExp(`^/api/router/commands/${id}/retry$`));
  const retryBody = (id: number, i = 0) => retryCalls(id)[i]?.body as RetryRouterCommandRequest;
  const retriesIn = (status: MutationState["status"]) => qc.getMutationCache().findAll({ mutationKey: ROUTER_RETRY_MUTATION_KEY, status });

  /** Holds every retry POST until the returned release runs. */
  function holdRetries(): () => void {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ok = api.retryRouterCommand;
    api.retryRouterCommand = async (id, body) => {
      await gate;
      return ok(id, body);
    };
    return () => release();
  }

  it("posts a fresh retryId with the run it retries, and settles once that retry's own run shows, whatever its updatedAt", async () => {
    const failed = turnAt(7);
    const { result, rerender } = renderHook(({ live }) => useRouterCommands(live, undefined), { wrapper, initialProps: { live: [failed] } });
    act(() => result.current.retryCommand(7, null));
    await waitFor(() => expect(retriesIn("success")).toHaveLength(1));
    expect(retryBody(7)).toEqual({ retryId: expect.any(String), fromRetryId: null });
    expect(result.current.retries).toEqual({ 7: { fromRetryId: null } });
    expect(retryStateOf(failed, result.current.retries).retryPending).toBe(true);

    rerender({ live: [turnAt(7, { status: "planning", error: null, plan: runOf(retryBody(7).retryId) })] });
    await waitFor(() => expect(result.current.retries).toEqual({}));
  });

  it("keeps a retry error while the command still fails on the run it retried, and drops it once another run shows", async () => {
    api.retryRouterCommand = () => ({ status: 409, body: { error: "busy" } });
    const failed = turnAt(8);
    const { result, rerender } = renderHook(({ live }) => useRouterCommands(live, undefined), { wrapper, initialProps: { live: [failed] } });
    act(() => result.current.retryCommand(8, null));
    await waitFor(() => expect(result.current.retries[8]?.error).toMatchObject({ raw: "busy" }));
    expect(retryStateOf(failed, result.current.retries)).toEqual({ retryPending: false, retryError: expect.objectContaining({ raw: "busy" }) });
    const other = renderHook(() => useRouterCommands([failed], undefined), { wrapper });
    expect(other.result.current.retries[8]?.error).toMatchObject({ raw: "busy" });
    rerender({ live: [turnAt(8, { plan: runOf("from-another-tab") })] });
    await waitFor(() => expect(result.current.retries).toEqual({}));
  });

  it("settles a retry as soon as its own run shows, before its HTTP reply, and starts the next retry from that run", async () => {
    const release = holdRetries();
    const { result, rerender } = renderHook(({ live }) => useRouterCommands(live, undefined), { wrapper, initialProps: { live: [turnAt(10)] } });
    act(() => result.current.retryCommand(10, null));
    await waitFor(() => expect(retryCalls(10)).toHaveLength(1));
    act(() => result.current.retryCommand(10, null));
    expect(retryCalls(10)).toHaveLength(1);

    const { retryId } = retryBody(10);
    const failedAgain = turnAt(10, { plan: runOf(retryId) });
    rerender({ live: [failedAgain] });
    expect(retryStateOf(failedAgain, result.current.retries).retryPending).toBe(false);
    act(() => result.current.retryCommand(10, retryId));
    await waitFor(() => expect(retryCalls(10)).toHaveLength(2));
    expect(retryBody(10, 1)).toEqual({ retryId: expect.any(String), fromRetryId: retryId });
    expect(retryBody(10, 1).retryId).not.toBe(retryId);

    await act(async () => release());
    await waitFor(() => expect(qc.getMutationCache().getAll().map((m) => [(m.state.variables as RouterRetryVariables).fromRetryId, m.state.status])).toEqual([[retryId, "success"]]));
    expect(retryStateOf(failedAgain, result.current.retries).retryPending).toBe(true);
  });

  it("shares one in-flight retry across surfaces, so a surface mounted mid-retry shows it running and cannot post it again", async () => {
    const release = holdRetries();
    const failed = turnAt(9);
    const quick = renderHook(({ live }) => useRouterCommands(live, undefined), { wrapper, initialProps: { live: [failed] } });
    act(() => quick.result.current.retryCommand(9, null));
    act(() => quick.result.current.retryCommand(9, null));
    await waitFor(() => expect(retryCalls(9)).toHaveLength(1));
    quick.unmount();

    const page = renderHook(({ live }) => useRouterCommands(live, undefined), { wrapper, initialProps: { live: [failed] } });
    expect(retryStateOf(failed, page.result.current.retries)).toEqual({ retryPending: true, retryError: undefined });
    act(() => page.result.current.retryCommand(9, null));
    await act(async () => release());
    await waitFor(() => expect(retriesIn("success")).toHaveLength(1));
    expect(page.result.current.retries).toEqual({ 9: { fromRetryId: null } });
    act(() => page.result.current.retryCommand(9, null));
    expect(retryCalls(9)).toHaveLength(1);

    page.rerender({ live: [turnAt(9, { status: "planning", error: null, plan: runOf(retryBody(9).retryId) })] });
    await waitFor(() => expect(page.result.current.retries).toEqual({}));
    expect(qc.getMutationCache().getAll()).toHaveLength(0);
  });
});

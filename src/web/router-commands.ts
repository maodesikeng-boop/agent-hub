// Invariant: pending Router commands and command retries share ROUTER_COMMAND_MUTATION_KEY and ROUTER_RETRY_MUTATION_KEY across surfaces, deduplicated against live server turns.
import { useMutation, useMutationState, type Mutation, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ROUTER_STREAM_LIVE_MAX,
  type Attachment,
  type PostRouterCommandResponse,
  type PostRouterCommandTarget,
  type RetryRouterCommandRequest,
  type RouterCommandId,
  type RouterCommandRecord,
} from "../shared/index.ts";
import { localClient } from "./client.ts";
import { errorText, newClientId, type ErrorLike } from "./format.ts";
import { useHubQueryClient } from "./query-client.ts";
import { runRetryIdOf, turnEntryOfCommand, type RouterTurnEntry } from "./router-stream.ts";

export const ROUTER_COMMAND_MUTATION_KEY = ["router-command"] as const;
export const ROUTER_RETRY_MUTATION_KEY = ["router-command-retry"] as const;

export interface RouterCommandVariables {
  clientId: string;
  text: string;
  attachments: Attachment[];
  attachmentIds: string[];
  target?: PostRouterCommandTarget;
  routerOnly?: true;
  createdAt: number;
}

export interface RouterRetryVariables extends RetryRouterCommandRequest {
  commandId: RouterCommandId;
}

export interface RawRouterRetry {
  commandId: RouterCommandId;
  fromRetryId: string | null;
  status: "idle" | "pending" | "success" | "error";
  error: unknown;
}

/** A command's latest retry: the failed run it retried, and the error its request got if it failed. */
export interface RouterRetryMark {
  fromRetryId: string | null;
  error?: ErrorLike;
}

export type RouterRetries = Readonly<Record<RouterCommandId, RouterRetryMark>>;

export interface RawRouterMutation {
  clientId: string;
  variables: RouterCommandVariables;
  status: "idle" | "pending" | "success" | "error";
  data: PostRouterCommandResponse | undefined;
  error: unknown;
}

export interface SendRouterCommandInput {
  text: string;
  attachments?: Attachment[];
  target?: PostRouterCommandTarget;
  /** Router itself plans the text, so a leading `@name` is not a direct-forward shortcut. */
  routerOnly?: boolean;
}

export interface RouterCommandsState {
  send: (input: SendRouterCommandInput) => string;
  pendingTurns: readonly RouterTurnEntry[];
  retryUnsent: (clientId: string) => void;
  retries: RouterRetries;
  retryCommand: (commandId: RouterCommandId, fromRetryId: string | null) => void;
}

const NO_PENDING_TURNS: readonly RouterTurnEntry[] = [];
const NO_ATTACHMENTS: Attachment[] = [];
const NO_RETRIES: RouterRetries = {};
const NOT_RETRYING = { retryPending: false, retryError: undefined } as const;

/**
 * Precondition: confirmedClientIds contains the clientIds already present in live server turns.
 * Postcondition: removes every succeeded mutation whose clientId is confirmed and evicts the oldest non-pending mutations past ROUTER_STREAM_LIVE_MAX.
 */
export function pruneRouterCommandMutations(qc: QueryClient, confirmedClientIds: ReadonlySet<string>): void {
  const cache = qc.getMutationCache();
  for (const m of cache.findAll({ mutationKey: ROUTER_COMMAND_MUTATION_KEY })) {
    const vars = m.state.variables as RouterCommandVariables | undefined;
    if (m.state.status === "success" && vars && confirmedClientIds.has(vars.clientId)) cache.remove(m);
  }
  const remaining = cache.findAll({ mutationKey: ROUTER_COMMAND_MUTATION_KEY });
  let excess = remaining.length - ROUTER_STREAM_LIVE_MAX;
  for (const m of remaining) {
    if (excess <= 0) break;
    if (m.state.status !== "pending") {
      cache.remove(m);
      excess--;
    }
  }
}

/**
 * Precondition: rawMutations are ordered oldest-first from React Query's mutation cache and liveTurns are confirmed server turns.
 * Postcondition: returns unconfirmed optimistic turns deduplicated by clientId, omitting any clientId present in liveTurns, and returns prev when no entry's key, status, command, or unsentError changed.
 */
export function buildPendingRouterTurns(
  rawMutations: readonly (RawRouterMutation | null)[],
  liveTurns: readonly RouterTurnEntry[],
  selfId: string | undefined,
  prev: readonly RouterTurnEntry[],
): readonly RouterTurnEntry[] {
  if (rawMutations.length === 0) return NO_PENDING_TURNS;
  const liveClientIds = new Set<string>();
  for (const t of liveTurns) if (t.clientId) liveClientIds.add(t.clientId);
  const latest = new Map<string, RawRouterMutation>();
  for (const m of rawMutations) if (m !== null) latest.set(m.clientId, m);
  const built: RouterTurnEntry[] = [];
  for (const [clientId, m] of latest) {
    if (liveClientIds.has(clientId)) continue;
    if (m.status === "success" && m.data?.command) {
      built.push(turnEntryOfCommand(m.data.command, selfId, true));
      continue;
    }
    const failed = m.status === "error";
    built.push({
      kind: "turn",
      key: `turn:${clientId}`,
      clientId,
      createdAt: m.variables.createdAt,
      inputText: m.variables.text,
      attachments: m.variables.attachments,
      status: failed ? "send_failed" : "sending",
      ...(failed ? { unsentError: m.error } : {}),
      command: null,
      destinations: [],
      live: true,
    });
  }
  if (built.length === 0) return NO_PENDING_TURNS;
  const unchanged =
    prev.length === built.length &&
    built.every((cur, i) => {
      const p = prev[i]!;
      return p.key === cur.key && p.status === cur.status && p.command === cur.command && p.unsentError === cur.unsentError;
    });
  return unchanged ? prev : built;
}

/** A retry speaks only for the run it retried: once the command shows another run, that run's own status and Retry apply. */
const speaksFor = (fromRetryId: string | null, command: RouterCommandRecord): boolean => fromRetryId === runRetryIdOf(command);

/** Whether a failed turn is mid-retry (shown as running) and the error of its last retry, for one turn row. */
export function retryStateOf(entry: RouterTurnEntry, retries: RouterRetries): { retryPending: boolean; retryError: ErrorLike | undefined } {
  const command = entry.command;
  const mark = command === null ? undefined : retries[command.id];
  if (command === null || mark === undefined || !speaksFor(mark.fromRetryId, command)) return NOT_RETRYING;
  return mark.error === undefined ? { retryPending: command.status === "failed", retryError: undefined } : { retryPending: false, retryError: mark.error };
}

function selectRouterMutation(m: Mutation<unknown, unknown, unknown, unknown>): RawRouterMutation | null {
  const vars = m.state.variables as RouterCommandVariables | undefined;
  if (!vars || typeof vars.clientId !== "string") return null;
  return {
    clientId: vars.clientId,
    variables: vars,
    status: m.state.status,
    data: m.state.data as PostRouterCommandResponse | undefined,
    error: m.state.error,
  };
}

const retryVarsOf = (m: { state: { variables: unknown } }) => m.state.variables as RouterRetryVariables | undefined;

function selectRouterRetry(m: Mutation<unknown, unknown, unknown, unknown>): RawRouterRetry | null {
  const vars = retryVarsOf(m);
  if (vars === undefined || typeof vars.commandId !== "number") return null;
  return { commandId: vars.commandId, fromRetryId: vars.fromRetryId, status: m.state.status, error: m.state.error };
}

const retryErrorCache = new WeakMap<object, ErrorLike>();

function retryErrorOf(error: unknown): ErrorLike {
  if (typeof error !== "object" || error === null) return errorText(error);
  let hit = retryErrorCache.get(error);
  if (hit === undefined) {
    hit = errorText(error);
    retryErrorCache.set(error, hit);
  }
  return hit;
}

function sameEntries<V>(a: Readonly<Record<RouterCommandId, V>>, b: Readonly<Record<RouterCommandId, V>>): boolean {
  const entries = Object.entries(a);
  return entries.length === Object.keys(b).length && entries.every(([id, v]) => b[Number(id)] === v);
}

/**
 * Precondition: rawRetries are ordered oldest-first from React Query's mutation cache.
 * Postcondition: maps each command's latest retry to the run it retried and, when its request failed, the error, returning prev or prev's marks when they are unchanged.
 */
export function buildRouterRetries(rawRetries: readonly (RawRouterRetry | null)[], prev: RouterRetries): RouterRetries {
  const latest = new Map<RouterCommandId, RawRouterRetry>();
  for (const r of rawRetries) if (r !== null) latest.set(r.commandId, r);
  const next: Record<RouterCommandId, RouterRetryMark> = {};
  for (const [id, r] of latest) {
    const error = r.status === "error" ? retryErrorOf(r.error) : undefined;
    const old = prev[id];
    next[id] =
      old !== undefined && old.fromRetryId === r.fromRetryId && old.error === error
        ? old
        : { fromRetryId: r.fromRetryId, ...(error !== undefined ? { error } : {}) };
  }
  return sameEntries(prev, next) ? prev : next;
}

/**
 * Precondition: liveTurns are confirmed server turns.
 * Postcondition: keeps in-flight retries and removes each settled one that no longer speaks for its failed command: replaced by a newer retry, or its command gone, no longer failing, or showing another run.
 */
export function pruneRouterRetryMutations(qc: QueryClient, liveTurns: readonly RouterTurnEntry[]): void {
  const failed = new Map<RouterCommandId, RouterCommandRecord>();
  for (const t of liveTurns) if (t.command?.status === "failed") failed.set(t.command.id, t.command);
  const cache = qc.getMutationCache();
  const all = cache.findAll({ mutationKey: ROUTER_RETRY_MUTATION_KEY });
  const latest = new Map<RouterCommandId, (typeof all)[number]>();
  for (const m of all) {
    const vars = retryVarsOf(m);
    if (vars !== undefined) latest.set(vars.commandId, m);
  }
  for (const m of all) {
    if (m.state.status === "pending" || m.state.status === "idle") continue;
    const vars = retryVarsOf(m);
    const command = vars === undefined ? undefined : failed.get(vars.commandId);
    if (vars === undefined || command === undefined || latest.get(vars.commandId) !== m || !speaksFor(vars.fromRetryId, command)) cache.remove(m);
  }
}

function useCommandRetries(liveTurns: readonly RouterTurnEntry[], qc: QueryClient) {
  const { mutate } = useMutation<PostRouterCommandResponse, unknown, RouterRetryVariables>(
    {
      mutationKey: ROUTER_RETRY_MUTATION_KEY,
      gcTime: Infinity,
      mutationFn: ({ commandId, retryId, fromRetryId }) => localClient.postRetryRouterCommand(commandId, { retryId, fromRetryId }),
    },
    qc,
  );
  const rawRetries = useMutationState({ filters: { mutationKey: ROUTER_RETRY_MUTATION_KEY }, select: selectRouterRetry }, qc);

  const prevRetriesRef = useRef(NO_RETRIES);
  const retries = useMemo(() => {
    const next = buildRouterRetries(rawRetries, prevRetriesRef.current);
    prevRetriesRef.current = next;
    return next;
  }, [rawRetries]);

  useEffect(() => {
    if (rawRetries.length > 0) pruneRouterRetryMutations(qc, liveTurns);
  }, [rawRetries, liveTurns, qc]);

  const retryCommand = useCallback(
    (commandId: RouterCommandId, fromRetryId: string | null) => {
      const cache = qc.getMutationCache();
      const earlier = cache.findAll({ mutationKey: ROUTER_RETRY_MUTATION_KEY, predicate: (m) => retryVarsOf(m)?.commandId === commandId });
      // The cache is shared by every surface, so a retry of this run that is posting or accepted blocks a second POST anywhere.
      if (earlier.some((m) => m.state.status !== "error" && retryVarsOf(m)?.fromRetryId === fromRetryId)) return;
      for (const m of earlier) if (m.state.status === "success" || m.state.status === "error") cache.remove(m);
      mutate({ commandId, retryId: newClientId(), fromRetryId });
    },
    [qc, mutate],
  );

  return { retries, retryCommand };
}

/**
 * Precondition: called inside a React component under QueryClientProvider.
 * Postcondition: returns stable send, retryUnsent, and retryCommand callbacks backed by ROUTER_COMMAND_MUTATION_KEY and ROUTER_RETRY_MUTATION_KEY, plus referentially stable pendingTurns and retry state shared by every surface.
 */
export function useRouterCommands(liveTurns: readonly RouterTurnEntry[], selfId: string | undefined): RouterCommandsState {
  const qc = useHubQueryClient();
  const { mutate } = useMutation<PostRouterCommandResponse, unknown, RouterCommandVariables>(
    {
      mutationKey: ROUTER_COMMAND_MUTATION_KEY,
      gcTime: Infinity,
      mutationFn: (vars) =>
        localClient.postRouterCommand({
          clientId: vars.clientId,
          text: vars.text,
          ...(vars.attachmentIds.length > 0 ? { attachmentIds: vars.attachmentIds } : {}),
          ...(vars.target !== undefined ? { target: vars.target } : {}),
          ...(vars.routerOnly === true ? { routerOnly: true } : {}),
        }),
    },
    qc,
  );
  const rawMutations = useMutationState({ filters: { mutationKey: ROUTER_COMMAND_MUTATION_KEY }, select: selectRouterMutation }, qc);

  const prevPendingRef = useRef<readonly RouterTurnEntry[]>(NO_PENDING_TURNS);
  const pendingTurns = useMemo(() => {
    const next = buildPendingRouterTurns(rawMutations, liveTurns, selfId, prevPendingRef.current);
    prevPendingRef.current = next;
    return next;
  }, [rawMutations, liveTurns, selfId]);

  useEffect(() => {
    if (rawMutations.length === 0) return;
    const confirmed = new Set<string>();
    for (const t of liveTurns) if (t.clientId) confirmed.add(t.clientId);
    pruneRouterCommandMutations(qc, confirmed);
  }, [rawMutations.length, liveTurns, qc]);

  const send = useCallback(
    ({ text, attachments = NO_ATTACHMENTS, target, routerOnly = false }: SendRouterCommandInput) => {
      const clientId = newClientId();
      mutate({
        clientId,
        text,
        attachments,
        attachmentIds: attachments.map((a) => a.id),
        ...(target !== undefined ? { target } : {}),
        ...(routerOnly ? { routerOnly: true } : {}),
        createdAt: Date.now(),
      });
      return clientId;
    },
    [mutate],
  );

  const retryUnsent = useCallback(
    (clientId: string) => {
      const cache = qc.getMutationCache();
      let latest: RouterCommandVariables | undefined;
      for (const m of cache.findAll({ mutationKey: ROUTER_COMMAND_MUTATION_KEY })) {
        const vars = m.state.variables as RouterCommandVariables | undefined;
        if (vars?.clientId !== clientId) continue;
        latest = vars;
        if (m.state.status === "error") cache.remove(m);
      }
      if (latest !== undefined) mutate(latest);
    },
    [qc, mutate],
  );

  const { retries, retryCommand } = useCommandRetries(liveTurns, qc);

  return useMemo(
    () => ({ send, pendingTurns, retryUnsent, retries, retryCommand }),
    [send, pendingTurns, retryUnsent, retries, retryCommand],
  );
}

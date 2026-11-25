// Invariant: pending Router commands share ROUTER_COMMAND_MUTATION_KEY across surfaces and deduplicate against live server turns by clientId.
import { useMutation, useMutationState, type Mutation, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ROUTER_STREAM_LIVE_MAX,
  type Attachment,
  type PostRouterCommandResponse,
  type PostRouterCommandTarget,
  type RouterCommandId,
} from "../shared/index.ts";
import { localClient } from "./client.ts";
import { errorText, newClientId, type ErrorLike } from "./format.ts";
import { useHubQueryClient } from "./query-client.ts";
import { turnEntryOfCommand, type RouterTurnEntry } from "./router-stream.ts";

export const ROUTER_COMMAND_MUTATION_KEY = ["router-command"] as const;

export interface RouterCommandVariables {
  clientId: string;
  text: string;
  attachments: Attachment[];
  attachmentIds: string[];
  target?: PostRouterCommandTarget;
  createdAt: number;
}

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
}

export interface RouterCommandsState {
  send: (input: SendRouterCommandInput) => string;
  pendingTurns: readonly RouterTurnEntry[];
  retryUnsent: (clientId: string) => void;
  retryCommand: (commandId: RouterCommandId, updatedAt: number) => void;
  retryingMap: Readonly<Record<RouterCommandId, number>>;
  retryErrors: Readonly<Record<RouterCommandId, ErrorLike>>;
}

const NO_PENDING_TURNS: readonly RouterTurnEntry[] = [];
const NO_ATTACHMENTS: Attachment[] = [];

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

/** Whether a failed turn is mid-retry (shown as running) and the error of its last retry, for one turn row. */
export function retryStateOf(
  entry: RouterTurnEntry,
  retryingMap: Readonly<Record<RouterCommandId, number>>,
  retryErrors: Readonly<Record<RouterCommandId, ErrorLike>>,
): { retryPending: boolean; retryError: ErrorLike | undefined } {
  const command = entry.command;
  if (command === null) return { retryPending: false, retryError: undefined };
  const retryingAt = retryingMap[command.id];
  return {
    retryPending: command.status === "failed" && retryingAt !== undefined && retryingAt === command.updatedAt,
    retryError: retryErrors[command.id],
  };
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

function withoutKey<V>(record: Readonly<Record<RouterCommandId, V>>, key: RouterCommandId): Readonly<Record<RouterCommandId, V>> {
  if (record[key] === undefined) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function useCommandRetries(liveTurns: readonly RouterTurnEntry[]) {
  const lockRef = useRef(new Set<RouterCommandId>());
  const [retryingMap, setRetryingMap] = useState<Readonly<Record<RouterCommandId, number>>>({});
  const [retryErrors, setRetryErrors] = useState<Readonly<Record<RouterCommandId, ErrorLike>>>({});

  useEffect(() => {
    const hasRetrying = Object.keys(retryingMap).length > 0;
    const hasErrors = Object.keys(retryErrors).length > 0;
    if (!hasRetrying && !hasErrors) return;
    const liveFailed = new Map<RouterCommandId, number>();
    for (const t of liveTurns) if (t.command && t.command.status === "failed") liveFailed.set(t.command.id, t.command.updatedAt);
    if (hasRetrying) {
      setRetryingMap((prev) => {
        const kept = Object.entries(prev).filter(([id, prevAt]) => liveFailed.get(Number(id)) === prevAt);
        return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
      });
    }
    if (hasErrors) {
      setRetryErrors((prev) => {
        const kept = Object.entries(prev).filter(([id]) => liveFailed.has(Number(id)));
        return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
      });
    }
  }, [liveTurns, retryingMap, retryErrors]);

  const retryCommand = useCallback((commandId: RouterCommandId, updatedAt: number) => {
    if (lockRef.current.has(commandId)) return;
    lockRef.current.add(commandId);
    setRetryingMap((prev) => ({ ...prev, [commandId]: updatedAt }));
    setRetryErrors((prev) => withoutKey(prev, commandId));
    localClient
      .postRetryRouterCommand(commandId)
      .catch((err: unknown) => {
        setRetryingMap((prev) => withoutKey(prev, commandId));
        setRetryErrors((prev) => ({ ...prev, [commandId]: errorText(err) }));
      })
      .finally(() => lockRef.current.delete(commandId));
  }, []);

  return { retryingMap, retryErrors, retryCommand };
}

/**
 * Precondition: called inside a React component under QueryClientProvider.
 * Postcondition: returns stable send, retryUnsent, and retryCommand callbacks backed by ROUTER_COMMAND_MUTATION_KEY, plus referentially stable pendingTurns and server retry state.
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
    ({ text, attachments = NO_ATTACHMENTS, target }: SendRouterCommandInput) => {
      const clientId = newClientId();
      mutate({
        clientId,
        text,
        attachments,
        attachmentIds: attachments.map((a) => a.id),
        ...(target !== undefined ? { target } : {}),
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

  const { retryingMap, retryErrors, retryCommand } = useCommandRetries(liveTurns);

  return useMemo(
    () => ({ send, pendingTurns, retryUnsent, retryCommand, retryingMap, retryErrors }),
    [send, pendingTurns, retryUnsent, retryCommand, retryingMap, retryErrors],
  );
}

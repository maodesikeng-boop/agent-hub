// Invariant: pending Router commands share ROUTER_COMMAND_MUTATION_KEY across surfaces and deduplicate against live server turns by clientId.
import type { QueryClient } from "@tanstack/react-query";
import type { Attachment, PostRouterCommandResponse, PostRouterCommandTarget, RouterCommandId } from "../shared/index.ts";
import type { ErrorLike } from "./format.ts";
import type { RouterTurnEntry } from "./router-stream.ts";

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
  retryCommand: (commandId: RouterCommandId, updatedAt: number) => Promise<void>;
  retryingMap: Readonly<Record<RouterCommandId, number>>;
  retryErrors: Readonly<Record<RouterCommandId, ErrorLike>>;
}

/**
 * Precondition: confirmedClientIds contains the clientIds already present in live server turns.
 * Postcondition: removes every succeeded mutation whose clientId is confirmed and evicts the oldest non-pending mutations past ROUTER_STREAM_LIVE_MAX.
 */
export function pruneRouterCommandMutations(_qc: QueryClient, _confirmedClientIds: ReadonlySet<string>): void {
  throw new Error("Not implemented");
}

/**
 * Precondition: rawMutations are ordered oldest-first from React Query's mutation cache and liveTurns are confirmed server turns.
 * Postcondition: returns unconfirmed optimistic turns deduplicated by clientId, omitting any clientId present in liveTurns, and returns prev when no entry's key, status, command, or unsentError changed.
 */
export function buildPendingRouterTurns(
  _rawMutations: readonly (RawRouterMutation | null)[],
  _liveTurns: readonly RouterTurnEntry[],
  _selfId: string | undefined,
  _prev: readonly RouterTurnEntry[],
): readonly RouterTurnEntry[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: called inside a React component under QueryClientProvider.
 * Postcondition: returns stable send, retryUnsent, and retryCommand callbacks backed by ROUTER_COMMAND_MUTATION_KEY, plus referentially stable pendingTurns and server retry state.
 */
export function useRouterCommands(_liveTurns: readonly RouterTurnEntry[], _selfId: string | undefined): RouterCommandsState {
  throw new Error("Not implemented");
}

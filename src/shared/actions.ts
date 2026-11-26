import type { ActionId, MessageId, SessionId, WorkerId } from "./domain.ts";

export const ACTION_TYPES = ["session.start", "session.send", "session.end", "worktree.create", "review.verify"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_STATUSES = ["pending", "running", "done", "failed", "abandoned"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export interface SessionStartParams {
  sessionId: SessionId;
  generation: number;
}

export interface SessionSendParams {
  sessionId: SessionId;
  messageId: MessageId;
  source: "user" | "system";
  resend?: boolean;
  recovery?: boolean;
  rider?: true;
}

export interface SessionEndParams {
  sessionId: SessionId;
  generation: number;
}

export interface WorktreeCreateParams {
  workerId: WorkerId;
}

export interface ReviewVerifyParams {
  workerId: WorkerId;
  turnMessageId: MessageId;
  reportMessageId: MessageId;
}

interface ActionParamsMap {
  "session.start": SessionStartParams;
  "session.send": SessionSendParams;
  "session.end": SessionEndParams;
  "worktree.create": WorktreeCreateParams;
  "review.verify": ReviewVerifyParams;
}

export interface ActionRow<T extends ActionType = ActionType> {
  id: ActionId;
  type: T;
  dedupeKey: string;
  params: ActionParamsMap[T];
  status: ActionStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type AnyActionRow = { [T in ActionType]: ActionRow<T> }[ActionType];

export type NewAction = {
  [T in ActionType]: { type: T; params: ActionParamsMap[T] };
}[ActionType];

export function actionDedupeKey(action: NewAction): string {
  switch (action.type) {
    case "session.start":
      return `${action.params.sessionId}:${action.params.generation}`;
    case "session.send":
      return `${action.params.sessionId}:${action.params.messageId}`;
    case "session.end":
      return `${action.params.sessionId}:${action.params.generation}`;
    case "worktree.create":
      return String(action.params.workerId);
    case "review.verify":
      return `${action.params.workerId}:${action.params.reportMessageId}`;
  }
}

export type ActionResult = { kind: "done" } | { kind: "later"; delayMs: number; reason?: string };

export type ActionHandler<T extends ActionType = ActionType> = (action: ActionRow<T>) => Promise<ActionResult> | ActionResult;

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}

export const ACTION_RETRY: Record<ActionType, RetryPolicy> = {
  "session.start": { baseMs: 5_000, maxMs: 300_000, maxAttempts: 3 },
  "session.send": { baseMs: 5_000, maxMs: 300_000, maxAttempts: 3 },
  "session.end": { baseMs: 5_000, maxMs: 300_000, maxAttempts: 3 },
  "worktree.create": { baseMs: 5_000, maxMs: 300_000, maxAttempts: 3 },
  "review.verify": { baseMs: 5_000, maxMs: 300_000, maxAttempts: 3 },
};

export function retryDelayMs(policy: RetryPolicy, attempt: number): number {
  return Math.min(policy.baseMs * 2 ** (attempt - 1), policy.maxMs);
}

export interface ActionExecutor {
  register<T extends ActionType>(type: T, handler: ActionHandler<T>): void;
  start(): void;
  wake(): void;
  stop(): Promise<void>;
}

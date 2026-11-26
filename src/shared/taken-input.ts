import { systemEventOf, workerEventOf, type Message, type MessageId } from "./domain.ts";

export interface TakenInput {
  afterId: MessageId;
  midTurn: boolean;
  at: number;
}

export function isVisibleSystemInput(message: Pick<Message, "sender" | "kind" | "meta" | "status">): boolean {
  if (message.sender !== "system") return false;
  const event = systemEventOf(message)?.event;
  if (event === "pm.wakeup" || event === "schedule.run") return true;
  if (message.status === null) return false;
  const worker = workerEventOf(message)?.event;
  return worker === "report" || worker === "turn_failed" || worker === "worktree_failed";
}

export function takenInputOf(message: Pick<Message, "sender" | "meta">): TakenInput | null {
  const taken = message.meta?.taken;
  if (message.sender !== "system" || taken === null || typeof taken !== "object") return null;
  if (!("afterId" in taken) || typeof taken.afterId !== "number" || !Number.isSafeInteger(taken.afterId) || taken.afterId < 0) return null;
  if (!("midTurn" in taken) || typeof taken.midTurn !== "boolean") return null;
  if (!("at" in taken) || typeof taken.at !== "number" || !Number.isFinite(taken.at)) return null;
  return { afterId: taken.afterId, midTurn: taken.midTurn, at: taken.at };
}

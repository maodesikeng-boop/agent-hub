import { LRUCache } from "lru-cache";
import { createStore, useStore } from "zustand";
import type { MessageId, PendingDecision, TaskGraphId, TaskNodeKey } from "../shared/index.ts";
import { DECISION_DRAFTS_MAX } from "./limits.ts";

interface DecisionDraftsState {
  drafts: Readonly<Record<string, string>>;
}

const cache = new LRUCache<string, string>({ max: DECISION_DRAFTS_MAX });
const store = createStore<DecisionDraftsState>(() => ({ drafts: {} }));

function snapshotCache(): Readonly<Record<string, string>> {
  const next: Record<string, string> = {};
  for (const [key, value] of cache.entries()) {
    next[key] = value;
  }
  return next;
}

export function draftDeviceOf(device: string | null | undefined): string {
  return device === null || device === undefined || device === "" ? "local" : device;
}

export function askDecisionDraftKey(device: string | null | undefined, messageId: MessageId): string {
  return `ask:${draftDeviceOf(device)}:${messageId}`;
}

export function gateDecisionDraftKey(
  device: string | null | undefined,
  graphId: TaskGraphId,
  nodeKey: TaskNodeKey,
  askMessageId: MessageId | null,
): string {
  if (askMessageId !== null) return askDecisionDraftKey(device, askMessageId);
  return `gate:${draftDeviceOf(device)}:${graphId}:${nodeKey}`;
}

export function routerDecisionDraftKey(
  deviceId: string,
  decision: Pick<PendingDecision, "key" | "askMessageId" | "source">,
): string {
  if (decision.askMessageId !== null) return askDecisionDraftKey(deviceId, decision.askMessageId);
  if (decision.source.kind === "gate") {
    return `gate:${draftDeviceOf(deviceId)}:${decision.source.graphId}:${decision.source.nodeKey}`;
  }
  return decision.key;
}

export function getDecisionDraft(key: string): string {
  return cache.get(key) ?? "";
}

export function setDecisionDraft(key: string, value: string): void {
  const prev = cache.peek(key);
  if (value === "") {
    if (prev === undefined) return;
    cache.delete(key);
  } else {
    if (prev === value) return;
    cache.set(key, value);
  }
  store.setState({ drafts: snapshotCache() });
}

export function clearDecisionDraft(key: string): void {
  setDecisionDraft(key, "");
}

export function useDecisionDraft(key: string): string {
  return useStore(store, (state) => state.drafts[key] ?? "");
}

export function resetDecisionDrafts(): void {
  if (cache.size === 0) return;
  cache.clear();
  store.setState({ drafts: {} });
}

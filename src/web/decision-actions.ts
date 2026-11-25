import type {
  DecideTaskNodeRequest,
  DecideTaskNodeResponse,
  PendingDecision,
  ResolveRouterItemRequest,
  ResolveRouterItemResponse,
  RouterItemId,
  TaskGraphId,
  TaskNodeKey,
} from "../shared/index.ts";
import { newClientId } from "./format.ts";

const RECOMMENDED_PREFIX = /^(?:\(\s*(?:recommended|推荐)\s*\)|（\s*推荐\s*）)\s*/i;

export interface DecisionSubmitClient {
  postResolveRouterItem(id: RouterItemId, body: ResolveRouterItemRequest): Promise<ResolveRouterItemResponse>;
  postTaskGraphDecide(graphId: TaskGraphId, nodeKey: TaskNodeKey, body: DecideTaskNodeRequest): Promise<DecideTaskNodeResponse>;
}

export interface DecisionSubmissionInput {
  optionIndex: number | null;
  note: string;
  clientId?: string;
}

export function cleanOptionLabel(raw: string): string {
  return raw.replace(RECOMMENDED_PREFIX, "");
}

export function recommendedIndexOf(decision: Pick<PendingDecision, "options" | "source">): number | null {
  const rec = decision.source.recommended ?? null;
  if (rec !== null) {
    const exact = decision.options.indexOf(rec);
    if (exact >= 0) return exact;
  }
  const prefixed = decision.options.findIndex((opt) => RECOMMENDED_PREFIX.test(opt));
  return prefixed >= 0 ? prefixed : null;
}

export async function submitDecision(
  client: DecisionSubmitClient,
  decision: PendingDecision,
  input: DecisionSubmissionInput,
): Promise<void> {
  const trimmedNote = input.note.trim();
  const { optionIndex } = input;
  if (optionIndex === null && trimmedNote.length === 0) {
    throw new Error("Pick an option or write a reply");
  }
  if (optionIndex !== null && (optionIndex < 0 || optionIndex >= decision.options.length)) {
    throw new Error("Unknown option");
  }
  const clientId = input.clientId ?? newClientId();

  if (decision.source.kind === "router_item") {
    await client.postResolveRouterItem(decision.source.itemId, {
      clientId,
      optionIndex,
      ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
    });
    return;
  }

  const choice = optionIndex === null ? null : (decision.options[optionIndex] ?? null);
  await client.postTaskGraphDecide(decision.source.graphId, decision.source.nodeKey, {
    clientId,
    ...(decision.askMessageId !== null ? { askMessageId: decision.askMessageId } : {}),
    choice,
    ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
  });
}

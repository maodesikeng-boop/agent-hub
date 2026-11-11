// 同源拍板提交动作（docs/router-design.md 第 4.2 节、docs/ui-standard.md 第 21 条）：
// Router 拍板卡与后续右栏门禁节点共用同一份提交流程，支持“一键点选秒定 / 点选+补充备注 / 纯文字回车答复”三合一提交。
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
  postDecideTaskNode(graphId: TaskGraphId, nodeKey: TaskNodeKey, body: DecideTaskNodeRequest): Promise<DecideTaskNodeResponse>;
}

export interface DecisionSubmissionInput {
  optionIndex: number | null;
  note: string;
  clientId?: string;
}

/** 剥离选项开头的 `(Recommended)` / `（推荐）` 标记，配合卡片右侧统一的 Recommended 标签展示。 */
export function cleanOptionLabel(raw: string): string {
  return raw.replace(RECOMMENDED_PREFIX, "");
}

/** 找出推荐项下标：gate 优先认 `source.recommended`，独立待决项认 `(Recommended)` / `（推荐）` 前缀。 */
export function recommendedIndexOf(decision: Pick<PendingDecision, "options" | "source">): number | null {
  if (decision.source.kind === "gate" && decision.source.recommended !== null) {
    const exact = decision.options.indexOf(decision.source.recommended);
    if (exact >= 0) return exact;
  }
  const prefixed = decision.options.findIndex((opt) => RECOMMENDED_PREFIX.test(opt));
  return prefixed >= 0 ? prefixed : null;
}

/**
 * 提交一条待决拍板（router_item 走 `/api/router/items/:id/resolve`，gate 走 `/api/task-graphs/:id/nodes/:nodeKey/decide`）。
 */
export async function submitDecision(
  client: DecisionSubmitClient,
  decision: PendingDecision,
  input: DecisionSubmissionInput,
): Promise<void> {
  const trimmedNote = input.note.trim();
  const { optionIndex } = input;
  if (optionIndex === null && trimmedNote.length === 0) {
    throw new Error("请至少选择一个方案或输入自定义答复");
  }
  if (optionIndex !== null && (optionIndex < 0 || optionIndex >= decision.options.length)) {
    throw new Error("所选方案无效");
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
  await client.postDecideTaskNode(decision.source.graphId, decision.source.nodeKey, {
    clientId,
    choice,
    ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
  });
}

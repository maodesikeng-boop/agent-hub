import { taskNodeStatusText } from "../../../shared/domain.ts";
import type { TaskEdge, TaskNodeKey } from "../../../shared/domain.ts";
import type {
  CreateTaskGraphNodeInput,
  HubArgs,
  HubResult,
  PatchTaskGraphNodeInput,
  PatchTaskGraphSpecInput,
} from "../../../shared/hub.ts";
import type { HubCallContext } from "../../../shared/ledger.ts";
import { MAX_GRAPH_SPEC_BYTES } from "../../../shared/limits.ts";
import type { AgentVendor } from "../../../shared/vendors.ts";
import type { WorkerCapabilities } from "../../../shared/pm-capabilities.ts";
import { writeWorkerCapabilities } from "../capability-rows.ts";
import { fail, type Pending } from "../context.ts";
import { syncDeliveryNoteAfterProgressIn } from "./delivery.ts";
import { recomputeGraphProgressIn } from "./progress.ts";
import { artifactWithoutCheckpoint, hasText, parseJsonOr, toTaskNode, workerIdsOf } from "./rows.ts";
import {
  assertReviewStepsHaveTarget,
  edgeSig,
  gateOptionsJsonOf,
  normalizeNewStep,
  parseSpecJson,
  patchSpecSchema,
  validateDagAndOrder,
  validateGateFields,
  validateGraphGoal,
  validateGraphTitle,
  validateNodeKey,
  validateNodeTitle,
  validateStepAgentSetting,
  validateStepBase,
  validateStepBrief,
  validateStepCapabilities,
  validateStepMaxTime,
  type GateFields,
  type NewStep,
} from "./spec.ts";
import { getGraphRow, insertEdgeRow, insertStepRow, isUserBlocked, listStepRows, publishGraphIn, resolveGraphForPm } from "./store.ts";
import { formatGraphText, unlockedNoteOf } from "./text.ts";
import type { PmCaller, TaskEdgeDbRow, TaskGraphCtx, TaskGraphDbRow, TaskNodeDbRow } from "./types.ts";
import { sameVendorReviewHint } from "./workspace.ts";

interface PatchLists {
  add: CreateTaskGraphNodeInput[];
  addSequential: boolean;
  update: PatchTaskGraphNodeInput[];
  remove: TaskNodeKey[];
  skip: TaskNodeKey[];
}

interface PreparedUpdate {
  cur: TaskNodeDbRow;
  nextTitle: string;
  nextBrief: string | null;
  agent: { vendor: AgentVendor | null; model: string | null; effort: string | null };
  nextMaxTimeMs: number | null;
  nextBase: string | null;
  nextReadonly: number;
  nextCapabilities: WorkerCapabilities | null;
  nextConfirm: number;
  nextReview: number;
  gate: GateFields | null;
}

const isLocked = (n: TaskNodeDbRow): boolean => n.status === "running" || n.status === "done" || n.active_worker_id !== null;
const statusOf = (n: TaskNodeDbRow): string => taskNodeStatusText(toTaskNode(n), "pm");

function parsePatchSpec(raw: unknown): { patch: PatchTaskGraphSpecInput; lists: PatchLists } {
  const patch = parseSpecJson<PatchTaskGraphSpecInput>(raw, patchSpecSchema, {
    empty: `patch JSON 不能为空，且不超过 ${MAX_GRAPH_SPEC_BYTES} 字节`,
    badJson: "patch 内容不是合法的 JSON",
    badShape: "patch 字段格式不正确",
  });
  for (const [a, b] of [["addSteps", "addNodes"], ["updateSteps", "updateNodes"], ["removeSteps", "removeNodes"], ["skipSteps", "skipNodes"]] as const) {
    if (patch[a] !== undefined && patch[b] !== undefined) throw fail("invalid", `patch 中 ${a} 和 ${b} 只能传其中一个`);
  }
  return {
    patch,
    lists: {
      add: patch.addSteps ?? patch.addNodes ?? [],
      addSequential: patch.addSteps !== undefined && patch.addEdges === undefined,
      update: patch.updateSteps ?? patch.updateNodes ?? [],
      remove: patch.removeSteps ?? patch.removeNodes ?? [],
      skip: patch.skipSteps ?? patch.skipNodes ?? [],
    },
  };
}

function takeRemovals(nodesByKey: Map<TaskNodeKey, TaskNodeDbRow>, rawRemove: readonly TaskNodeKey[]): Set<TaskNodeKey> {
  const removeKeySet = new Set<TaskNodeKey>(rawRemove.map(validateNodeKey));
  for (const rmKey of removeKeySet) {
    const target = nodesByKey.get(rmKey);
    if (target === undefined) throw fail("not_found", `要删除的节点「${rmKey}」不存在`);
    if (isLocked(target)) throw fail("conflict", `节点「${rmKey}」${statusOf(target)}，不允许通过 patch 删除（历史与在跑节点受保护）`);
    nodesByKey.delete(rmKey);
  }
  return removeKeySet;
}

function normalizeAdded(g: TaskGraphCtx, lists: PatchLists, nodesByKey: ReadonlyMap<TaskNodeKey, TaskNodeDbRow>, vendor: AgentVendor): NewStep[] {
  const added = lists.add.map((n, index) => {
    const key = validateNodeKey(n.key);
    if (nodesByKey.has(key)) throw fail("conflict", `节点「${key}」已存在`);
    return normalizeNewStep(n, index, lists.add, lists.addSequential, vendor, g.modelCatalog);
  });
  const seen = new Set<TaskNodeKey>();
  for (const a of added) {
    if (seen.has(a.key)) throw fail("invalid", `新增步骤中重复出现了「${a.key}」`);
    seen.add(a.key);
  }
  return added;
}

function patchedEdges(
  existingEdges: readonly TaskEdgeDbRow[],
  removeKeySet: ReadonlySet<TaskNodeKey>,
  patch: PatchTaskGraphSpecInput,
  added: readonly NewStep[],
  updates: readonly PatchTaskGraphNodeInput[],
  nodesByKey: ReadonlyMap<TaskNodeKey, TaskNodeDbRow>,
): TaskEdge[] {
  const edgeSet = new Map<string, TaskEdge>();
  const put = (fromKey: TaskNodeKey, toKey: TaskNodeKey) => edgeSet.set(edgeSig(fromKey, toKey), { fromKey, toKey });
  for (const e of existingEdges) {
    if (!removeKeySet.has(e.from_key) && !removeKeySet.has(e.to_key)) put(e.from_key, e.to_key);
  }
  for (const rm of patch.removeEdges ?? []) {
    const fk = validateNodeKey(rm.from);
    const tk = validateNodeKey(rm.to);
    const target = nodesByKey.get(tk);
    if (target !== undefined && isLocked(target)) throw fail("conflict", `节点「${tk}」${statusOf(target)}，不能移除其前置依赖`);
    edgeSet.delete(edgeSig(fk, tk));
  }
  for (const a of added) for (const dep of a.deps) put(dep, a.key);
  for (const u of updates) {
    const uk = validateNodeKey(u.key);
    const target = nodesByKey.get(uk);
    if (target === undefined) throw fail("not_found", `要更新的节点「${uk}」不存在`);
    if (isLocked(target)) throw fail("conflict", `步骤「${uk}」${statusOf(target)}，已开工或已完成的步骤不允许通过 patch 修改`);
    if (u.deps === undefined) continue;
    for (const [sig, edge] of [...edgeSet.entries()]) if (edge.toKey === uk) edgeSet.delete(sig);
    for (const dep of u.deps.map(validateNodeKey)) put(dep, uk);
  }
  for (const ae of patch.addEdges ?? []) {
    const fk = validateNodeKey(ae.from);
    const tk = validateNodeKey(ae.to);
    const target = nodesByKey.get(tk);
    if (target !== undefined && (target.status === "running" || target.status === "done")) {
      throw fail("conflict", `节点「${tk}」${statusOf(target)}，不能向其追加前置依赖`);
    }
    put(fk, tk);
  }
  return [...edgeSet.values()];
}

function prepareUpdate(g: TaskGraphCtx, u: PatchTaskGraphNodeInput, cur: TaskNodeDbRow, vendor: AgentVendor): PreparedUpdate {
  const nextTitle = u.title !== undefined ? validateNodeTitle(u.title) : cur.title;
  const nextBrief = u.brief !== undefined ? validateStepBrief(u.brief) : cur.brief;
  const vendorChanged = u.vendor !== undefined && (u.vendor?.trim() || null) !== cur.vendor;
  const agent = validateStepAgentSetting(
    {
      vendor: u.vendor !== undefined ? u.vendor : cur.vendor,
      model: u.model !== undefined ? u.model : vendorChanged ? null : cur.model,
      effort: u.effort !== undefined ? u.effort : vendorChanged ? null : cur.effort,
    },
    vendor,
    g.modelCatalog,
  );
  const nextMaxTimeMs = u.maxTime !== undefined ? validateStepMaxTime(u.maxTime) : cur.max_time_ms;
  const nextReadonly = u.readonly !== undefined ? (u.readonly ? 1 : 0) : cur.readonly;
  const nextCapabilities = u.caps !== undefined || u.allow !== undefined ? validateStepCapabilities(u.caps, u.allow) : null;
  const nextConfirm = u.confirm !== undefined ? (u.confirm ? 1 : 0) : cur.confirm;
  const nextReview = u.review !== undefined ? (u.review ? 1 : 0) : cur.review;
  const nextBase = validateStepBase(u.base !== undefined ? u.base : cur.base, nextReview === 1);
  const gateTouched = u.question !== undefined || u.options !== undefined || u.summaryMd !== undefined || u.recommended !== undefined;
  const gate = gateTouched
    ? validateGateFields({
        question: u.question ?? cur.gate_question ?? undefined,
        options: u.options ?? parseJsonOr<string[] | undefined>(cur.gate_options_json, undefined),
        summaryMd: u.summaryMd ?? cur.gate_summary_md ?? undefined,
        recommended: u.recommended ?? cur.gate_recommended ?? undefined,
      })
    : null;
  return { cur, nextTitle, nextBrief, agent, nextMaxTimeMs, nextBase, nextReadonly, nextCapabilities, nextConfirm, nextReview, gate };
}

function writeUpdateIn(g: TaskGraphCtx, p: Pending, u: PreparedUpdate, t: number): void {
  const { cur, gate } = u;
  const hasGateQuestion = hasText(gate?.question);
  const reevaluate =
    cur.status === "waiting" &&
    cur.active_worker_id === null &&
    (hasGateQuestion || (workerIdsOf(cur).length === 0 && (gate !== null || hasText(u.nextBrief))));
  const clearsAskWait = gate !== null && cur.waiting_for === "user" && !isUserBlocked(g.db, cur.id);
  if (gate !== null && cur.gate_ask_message_id !== null) g.messages.settleAskIn(p, cur.gate_ask_message_id, { by: "close" });
  const gateSql = gate === null ? "" : `gate_question = ?, gate_options_json = ?, gate_summary_md = ?,
    gate_recommended = ?, gate_ask_message_id = NULL, artifact_json = ?, ${hasGateQuestion ? "decision_json = NULL," : ""}`;
  const gateParams = gate !== null ? [gate.question, gateOptionsJsonOf(gate), gate.summaryMd, gate.recommended, artifactWithoutCheckpoint(cur)] : [];
  g.db.run(
    `UPDATE task_graph_steps
        SET title = ?, brief = ?, vendor = ?, model = ?, effort = ?, readonly = ?, max_time_ms = ?,
            confirm = ?, review = ?, base = ?, ${gateSql}
            status = CASE WHEN ? THEN 'pending' ELSE status END,
            waiting_for = CASE WHEN ? THEN NULL WHEN ? AND waiting_for = 'user' THEN 'pm' ELSE waiting_for END,
            updated_at = ?
      WHERE id = ?`,
    u.nextTitle,
    u.nextBrief,
    u.agent.vendor,
    u.agent.model,
    u.agent.effort,
    u.nextReadonly,
    u.nextMaxTimeMs,
    u.nextConfirm,
    u.nextReview,
    u.nextBase,
    ...gateParams,
    Number(reevaluate),
    Number(reevaluate),
    Number(clearsAskWait),
    t,
    cur.id,
  );
  if (u.nextCapabilities !== null) writeWorkerCapabilities(g.db, { table: "task_graph_step_capabilities", stepId: cur.id }, u.nextCapabilities);
}

function applySkips(g: TaskGraphCtx, rawSkip: readonly TaskNodeKey[], nodesByKey: ReadonlyMap<TaskNodeKey, TaskNodeDbRow>, t: number): void {
  for (const skRaw of rawSkip) {
    const sk = validateNodeKey(skRaw);
    const cur = nodesByKey.get(sk);
    if (cur === undefined) throw fail("not_found", `要跳过的节点「${sk}」不存在`);
    if (isLocked(cur)) throw fail("conflict", `节点「${sk}」${statusOf(cur)}，无法跳过`);
    g.db.run("UPDATE task_graph_steps SET status = 'done', waiting_for = NULL, skipped = 1, updated_at = ? WHERE id = ?", t, cur.id);
  }
}

interface PatchPlan {
  graphRow: TaskGraphDbRow;
  patch: PatchTaskGraphSpecInput;
  lists: PatchLists;
  existingNodes: TaskNodeDbRow[];
  nodesByKey: Map<TaskNodeKey, TaskNodeDbRow>;
  removeKeySet: Set<TaskNodeKey>;
  added: NewStep[];
  updates: PreparedUpdate[];
  finalEdges: TaskEdge[];
  rankOf: Map<TaskNodeKey, number>;
  nextGoal: string | null | undefined;
}

function planPatch(g: TaskGraphCtx, caller: PmCaller, args: HubArgs<"graph.patch">): PatchPlan {
  const { patch, lists } = parsePatchSpec(args.specJson);
  const graphRow = resolveGraphForPm(g.db, caller.pmId, { graphId: args.graphId, requireActive: true });
  const existingNodes = listStepRows(g.db, graphRow.id);
  const existingEdges = g.db.all<TaskEdgeDbRow>("SELECT * FROM task_graph_edges WHERE graph_id = ?", graphRow.id);
  const nodesByKey = new Map<TaskNodeKey, TaskNodeDbRow>(existingNodes.map((n) => [n.node_key, n]));
  const removeKeySet = takeRemovals(nodesByKey, lists.remove);
  const vendor = caller.vendor as AgentVendor;
  const added = normalizeAdded(g, lists, nodesByKey, vendor);
  const finalEdges = patchedEdges(existingEdges, removeKeySet, patch, added, lists.update, nodesByKey);
  const topoOrder = validateDagAndOrder([...nodesByKey.keys(), ...added.map((a) => a.key)], finalEdges);
  const rankOf = new Map<TaskNodeKey, number>(topoOrder.map((k, idx) => [k, idx]));
  const nextGoal = patch.goal !== undefined ? validateGraphGoal(patch.goal) : undefined;
  const updates = lists.update.map((u) => prepareUpdate(g, u, nodesByKey.get(validateNodeKey(u.key))!, vendor));
  const updatedByKey = new Map(updates.map((u) => [u.cur.node_key, u]));
  assertReviewStepsHaveTarget(
    [
      ...[...nodesByKey.values()].map((n) => {
        const u = updatedByKey.get(n.node_key);
        return { key: n.node_key, review: u?.nextReview ?? n.review, base: u !== undefined ? u.nextBase : n.base, status: n.status };
      }),
      ...added.map((a) => ({ ...a, status: "pending" })),
    ],
    finalEdges,
  );
  return { graphRow, patch, lists, existingNodes, nodesByKey, removeKeySet, added, updates, finalEdges, rankOf, nextGoal };
}

function applyPatchIn(g: TaskGraphCtx, p: Pending, plan: PatchPlan): void {
  const { graphRow, patch } = plan;
  const t = g.now();
  if (patch.title !== undefined) {
    g.db.run("UPDATE task_graphs SET title = ?, updated_at = ? WHERE id = ?", validateGraphTitle(patch.title), t, graphRow.id);
  }
  if (plan.nextGoal !== undefined) g.db.run("UPDATE task_graphs SET goal = ?, updated_at = ? WHERE id = ?", plan.nextGoal, t, graphRow.id);
  for (const rmKey of plan.removeKeySet) {
    g.db.run("DELETE FROM task_graph_steps WHERE graph_id = ? AND node_key = ?", graphRow.id, rmKey);
  }
  for (const a of plan.added) insertStepRow(g.db, graphRow.id, a, plan.rankOf.get(a.key) ?? 0, t);
  for (const u of plan.updates) writeUpdateIn(g, p, u, t);
  applySkips(g, plan.lists.skip, plan.nodesByKey, t);
  for (const [k, idx] of plan.rankOf) {
    g.db.run("UPDATE task_graph_steps SET sort_order = ? WHERE graph_id = ? AND node_key = ?", idx, graphRow.id, k);
  }
  g.db.run("DELETE FROM task_graph_edges WHERE graph_id = ?", graphRow.id);
  for (const e of plan.finalEdges) insertEdgeRow(g.db, graphRow.id, e);
}

export function patchIn(
  g: TaskGraphCtx,
  p: Pending,
  caller: PmCaller,
  args: HubArgs<"graph.patch">,
  context?: HubCallContext,
): HubResult<"graph.patch"> {
  g.persona.assertPmNotArchived(caller.pmId);
  const plan = planPatch(g, caller, args);
  const { graphRow, existingNodes } = plan;
  const wasAllSettled = existingNodes.length > 0 && existingNodes.every((n) => n.status === "done");
  applyPatchIn(g, p, plan);
  const refreshedRow = getGraphRow(g.db, graphRow.id)!;
  const progress = recomputeGraphProgressIn(g, p, refreshedRow, caller, context);
  syncDeliveryNoteAfterProgressIn(g, p, refreshedRow, wasAllSettled);
  const graph = publishGraphIn(g, p, graphRow.id);
  const progressNote = unlockedNoteOf(progress, graph).replace(/^；/u, "");
  const reviewHint = sameVendorReviewHint(g.db, graphRow.id, caller.vendor);
  return {
    text: `已更新${formatGraphText(graph, true, { ...g, pmVendor: caller.vendor })}${progressNote !== "" ? `\n${progressNote}` : ""}${reviewHint}`,
    data: { graph },
  };
}

import type { TaskEdge, TaskNodeKey } from "../../../shared/domain.ts";
import type { CreateTaskGraphNodeInput, CreateTaskGraphSpecInput, HubArgs, HubResult } from "../../../shared/hub.ts";
import type { HubCallContext } from "../../../shared/ledger.ts";
import { MAX_ACTIVE_GRAPHS_PER_PROJECT, MAX_GRAPH_SPEC_BYTES } from "../../../shared/limits.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import type { AgentVendor } from "../../../shared/vendors.ts";
import { fail, type Pending } from "../context.ts";
import { recomputeGraphProgressIn } from "./progress.ts";
import {
  assertReviewStepsHaveTarget,
  createSpecSchema,
  edgeSig,
  normalizeNewStep,
  parseSpecJson,
  validateDagAndOrder,
  validateGraphGoal,
  validateGraphTitle,
  validateNodeKey,
  type NewStep,
} from "./spec.ts";
import { insertEdgeRow, insertStepRow, publishGraphIn } from "./store.ts";
import { formatGraphText, unlockedNoteOf } from "./text.ts";
import type { PmCaller, TaskGraphCtx, TaskGraphDbRow } from "./types.ts";
import { sameVendorReviewHint } from "./workspace.ts";

function parseCreateSpec(raw: unknown): { spec: CreateTaskGraphSpecInput; list: CreateTaskGraphNodeInput[]; sequential: boolean } {
  const spec = parseSpecJson<CreateTaskGraphSpecInput>(raw, createSpecSchema, {
    empty: `任务图规格 JSON 不能为空，且不超过 ${MAX_GRAPH_SPEC_BYTES} 字节`,
    badJson: "任务图规格不是合法的 JSON",
    badShape: "任务图规格字段格式不正确",
  });
  if (spec.steps !== undefined && spec.nodes !== undefined) throw fail("invalid", "任务图规格中 steps 和 nodes 只能传其中一个");
  const list = spec.steps ?? spec.nodes;
  if (list === undefined) throw fail("invalid", "任务图规格缺少 steps");
  return { spec, list, sequential: spec.steps !== undefined };
}

function assertActiveGraphQuota(g: TaskGraphCtx, projectId: number): void {
  const activeCount = g.db.get<{ n: number }>(
    "SELECT count(*) AS n FROM task_graphs WHERE project_id = ? AND status = 'active'",
    projectId,
  )!.n;
  if (activeCount >= MAX_ACTIVE_GRAPHS_PER_PROJECT) {
    throw fail(
      "conflict",
      `当前项目已有 ${MAX_ACTIVE_GRAPHS_PER_PROJECT} 张活跃任务图，请先完结或用 ${HUB_COMMAND} graph cancel 取消不再需要的图`,
    );
  }
}

function edgesOf(steps: readonly NewStep[], extra: CreateTaskGraphSpecInput["edges"]): TaskEdge[] {
  const edges: TaskEdge[] = [];
  for (const n of steps) for (const dep of n.deps) edges.push({ fromKey: dep, toKey: n.key });
  for (const e of extra ?? []) edges.push({ fromKey: validateNodeKey(e.from), toKey: validateNodeKey(e.to) });
  return edges;
}

function insertGraphIn(
  g: TaskGraphCtx,
  caller: PmCaller,
  input: { projectId: number; conversationId: number; title: string; goal: string | null; originMsgId: number | null },
  steps: readonly NewStep[],
  edges: readonly TaskEdge[],
  rankOf: ReadonlyMap<TaskNodeKey, number>,
): TaskGraphDbRow {
  const t = g.now();
  const graphRow = g.db.get<TaskGraphDbRow>(
    `INSERT INTO task_graphs (
       project_id, pm_id, conversation_id, title, goal, status, origin_msg_id, created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL) RETURNING *`,
    input.projectId,
    caller.pmId,
    input.conversationId,
    input.title,
    input.goal,
    input.originMsgId,
    t,
    t,
  )!;
  steps.forEach((n, index) => insertStepRow(g.db, graphRow.id, n, rankOf.get(n.key) ?? index, t));
  const inserted = new Set<string>();
  for (const e of edges) {
    const sig = edgeSig(e.fromKey, e.toKey);
    if (inserted.has(sig)) continue;
    inserted.add(sig);
    insertEdgeRow(g.db, graphRow.id, e);
  }
  return graphRow;
}

export function createIn(
  g: TaskGraphCtx,
  p: Pending,
  caller: PmCaller,
  rawArgs: HubArgs<"graph.create">,
  context?: HubCallContext,
): HubResult<"graph.create"> {
  g.persona.assertPmNotArchived(caller.pmId);
  const project = g.projects.activeProjectOf(caller.pmId);
  if (project === null) throw fail("invalid", `你还没有项目，先用 ${HUB_COMMAND} project create --folder <主文件夹> 建一个`);
  const { spec, list, sequential } = parseCreateSpec(rawArgs.specJson);
  const title = validateGraphTitle(rawArgs.title ?? spec.title ?? "");
  const goal = validateGraphGoal(spec.goal);
  assertActiveGraphQuota(g, project.id);
  const steps = list.map((n, index) => normalizeNewStep(n, index, list, sequential, caller.vendor as AgentVendor, g.modelCatalog));
  const edges = edgesOf(steps, spec.edges);
  const topoOrder = validateDagAndOrder(
    steps.map((n) => n.key),
    edges,
  );
  assertReviewStepsHaveTarget(
    steps.map((n) => ({ ...n, status: "pending" })),
    edges,
  );
  const rankOf = new Map<TaskNodeKey, number>(topoOrder.map((k, idx) => [k, idx]));
  const conversationId = caller.conversationId ?? g.persona.privateConversation(caller.pmId)?.id ?? project.conversation_id;
  const graphRow = insertGraphIn(
    g,
    caller,
    { projectId: project.id, conversationId, title, goal, originMsgId: spec.originMsgId ?? null },
    steps,
    edges,
    rankOf,
  );
  const progress = recomputeGraphProgressIn(g, p, graphRow, caller, context);
  const graph = publishGraphIn(g, p, graphRow.id, "task_graph.created");
  const progressNote = unlockedNoteOf(progress, graph).replace(/^；/u, "");
  const reviewHint = sameVendorReviewHint(g.db, graphRow.id, caller.vendor);
  return {
    text: `已创建${formatGraphText(graph)}${progressNote !== "" ? `\n${progressNote}` : ""}${reviewHint}`,
    data: { graph },
  };
}

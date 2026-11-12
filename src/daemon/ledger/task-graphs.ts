// 持久化任务流图（Task DAG）账本模块：Kahn O(V+E) 拓扑校验、同源门禁（gateRef）、Worker 绑定接力与实时交接摘要。
import { z } from "zod";
import type {
  CancelTaskGraphRequest,
  CancelTaskGraphResponse,
  DecideTaskNodeRequest,
  DecideTaskNodeResponse,
  SkipTaskNodeRequest,
  SkipTaskNodeResponse,
  TaskGraphsPage,
} from "../../shared/api.ts";
import {
  isTaskGraphReadyToFinish,
  isTaskNodeWaitingPm,
  isTaskNodeWaitingUser,
  systemMessageDedupeKey,
  taskNodeStatusText,
  truncateChars,
  userMessageDedupeKey,
  validateAskOptions,
} from "../../shared/domain.ts";
import type {
  AgentSessionRow,
  ConversationId,
  MessageId,
  PmId,
  ProjectId,
  SystemMessageMeta,
  TaskArtifact,
  TaskDecision,
  TaskEdge,
  TaskGraph,
  TaskGraphId,
  TaskGraphStatus,
  TaskNode,
  TaskNodeKey,
  TaskNodeStatus,
  TaskNodeWaitingFor,
  WorkerId,
} from "../../shared/domain.ts";
import type {
  CreateTaskGraphSpecInput,
  HubArgs,
  HubResult,
  PatchTaskGraphSpecInput,
  PmActiveGraphSummary,
  WorkerPr,
} from "../../shared/hub.ts";
import type { GraphPrTarget, HubCallContext } from "../../shared/ledger.ts";
import {
  COMPLETED_GRAPH_RETENTION_MS,
  DELIVERY_FILES_MAX,
  DELIVERY_NOTE_MAX_CHARS,
  GRAPH_HISTORY_PAGE_SIZE,
  GRAPH_TEXT_NODE_NOTE_CHARS,
  GRAPH_TEXT_NODE_WORKERS_MAX,
  HANDOVER_GRAPHS_MAX_CHARS,
  HUB_GRAPH_LIST_LIMIT,
  MAX_ACTIVE_GRAPHS_PER_PROJECT,
  MAX_DECISION_CHOICE_CHARS,
  MAX_DECISION_NOTE_CHARS,
  MAX_GATE_OPTIONS,
  MAX_GATE_QUESTION_CHARS,
  MAX_GATE_SUMMARY_CHARS,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NODES,
  MAX_GRAPH_SPEC_BYTES,
  MAX_GRAPH_TITLE_CHARS,
  MAX_NODE_ARTIFACT_SUMMARY_CHARS,
  MAX_NODE_KEY_CHARS,
  MAX_NODE_TITLE_CHARS,
  ROUTER_REPORT_LINKS_MAX,
  ROUTER_REPORT_LINK_LABEL_MAX_CHARS,
  ROUTER_REPORT_LINK_TARGET_MAX_CHARS,
} from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import type { RouterReportLink } from "../../shared/router.ts";
import { parseWorkerReport } from "../../shared/worker.ts";
import { fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";
import type { LedgerRouter } from "./router.ts";
import { toMessage, type MessageDbRow } from "./rows.ts";
import type { LedgerSessions } from "./sessions.ts";

interface TaskGraphDbRow {
  id: number;
  project_id: number;
  pm_id: number;
  conversation_id: number;
  title: string;
  status: string;
  origin_msg_id: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface TaskNodeDbRow {
  id: number;
  graph_id: number;
  node_key: string;
  title: string;
  status: string;
  waiting_for: string | null;
  skipped: number;
  sort_order: number;
  active_worker_id: number | null;
  worker_ids_json: string;
  artifact_json: string | null;
  gate_question: string | null;
  gate_options_json: string | null;
  gate_summary_md: string | null;
  gate_recommended: string | null;
  gate_ask_message_id: number | null;
  decision_json: string | null;
  created_at: number;
  updated_at: number;
}

interface TaskEdgeDbRow {
  graph_id: number;
  from_key: string;
  to_key: string;
}

const NODE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const charLen = (s: string): number => [...s].length;

function parseJsonOr<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function validateNodeKey(raw: string): TaskNodeKey {
  const key = raw.trim();
  if (key === "" || charLen(key) > MAX_NODE_KEY_CHARS || !NODE_KEY_RE.test(key)) {
    throw fail(
      "invalid",
      `节点标识「${raw}」不合法：需由字母、数字、_、-、. 组成，以字母或数字开头，最多 ${MAX_NODE_KEY_CHARS} 个字符`,
    );
  }
  return key;
}

function validateNodeTitle(raw: string): string {
  const title = raw.trim();
  if (title === "" || /[\r\n]/.test(title) || charLen(title) > MAX_NODE_TITLE_CHARS) {
    throw fail("invalid", `节点标题不能为空或换行，且最多 ${MAX_NODE_TITLE_CHARS} 字`);
  }
  return title;
}

function validateGraphTitle(raw: string): string {
  const title = raw.trim();
  if (title === "" || /[\r\n]/.test(title) || charLen(title) > MAX_GRAPH_TITLE_CHARS) {
    throw fail("invalid", `任务图标题不能为空或换行，且最多 ${MAX_GRAPH_TITLE_CHARS} 字`);
  }
  return title;
}

function validateGateFields(input: {
  question?: string;
  options?: string[];
  summaryMd?: string;
  recommended?: string;
}): {
  question: string | null;
  options: string[];
  summaryMd: string | null;
  recommended: string | null;
} {
  const question = input.question !== undefined ? input.question.trim() : "";
  if (question !== "" && charLen(question) > MAX_GATE_QUESTION_CHARS) {
    throw fail("invalid", `拍板卡的问题最多 ${MAX_GATE_QUESTION_CHARS} 字`);
  }

  let options: string[] = [];
  if (input.options !== undefined && input.options.length > 0) {
    if (input.options.length < 2 || input.options.length > MAX_GATE_OPTIONS) {
      throw fail("invalid", `拍板卡的选项数量需在 2 到 ${MAX_GATE_OPTIONS} 个之间`);
    }
    const checked = validateAskOptions(input.options);
    if (!checked.ok) throw fail("invalid", checked.error);
    options = checked.options;
  }

  const summaryMd = input.summaryMd !== undefined && input.summaryMd.trim() !== "" ? input.summaryMd.trim() : null;
  if (summaryMd !== null && charLen(summaryMd) > MAX_GATE_SUMMARY_CHARS) {
    throw fail("invalid", `拍板卡的背景摘要最多 ${MAX_GATE_SUMMARY_CHARS} 字`);
  }

  const recommended =
    input.recommended !== undefined && input.recommended.trim() !== "" ? input.recommended.trim() : null;
  if (recommended !== null && options.length > 0 && !options.includes(recommended)) {
    throw fail("invalid", `推荐项「${recommended}」必须是拍板卡的选项之一`);
  }

  return {
    question: question === "" ? null : question,
    options,
    summaryMd,
    recommended,
  };
}

/**
 * Kahn O(V+E) 拓扑排序与有向环路径提取。
 * 返回拓扑序数组；若存在有向环则抛出包含具体环路径（如 a -> b -> c -> a）的 invalid 错误。
 */
export function validateDagAndOrder(nodeKeys: readonly TaskNodeKey[], edges: readonly TaskEdge[]): TaskNodeKey[] {
  if (nodeKeys.length === 0) throw fail("invalid", "任务图至少需要 1 个节点");
  if (nodeKeys.length > MAX_GRAPH_NODES) {
    throw fail("invalid", `单张任务图最多 ${MAX_GRAPH_NODES} 个节点（当前 ${nodeKeys.length} 个）`);
  }
  if (edges.length > MAX_GRAPH_EDGES) {
    throw fail("invalid", `单张任务图最多 ${MAX_GRAPH_EDGES} 条依赖边（当前 ${edges.length} 条）`);
  }

  const keySet = new Set<TaskNodeKey>();
  for (const k of nodeKeys) {
    if (keySet.has(k)) throw fail("invalid", `重复的节点标识「${k}」`);
    keySet.add(k);
  }

  const adj = new Map<TaskNodeKey, TaskNodeKey[]>();
  const inDeg = new Map<TaskNodeKey, number>();
  for (const k of nodeKeys) {
    adj.set(k, []);
    inDeg.set(k, 0);
  }

  const edgeSeen = new Set<string>();
  for (const e of edges) {
    if (!keySet.has(e.fromKey)) throw fail("invalid", `依赖边引用了不存在的前置节点「${e.fromKey}」`);
    if (!keySet.has(e.toKey)) throw fail("invalid", `依赖边引用了不存在的目标节点「${e.toKey}」`);
    if (e.fromKey === e.toKey) throw fail("invalid", `节点「${e.fromKey}」不能依赖自己（${e.fromKey} -> ${e.toKey}）`);
    const sig = `${e.fromKey}\0${e.toKey}`;
    if (edgeSeen.has(sig)) continue;
    edgeSeen.add(sig);
    adj.get(e.fromKey)!.push(e.toKey);
    inDeg.set(e.toKey, (inDeg.get(e.toKey) ?? 0) + 1);
  }

  const queue: TaskNodeKey[] = [];
  for (const k of nodeKeys) {
    if ((inDeg.get(k) ?? 0) === 0) queue.push(k);
  }

  const order: TaskNodeKey[] = [];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++]!;
    order.push(u);
    for (const v of adj.get(u)!) {
      const next = (inDeg.get(v) ?? 0) - 1;
      inDeg.set(v, next);
      if (next === 0) queue.push(v);
    }
  }

  if (order.length < nodeKeys.length) {
    // 剩余节点的入度均 > 0，每个节点至少有一条来自剩余集合的前驱边；逆向回溯必在 <= |R| 步命中环
    const remaining = new Set(nodeKeys.filter((k) => (inDeg.get(k) ?? 0) > 0));
    const predInRem = new Map<TaskNodeKey, TaskNodeKey>();
    for (const e of edges) {
      if (remaining.has(e.fromKey) && remaining.has(e.toKey) && !predInRem.has(e.toKey)) {
        predInRem.set(e.toKey, e.fromKey);
      }
    }
    let cur = [...remaining][0]!;
    const visitedIdx = new Map<TaskNodeKey, number>();
    const backChain: TaskNodeKey[] = [];
    while (!visitedIdx.has(cur)) {
      visitedIdx.set(cur, backChain.length);
      backChain.push(cur);
      cur = predInRem.get(cur)!;
    }
    const cycleSlice = backChain.slice(visitedIdx.get(cur)!).reverse();
    cycleSlice.push(cur);
    throw fail("invalid", `任务图存在循环依赖：${cycleSlice.join(" -> ")}`);
  }

  return order;
}

const createSpecSchema = z.object({
  title: z.string().optional(),
  originMsgId: z.number().int().positive().optional(),
  nodes: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      draft: z.boolean().optional(),
      deps: z.array(z.string()).optional(),
      question: z.string().optional(),
      options: z.array(z.string()).optional(),
      summaryMd: z.string().optional(),
      recommended: z.string().optional(),
    }),
  ),
  edges: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
      }),
    )
    .optional(),
});

const patchSpecSchema = z.object({
  title: z.string().optional(),
  addNodes: z
    .array(
      z.object({
        key: z.string(),
        title: z.string(),
        draft: z.boolean().optional(),
        deps: z.array(z.string()).optional(),
        question: z.string().optional(),
        options: z.array(z.string()).optional(),
        summaryMd: z.string().optional(),
        recommended: z.string().optional(),
      }),
    )
    .optional(),
  updateNodes: z
    .array(
      z.object({
        key: z.string(),
        title: z.string().optional(),
        deps: z.array(z.string()).optional(),
        question: z.string().optional(),
        options: z.array(z.string()).optional(),
        summaryMd: z.string().optional(),
        recommended: z.string().optional(),
      }),
    )
    .optional(),
  removeNodes: z.array(z.string()).optional(),
  skipNodes: z.array(z.string()).optional(),
  addEdges: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  removeEdges: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
});

function toTaskNode(row: TaskNodeDbRow): TaskNode {
  return {
    key: row.node_key,
    title: row.title,
    status: row.status as TaskNodeStatus,
    waitingFor: row.status === "waiting" ? ((row.waiting_for ?? "pm") as TaskNodeWaitingFor) : null,
    skipped: row.status === "done" && row.skipped === 1,
    sortOrder: row.sort_order,
    activeWorkerId: row.active_worker_id,
    workerIds: parseJsonOr<WorkerId[]>(row.worker_ids_json, []),
    artifact: parseJsonOr<TaskArtifact | null>(row.artifact_json, null),
    gateQuestion: row.gate_question,
    gateOptions: parseJsonOr<string[]>(row.gate_options_json, []),
    gateSummaryMd: row.gate_summary_md,
    gateRecommended: row.gate_recommended,
    gateAskMessageId: row.gate_ask_message_id,
    decision: parseJsonOr<TaskDecision | null>(row.decision_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 结果自由文本压成一行，按码点截断后转义 Markdown 标点，避免残缺链接或代码标记影响后文。 */
const clipNote = (text: string): string =>
  truncateChars(text.replace(/\s+/g, " ").trim(), GRAPH_TEXT_NODE_NOTE_CHARS)
    .replace(/[\\`*_[\]{}()<>~]/g, "\\$&");

/**
 * 节点下面的结果行：分支、提交、PR 一行，摘要一行，定案一行；什么都没有就不出。
 * 换人接手、换新会话后不用再去翻旧汇报抄分支和 PR。每项都截断（clipNote），一个节点最多三行。
 */
function nodeResultLines(node: TaskNode): string[] {
  const lines: string[] = [];
  const { artifact, decision } = node;
  const refs: string[] = [];
  if (artifact?.branch) refs.push(`分支 ${clipNote(artifact.branch)}`);
  if (artifact?.commit) refs.push(`提交 ${clipNote(artifact.commit)}`);
  if (artifact?.prUrl) refs.push(`PR ${clipNote(artifact.prUrl)}`);
  if (refs.length > 0) lines.push(`      ${refs.join(" · ")}`);
  if (artifact?.summary) lines.push(`      摘要：${clipNote(artifact.summary)}`);
  if (decision !== null) {
    const note = decision.note ? `（${clipNote(decision.note)}）` : "";
    lines.push(`      定案：${decision.choice === null ? "没选选项" : clipNote(decision.choice)}${note}`);
  }
  return lines;
}

/** 节点那一行后面的 Worker：在干的写“Worker #N”；没人在干但有人干过的写“经手 Worker #a、#b”（最近 GRAPH_TEXT_NODE_WORKERS_MAX 个）。 */
function nodeWorkerNote(node: TaskNode): string {
  if (node.activeWorkerId !== null) return ` · Worker #${node.activeWorkerId}`;
  if (node.workerIds.length === 0) return "";
  const recent = node.workerIds.slice(-GRAPH_TEXT_NODE_WORKERS_MAX);
  return ` · 经手${node.workerIds.length > recent.length ? "（最近的）" : ""} Worker ${recent.map((id) => `#${id}`).join("、")}`;
}

function graphStatusLabel(graph: Pick<TaskGraph, "status" | "nodes">): string {
  return isTaskGraphReadyToFinish(graph) ? "active · 待交付" : graph.status;
}

/**
 * hub graph show、hub graph patch 的回执、换新会话的交接摘要共用的一张图的文本：每个节点一行状态，下面是它的结果（nodeResultLines）。
 * results 为 false 时只列状态那一行（交接摘要放不下全文时用）。
 */
function formatGraphText(graph: TaskGraph, results = true): string {
  const depMap = new Map<string, string[]>();
  for (const e of graph.edges) {
    let list = depMap.get(e.toKey);
    if (list === undefined) {
      list = [];
      depMap.set(e.toKey, list);
    }
    list.push(e.fromKey);
  }
  const lines = [`任务图 #${graph.id}「${graph.title}」（状态：${graphStatusLabel(graph)}）`];
  for (const n of graph.nodes) {
    const deps = depMap.get(n.key);
    const depNote = deps && deps.length > 0 ? ` ← [${deps.join(", ")}]` : "";
    const cardNote = n.gateQuestion !== null && n.decision === null && n.status !== "done" ? " [拍板卡]" : "";
    lines.push(
      `  - [${taskNodeStatusText(n, "pm")}] ${n.key}：${n.title}${cardNote}${nodeWorkerNote(n)}${depNote}`,
      ...(results ? nodeResultLines(n) : []),
    );
  }
  return lines.join("\n");
}

/** 一张图只留一行进度（交接摘要里连只列状态都放不下时用）。 */
function formatGraphBrief(graph: TaskGraph): string {
  const settled = graph.nodes.filter((n) => n.status === "done").length;
  return `任务图 #${graph.id}「${graph.title}」（状态：${graphStatusLabel(graph)}，进度 ${settled}/${graph.nodes.length}；详情用 ${HUB_COMMAND} graph show ${graph.id} 看）`;
}

/** 这次轮到的步骤：没写职责的手动步骤等项目经理（waitingFor pm），挂了拍板卡的等用户（waitingFor user）。 */
interface TurnedStep {
  key: TaskNodeKey;
  title: string;
  waitingFor: TaskNodeWaitingFor;
}

const turnedListText = (turned: readonly TurnedStep[]): string =>
  turned.map((u) => `${u.key} [${taskNodeStatusText({ status: "waiting", waitingFor: u.waitingFor, skipped: false }, "pm")}]`).join("、");

/** 改图的命令回执里共用的一段：这次轮到了哪些步骤，或者全部步骤是否已完了待交付。 */
function unlockedNoteOf(unlocked: readonly TurnedStep[], graph: TaskGraph): string {
  if (unlocked.length > 0) {
    const pmKeys = unlocked.filter((u) => u.waitingFor === "pm").map((u) => u.key);
    const dispatch = pmKeys.length > 0 ? `（给它派 Worker：${HUB_COMMAND} worker start --node ${pmKeys[0]} --graph ${graph.id}）` : "";
    return `；轮到了：${turnedListText(unlocked)}${dispatch}`;
  }
  if (isTaskGraphReadyToFinish(graph)) {
    return `；全部节点已完成（待交付），验收合并后用 ${HUB_COMMAND} graph finish 结束任务图`;
  }
  return graph.status === "completed" ? "；整张任务图已全部完结！" : "";
}

export interface WorkerBindTarget {
  graphId: TaskGraphId;
  nodeKey: TaskNodeKey;
  graphTitle: string;
  nodeTitle: string;
  /** 这一步在图里排第几（按节点顺序，从 1 起）、一共几步。 */
  index: number;
  total: number;
  /** 节点上还挂着的 Worker（换人时后台先把它收工）；没有是 null。 */
  activeWorkerId: WorkerId | null;
  /** 经手过这个节点的 Worker，从旧到新；不是空的就是换人接手（docs/orchestration-simplify-design.md 第 5.2 节）。 */
  workerIds: WorkerId[];
}

export type LedgerTaskGraphs = ReturnType<typeof createLedgerTaskGraphs>;

export function createLedgerTaskGraphs(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  messages: LedgerMessages,
  persona: LedgerPersona,
  projects: LedgerProjects,
  router: Pick<LedgerRouter, "reportIn">,
) {
  const { db, now, write, enqueue } = ctx;
  const { assertPmNotArchived, privateConversation } = persona;
  const { activeProjectOf } = projects;

  const mainFolderOf = (projectId: ProjectId): string | null =>
    db.get<{ path: string }>(
      "SELECT path FROM project_folders WHERE project_id = ? AND is_main = 1 AND removed_at IS NULL",
      projectId,
    )?.path ?? null;

  const getGraphRow = (id: TaskGraphId): TaskGraphDbRow | undefined =>
    db.get<TaskGraphDbRow>("SELECT * FROM task_graphs WHERE id = ?", id);

  const loadGraph = (id: TaskGraphId): TaskGraph | null => {
    const row = getGraphRow(id);
    if (row === undefined) return null;
    const nodeRows = db.all<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE graph_id = ? ORDER BY sort_order ASC, id ASC",
      id,
    );
    const edgeRows = db.all<TaskEdgeDbRow>(
      "SELECT * FROM task_graph_edges WHERE graph_id = ? ORDER BY from_key ASC, to_key ASC",
      id,
    );
    return {
      id: row.id,
      projectId: row.project_id,
      pmId: row.pm_id,
      conversationId: row.conversation_id,
      title: row.title,
      status: row.status as TaskGraphStatus,
      originMsgId: row.origin_msg_id,
      nodes: nodeRows.map(toTaskNode),
      edges: edgeRows.map((e) => ({ fromKey: e.from_key, toKey: e.to_key })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  };

  /** 批量读取多张任务图（避免 N+1 查询，供 snapshot 与分页共用）。 */
  const hydrateGraphs = (rows: readonly TaskGraphDbRow[]): TaskGraph[] => {
    if (rows.length === 0) return [];
    const byId = new Map<number, { nodes: TaskNode[]; edges: TaskEdge[] }>();
    for (const r of rows) byId.set(r.id, { nodes: [], edges: [] });
    const idsJson = JSON.stringify(rows.map((r) => r.id));

    const nodeRows = db.all<TaskNodeDbRow>(
      `SELECT n.* FROM task_graph_steps n
        WHERE n.graph_id IN (SELECT value FROM json_each(?))
        ORDER BY n.graph_id ASC, n.sort_order ASC, n.id ASC`,
      idsJson,
    );
    for (const n of nodeRows) byId.get(n.graph_id)?.nodes.push(toTaskNode(n));

    const edgeRows = db.all<TaskEdgeDbRow>(
      `SELECT e.* FROM task_graph_edges e
        WHERE e.graph_id IN (SELECT value FROM json_each(?))
        ORDER BY e.graph_id ASC, e.from_key ASC, e.to_key ASC`,
      idsJson,
    );
    for (const e of edgeRows) byId.get(e.graph_id)?.edges.push({ fromKey: e.from_key, toKey: e.to_key });

    return rows.map((row) => {
      const children = byId.get(row.id)!;
      return {
        id: row.id,
        projectId: row.project_id,
        pmId: row.pm_id,
        conversationId: row.conversation_id,
        title: row.title,
        status: row.status as TaskGraphStatus,
        originMsgId: row.origin_msg_id,
        nodes: children.nodes,
        edges: children.edges,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
      };
    });
  };

  const gateChatMessageText = (node: {
    title: string;
    gate_question: string | null;
    gate_summary_md: string | null;
    gate_recommended: string | null;
  }): string => {
    const parts = [node.gate_question ?? node.title];
    if (node.gate_recommended !== null && node.gate_recommended !== "") {
      parts.push(`推荐方案：${node.gate_recommended}`);
    }
    if (node.gate_summary_md !== null && node.gate_summary_md !== "") {
      parts.push(node.gate_summary_md);
    }
    return parts.join("\n\n");
  };

  /** 图里所有步骤都完了（跳过也算完了）。 */
  const isGraphAllSettled = (graphId: TaskGraphId): boolean => {
    const rows = db.all<{ status: string }>("SELECT status FROM task_graph_steps WHERE graph_id = ?", graphId);
    return rows.length > 0 && rows.every((n) => n.status === "done");
  };

  const collapseOneLine = (text: string, maxChars: number): string =>
    truncateChars(text.replace(/\s+/gu, " ").trim(), maxChars);

  /** 汇总任务图里已完成节点关联的分支、查询目录（优先项目主文件夹，worktree 已清理也能查）与基准提交。 */
  const collectGraphBranches = (
    graphRow: TaskGraphDbRow,
  ): Array<{ branch: string; nodeKey: TaskNodeKey; cwd: string; baseCommit: string | null }> => {
    const mainFolder = mainFolderOf(graphRow.project_id);
    const nodeRows = db.all<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE graph_id = ? AND status = 'done' AND skipped = 0 ORDER BY sort_order ASC, id ASC",
      graphRow.id,
    );
    const seen = new Set<string>();
    const out: Array<{ branch: string; nodeKey: TaskNodeKey; cwd: string; baseCommit: string | null }> = [];
    const pushBranch = (branch: string | null | undefined, nodeKey: TaskNodeKey, cwd: string | null, baseCommit: string | null) => {
      const b = branch?.trim() ?? "";
      if (b === "" || seen.has(b)) return;
      const targetCwd = mainFolder || cwd || "";
      if (targetCwd === "") return;
      seen.add(b);
      out.push({ branch: b, nodeKey, cwd: targetCwd, baseCommit });
    };
    for (const node of nodeRows) {
      const artifact = parseJsonOr<TaskArtifact | null>(node.artifact_json, null);
      const workerIds = parseJsonOr<WorkerId[]>(node.worker_ids_json, []);
      for (const wid of workerIds) {
        const w = db.get<{ branch: string | null; worktree_path: string | null; base_commit: string | null }>(
          "SELECT branch, worktree_path, base_commit FROM workers WHERE id = ?",
          wid,
        );
        if (w?.branch) pushBranch(w.branch, node.node_key, w.worktree_path, w.base_commit);
      }
      if (artifact?.branch) pushBranch(artifact.branch, node.node_key, null, null);
    }
    return out;
  };

  /**
   * 已完成节点上手工补记的 PR 网址（hub graph done --pr）：没有分支记录的节点只能按网址查，否则 finish 会漏查还开着的 PR。
   * 只收 http(s) 网址（交给 gh pr view，不会被当成参数）；查询目录用项目主文件夹，没有就不查（不拦）。
   */
  const collectGraphPrUrls = (graphRow: TaskGraphDbRow): Array<{ prUrl: string; nodeKey: TaskNodeKey; cwd: string }> => {
    const mainFolder = mainFolderOf(graphRow.project_id);
    if (mainFolder === null) return [];
    const nodeRows = db.all<Pick<TaskNodeDbRow, "node_key" | "artifact_json">>(
      "SELECT node_key, artifact_json FROM task_graph_steps WHERE graph_id = ? AND status = 'done' AND skipped = 0 ORDER BY sort_order ASC, id ASC",
      graphRow.id,
    );
    const seen = new Set<string>();
    const out: Array<{ prUrl: string; nodeKey: TaskNodeKey; cwd: string }> = [];
    for (const node of nodeRows) {
      const prUrl = parseJsonOr<TaskArtifact | null>(node.artifact_json, null)?.prUrl?.trim() ?? "";
      if (!/^https?:\/\/\S+$/iu.test(prUrl) || seen.has(prUrl)) continue;
      seen.add(prUrl);
      out.push({ prUrl, nodeKey: node.node_key, cwd: mainFolder });
    }
    return out;
  };

  const prStateLabelZh = (state: string): string => {
    switch (state.toUpperCase()) {
      case "OPEN":
        return "开着";
      case "MERGED":
        return "已合并";
      case "CLOSED":
        return "已关闭";
      default:
        return state;
    }
  };

  /**
   * 生成交付单正文（docs/orchestration-simplify-design.md 第 6 节）：
   * 列出各节点结果摘要、分支、提交、PR 状态、测试结论、门禁拍板定案，以及相对主干改动文件名单（上限 DELIVERY_FILES_MAX 个），
   * 总长度受 DELIVERY_NOTE_MAX_CHARS 保护，末尾固定附验收与 hub graph finish 指引。
   */
  const formatDeliveryNote = (
    graph: TaskGraph,
    extra?: {
      files?: ReadonlyArray<{ file: string; added: number | null; deleted: number | null }>;
      prs?: Readonly<Record<string, WorkerPr>>;
    },
  ): string => {
    const lines: string[] = [`【任务图 #${graph.id}「${graph.title}」全部步骤做完，等你交付】`];

    for (let i = 0; i < graph.nodes.length; i++) {
      const n = graph.nodes[i]!;
      if (n.skipped) {
        const skipSummary = n.artifact?.summary ? ` · ${collapseOneLine(n.artifact.summary, 200)}` : "";
        lines.push(`${i + 1}. [已跳过] ${n.key} ${n.title}${skipSummary}`);
        continue;
      }
      const parts: string[] = [`${i + 1}. [完了] ${n.key} ${n.title}`];
      const lastWid = n.workerIds.length > 0 ? n.workerIds[n.workerIds.length - 1]! : null;
      let workerBranch: string | null = null;
      let reportSummary: string | null = null;
      let reportCommit: string | null = null;
      let reportTests: string | null = null;
      if (lastWid !== null) {
        parts.push(`Worker #${lastWid}`);
        const w = db.get<{ branch: string | null }>("SELECT branch FROM workers WHERE id = ?", lastWid);
        workerBranch = w?.branch ?? null;
        const reportMsg = db.get<{ text: string }>(
          `SELECT text FROM messages
             WHERE conversation_id = ? AND kind = 'worker' AND worker_id = ?
               AND CASE WHEN json_valid(meta) THEN json_extract(meta, '$.event') = 'report' ELSE 0 END
             ORDER BY id DESC LIMIT 1`,
          graph.conversationId,
          lastWid,
        );
        if (reportMsg !== undefined) {
          const parsed = parseWorkerReport(reportMsg.text);
          if (parsed.kind === "ok") {
            reportSummary = parsed.report.summary;
            reportCommit = parsed.report.commit;
            reportTests = parsed.report.tests.trim() || null;
          } else if (parsed.summary) {
            reportSummary = parsed.summary;
          }
        }
      }
      const summaryText =
        n.artifact?.summary?.trim() ||
        reportSummary ||
        (n.decision !== null ? `定案 ${n.decision.choice ?? n.decision.note ?? ""}` : "");
      if (summaryText) parts.push(collapseOneLine(summaryText, 200));

      const branch = n.artifact?.branch?.trim() || workerBranch;
      if (branch) parts.push(`分支 ${branch}`);

      const commit = n.artifact?.commit?.trim() || reportCommit;
      if (commit) parts.push(`提交 ${collapseOneLine(commit, 40)}`);

      const probedPr = branch ? extra?.prs?.[branch] : undefined;
      if (probedPr !== undefined) {
        parts.push(`PR #${probedPr.number}（${prStateLabelZh(probedPr.state)}）`);
      } else if (n.artifact?.prUrl?.trim()) {
        parts.push(`PR ${collapseOneLine(n.artifact.prUrl, 120)}`);
      }

      if (reportTests) parts.push(`测试：${collapseOneLine(reportTests, 200)}`);
      lines.push(parts.join(" · "));
    }

    for (const n of graph.nodes) {
      if (n.decision === null) continue;
      const q = collapseOneLine(n.gateQuestion?.trim() || n.title, 120);
      const choiceText = n.decision.choice !== null ? collapseOneLine(n.decision.choice, 120) : "自定义意见";
      const noteText = n.decision.note ? `（${collapseOneLine(n.decision.note, 120)}）` : "";
      lines.push(`拍板：「${q}」定案 ${choiceText}${noteText}`);
    }

    if (extra?.files !== undefined) {
      if (extra.files.length === 0) {
        lines.push("改动文件（相对主干）：无提交改动");
      } else {
        lines.push(`改动文件（相对主干，共 ${extra.files.length} 个）：`);
        for (const f of extra.files.slice(0, DELIVERY_FILES_MAX)) {
          const stat = f.added === null || f.deleted === null ? "二进制" : `+${f.added} -${f.deleted}`;
          lines.push(`  ${f.file} | ${stat}`);
        }
        if (extra.files.length > DELIVERY_FILES_MAX) {
          lines.push(`  …另有 ${extra.files.length - DELIVERY_FILES_MAX} 个文件省略`);
        }
      }
    }

    const footer = `\n\n验收看上面的证据。合并后用 ${HUB_COMMAND} graph finish 结束这张图。`;
    const bodyBudget = Math.max(200, DELIVERY_NOTE_MAX_CHARS - [...footer].length);
    return `${truncateChars(lines.join("\n"), bodyBudget)}${footer}`;
  };

  /**
   * 一张图的全部交付单的 dedupe_key 匹配式（systemMessageDedupeKey：system:<对话>:task_graph.ready_to_finish:<图>:<序号>）。
   * 用 GLOB 前缀而不是 LIKE：dedupe_key 是 BINARY 排序的 UNIQUE 列，GLOB 前缀能走它的索引做区间查找；
   * LIKE 默认不区分大小写，用不上索引，会把项目经理对话里的全部消息（跑一个月上万条）扫一遍，而每次节点推进都要查。
   */
  const deliveryNoteKeyGlob = (conversationId: ConversationId, graphId: TaskGraphId): string =>
    `system:${conversationId}:task_graph.ready_to_finish:${graphId}:*`;

  /** 图退出“待交付”（补了新节点、打回重做、finish 或 cancel）时，收起尚未发出的排队交付单，避免过时叫醒。 */
  const stopQueuedDeliveryNotesIn = (p: Pending, conversationId: ConversationId, graphId: TaskGraphId): void => {
    const queuedRows = db.all<{ id: number }>(
      "SELECT id FROM messages WHERE dedupe_key GLOB ? AND status = 'queued'",
      deliveryNoteKeyGlob(conversationId, graphId),
    );
    for (const r of queuedRows) {
      messages.transition(p, r.id, "stopped");
    }
  };

  /**
   * 节点状态推进后同步维护交付单：
   * - 图刚从“仍有未完节点”进入“全部终态”（!wasAllSettled && nowSettled）时，向 PM 对话入队一条静默触发的交付单；
   * - 若此前已有尚未发出的 queued 交付单则原地刷新，否则按递增 seq 入队，防止重复轰炸；
   * - 若图不再处于“待交付”（例如 patch 新增了未完节点），收起尚未发出的排队交付单。
   */
  const syncDeliveryNoteAfterProgressIn = (p: Pending, graphRow: TaskGraphDbRow, wasAllSettled: boolean): void => {
    const freshRow = getGraphRow(graphRow.id);
    if (freshRow === undefined || freshRow.status !== "active") {
      stopQueuedDeliveryNotesIn(p, graphRow.conversation_id, graphRow.id);
      return;
    }
    const nowSettled = isGraphAllSettled(freshRow.id);
    if (!nowSettled) {
      stopQueuedDeliveryNotesIn(p, freshRow.conversation_id, freshRow.id);
      return;
    }
    if (wasAllSettled) return;

    const pmSession = sessions.currentSession(freshRow.conversation_id);
    if (pmSession === null) return;
    const graph = loadGraph(freshRow.id);
    if (graph === null) return;
    const text = formatDeliveryNote(graph);
    const t = now();

    const keyGlob = deliveryNoteKeyGlob(freshRow.conversation_id, freshRow.id);
    const existingQueued = db.get<MessageDbRow>(
      "SELECT * FROM messages WHERE dedupe_key GLOB ? AND status = 'queued' ORDER BY id DESC LIMIT 1",
      keyGlob,
    );
    if (existingQueued !== undefined) {
      const prevMeta = parseJsonOr<Record<string, unknown>>(existingQueued.meta, {});
      const nextMeta: SystemMessageMeta = {
        event: "task_graph.ready_to_finish",
        graphId: freshRow.id,
        seq: typeof prevMeta.seq === "number" ? prevMeta.seq : 1,
        diffProbed: false,
      };
      db.run(
        "UPDATE messages SET session_id = ?, text = ?, meta = ?, updated_at = ? WHERE id = ?",
        pmSession.id,
        text,
        JSON.stringify(nextMeta),
        t,
        existingQueued.id,
      );
      p.changes.push({ type: "message.updated", data: { message: toMessage(db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", existingQueued.id)!) } });
      enqueue(p, { type: "session.send", params: { sessionId: pmSession.id, messageId: existingQueued.id, source: "system" } });
      return;
    }

    const prevCount =
      db.get<{ cnt: number }>(
        "SELECT count(*) AS cnt FROM messages WHERE dedupe_key GLOB ?",
        keyGlob,
      )?.cnt ?? 0;
    const meta: SystemMessageMeta = {
      event: "task_graph.ready_to_finish",
      graphId: freshRow.id,
      seq: prevCount + 1,
      diffProbed: false,
    };
    const row = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'system', 'text', ?, ?, ?, 'queued', ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
      freshRow.conversation_id,
      pmSession.id,
      text,
      JSON.stringify(meta),
      systemMessageDedupeKey(freshRow.conversation_id, meta),
      t,
      t,
    );
    if (row === undefined) return;
    p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
    enqueue(p, { type: "session.send", params: { sessionId: pmSession.id, messageId: row.id, source: "system" } });
  };

  /**
   * 按拓扑序重算整张活跃任务图里轮到了哪些步骤（docs/orchestration-simplify-design.md 第 3.2 节第 3 行）：
   * 前置步骤都完了（跳过也算完了）的“没轮到”步骤变“等人”——挂了拍板卡（有问题）的等用户并补发卡片消息，
   * 其余是手动步骤（还没有职责，自动开工是第 5 步的事），等项目经理派人。跳过只跳过它自己，不连带下游。
   * patch 给还没人干过的等人步骤加了没完的前置（或上游被打回重做），退回“没轮到”。
   * 全部步骤都完了以后图仍是 active 待交付，只在 hub graph finish 时标 completed。
   * 返回这次轮到的步骤；不叫醒谁——调用方按是谁触发的决定（项目经理自己的命令写进回执，用户在网页上点的叫醒项目经理，见 wakePmForTurnedIn）。
   */
  const recomputeGraphProgressIn = (
    p: Pending,
    graphRow: TaskGraphDbRow,
    callerSession?: AgentSessionRow | null,
  ): TurnedStep[] => {
    const nodeRows = db.all<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE graph_id = ? ORDER BY sort_order ASC, id ASC",
      graphRow.id,
    );
    const edgeRows = db.all<TaskEdgeDbRow>(
      "SELECT * FROM task_graph_edges WHERE graph_id = ?",
      graphRow.id,
    );
    if (nodeRows.length === 0) return [];

    const edges: TaskEdge[] = edgeRows.map((e) => ({ fromKey: e.from_key, toKey: e.to_key }));
    const byKey = new Map<TaskNodeKey, TaskNodeDbRow>(nodeRows.map((n) => [n.node_key, n]));
    const order = validateDagAndOrder(
      nodeRows.map((n) => n.node_key),
      edges,
    );

    const incoming = new Map<TaskNodeKey, TaskNodeKey[]>();
    for (const n of nodeRows) incoming.set(n.node_key, []);
    for (const e of edges) incoming.get(e.toKey)?.push(e.fromKey);

    const t = now();
    const turned: TurnedStep[] = [];
    const pmSession = callerSession ?? sessions.currentSession(graphRow.conversation_id);

    for (const key of order) {
      const node = byKey.get(key)!;
      const upsDone = (incoming.get(key) ?? []).every((u) => byKey.get(u)?.status === "done");

      // 轮到了但还没人干过、也还没定案的等人步骤（含等项目经理与刚出卡等用户的步骤）：前置又有没完的了，收起旧卡并退回没轮到
      if (
        !upsDone &&
        node.status === "waiting" &&
        node.active_worker_id === null &&
        parseJsonOr<WorkerId[]>(node.worker_ids_json, []).length === 0 &&
        node.decision_json === null
      ) {
        if (node.gate_ask_message_id !== null) {
          messages.markAskAnsweredIn(p, node.gate_ask_message_id);
        }
        node.status = "pending";
        node.waiting_for = null;
        node.gate_ask_message_id = null;
        db.run(
          "UPDATE task_graph_steps SET status = 'pending', waiting_for = NULL, gate_ask_message_id = NULL, updated_at = ? WHERE id = ?",
          t,
          node.id,
        );
        continue;
      }

      if (node.status !== "pending" || !upsDone) continue;

      const hasQuestion = node.gate_question !== null && node.gate_question.trim() !== "";
      if (!hasQuestion) {
        node.status = "waiting";
        node.waiting_for = "pm";
        db.run("UPDATE task_graph_steps SET status = 'waiting', waiting_for = 'pm', updated_at = ? WHERE id = ?", t, node.id);
        turned.push({ key: node.node_key, title: node.title, waitingFor: "pm" });
        continue;
      }

      // 挂了拍板卡：发卡片消息（带 gateRef，用户点了经 decide 解锁），等用户
      let askMsgId = node.gate_ask_message_id;
      if (askMsgId === null && pmSession !== null) {
        const opts = parseJsonOr<string[]>(node.gate_options_json, []);
        const msg = messages.insertAskMessage(
          p,
          { ...pmSession, conversationId: graphRow.conversation_id },
          gateChatMessageText(node),
          opts.length >= 2 ? opts : undefined,
          { gateRef: { graphId: graphRow.id, nodeKey: node.node_key } },
        );
        askMsgId = msg.id;
      }
      node.status = "waiting";
      node.waiting_for = "user";
      node.gate_ask_message_id = askMsgId;
      db.run(
        "UPDATE task_graph_steps SET status = 'waiting', waiting_for = 'user', gate_ask_message_id = ?, updated_at = ? WHERE id = ?",
        askMsgId,
        t,
        node.id,
      );
      turned.push({ key: node.node_key, title: node.title, waitingFor: "user" });
    }

    db.run("UPDATE task_graphs SET updated_at = ? WHERE id = ?", t, graphRow.id);

    return turned;
  };

  /**
   * 不是项目经理自己的命令让步骤轮到了（比如用户在网页上跳过了前一步）：轮到的手动步骤等项目经理，叫醒它（第 3.2 节第 3 行）。
   * 项目经理自己的命令（建图、改图、放行、收工……）把轮到的步骤写进回执，不另外叫；挂了拍板卡的等用户，也不叫。
   * lead 是开头那句（谁做了什么）；没有等项目经理的步骤时什么也不发，返回 null。
   */
  const wakePmForTurnedIn = (
    p: Pending,
    graphRow: TaskGraphDbRow,
    turned: readonly TurnedStep[],
    lead: string,
    dedupeRef: string,
  ): MessageId | null => {
    const forPm = turned.filter((u) => u.waitingFor === "pm");
    if (forPm.length === 0) return null;
    const first = forPm[0]!;
    const wake = messages.enqueueWakeupUserMessageIn(p, {
      conversationId: graphRow.conversation_id,
      dedupeKey: userMessageDedupeKey(graphRow.conversation_id, `graph-turned:${graphRow.id}:${dedupeRef}`),
      text:
        `【任务图 #${graphRow.id}「${graphRow.title}」】${lead}轮到了：${forPm.map((u) => `${u.key}（${u.title}）`).join("、")}，等你处理。` +
        `给它派 Worker 用 ${HUB_COMMAND} worker start --node ${first.key} --graph ${graphRow.id}，不需要了用 ${HUB_COMMAND} graph skip ${first.key} --graph ${graphRow.id}。`,
    });
    return wake.id;
  };

  /** 为 PM 命令定位目标任务图：支持单活跃图免填 graphId，也支持多活跃图按唯一 nodeKey 自动定位。 */
  const resolveGraphForPm = (
    pmId: PmId,
    opts: { graphId?: TaskGraphId; nodeKey?: TaskNodeKey; requireActive: boolean },
  ): TaskGraphDbRow => {
    if (opts.graphId !== undefined) {
      const row = getGraphRow(opts.graphId);
      if (row === undefined) throw fail("not_found", `没有编号 #${opts.graphId} 的任务图`);
      if (row.pm_id !== pmId) throw fail("forbidden", `任务图 #${opts.graphId} 不属于当前项目经理`);
      if (opts.requireActive && row.status !== "active") {
        throw fail("conflict", `任务图 #${opts.graphId} 已经结束（${row.status}）`);
      }
      return row;
    }

    const activeRows = db.all<TaskGraphDbRow>(
      "SELECT * FROM task_graphs WHERE pm_id = ? AND status = 'active' ORDER BY id DESC",
      pmId,
    );
    if (activeRows.length === 0) {
      throw fail("not_found", `当前没有活跃的任务图（先用 ${HUB_COMMAND} graph create 创建）`);
    }
    if (activeRows.length === 1) return activeRows[0]!;

    if (opts.nodeKey !== undefined) {
      const matching = activeRows.filter(
        (g) =>
          db.get(
            "SELECT 1 AS x FROM task_graph_steps WHERE graph_id = ? AND node_key = ?",
            g.id,
            opts.nodeKey!,
          ) !== undefined,
      );
      if (matching.length === 1) return matching[0]!;
      if (matching.length > 1) {
        throw fail(
          "conflict",
          `多张活跃任务图（${matching.map((m) => `#${m.id}`).join("、")}）都包含节点「${opts.nodeKey}」，请用 --graph <编号> 指定`,
        );
      }
      throw fail("not_found", `当前活跃的任务图中找不到节点「${opts.nodeKey}」`);
    }

    throw fail(
      "conflict",
      `当前有 ${activeRows.length} 张活跃任务图（${activeRows.map((g) => `#${g.id} ${g.title}`).join("；")}），请显式指定图编号`,
    );
  };

  /** hub graph create：创建持久化 DAG 并推导初始状态。 */
  const createIn = (
    p: Pending,
    caller: AgentSessionRow & { pmId: PmId },
    rawArgs: HubArgs<"graph.create">,
  ): HubResult<"graph.create"> => {
    assertPmNotArchived(caller.pmId);
    const project = activeProjectOf(caller.pmId);
    if (project === null) {
      throw fail("invalid", `你还没有项目，先用 ${HUB_COMMAND} project create --folder <主文件夹> 建一个`);
    }
    if (typeof rawArgs.specJson !== "string" || Buffer.byteLength(rawArgs.specJson, "utf8") > MAX_GRAPH_SPEC_BYTES) {
      throw fail("invalid", `任务图规格 JSON 不能为空，且不超过 ${MAX_GRAPH_SPEC_BYTES} 字节`);
    }

    let rawObj: unknown;
    try {
      rawObj = JSON.parse(rawArgs.specJson);
    } catch {
      throw fail("invalid", "任务图规格不是合法的 JSON");
    }
    const parsed = createSpecSchema.safeParse(rawObj);
    if (!parsed.success) throw fail("invalid", "任务图规格字段格式不正确");
    const spec: CreateTaskGraphSpecInput = parsed.data;

    const titleRaw = rawArgs.title ?? spec.title ?? "";
    const title = validateGraphTitle(titleRaw);

    const activeCount = db.get<{ n: number }>(
      "SELECT count(*) AS n FROM task_graphs WHERE project_id = ? AND status = 'active'",
      project.id,
    )!.n;
    if (activeCount >= MAX_ACTIVE_GRAPHS_PER_PROJECT) {
      throw fail(
        "conflict",
        `当前项目已有 ${MAX_ACTIVE_GRAPHS_PER_PROJECT} 张活跃任务图，请先完结或用 ${HUB_COMMAND} graph cancel 取消不再需要的图`,
      );
    }

    const normalizedNodes = spec.nodes.map((n, index) => {
      const key = validateNodeKey(n.key);
      const nodeTitle = validateNodeTitle(n.title);
      // 节点类型只剩一种（步骤）：写了问题的步骤就是挂了拍板卡，轮到时等用户；老写法的 kind 由 zod 直接丢掉
      const gate = validateGateFields(n);
      return {
        key,
        title: nodeTitle,
        sortOrder: index,
        deps: (n.deps ?? []).map(validateNodeKey),
        gate,
      };
    });

    const edges: TaskEdge[] = [];
    for (const n of normalizedNodes) {
      for (const dep of n.deps) edges.push({ fromKey: dep, toKey: n.key });
    }
    for (const e of spec.edges ?? []) {
      edges.push({ fromKey: validateNodeKey(e.from), toKey: validateNodeKey(e.to) });
    }

    const topoOrder = validateDagAndOrder(
      normalizedNodes.map((n) => n.key),
      edges,
    );
    const rankOf = new Map<TaskNodeKey, number>(topoOrder.map((k, idx) => [k, idx]));

    const conversationId = caller.conversationId ?? privateConversation(caller.pmId)?.id ?? project.conversation_id;
    const t = now();
    const graphRow = db.get<TaskGraphDbRow>(
      `INSERT INTO task_graphs (
         project_id, pm_id, conversation_id, title, status, origin_msg_id, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL) RETURNING *`,
      project.id,
      caller.pmId,
      conversationId,
      title,
      spec.originMsgId ?? null,
      t,
      t,
    )!;

    for (const n of normalizedNodes) {
      db.run(
        `INSERT INTO task_graph_steps (
           graph_id, node_key, title, status, waiting_for, skipped, sort_order,
           active_worker_id, worker_ids_json, artifact_json,
           gate_question, gate_options_json, gate_summary_md, gate_recommended, gate_ask_message_id, decision_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', NULL, 0, ?, NULL, '[]', NULL, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        graphRow.id,
        n.key,
        n.title,
        rankOf.get(n.key) ?? n.sortOrder,
        n.gate.question,
        n.gate.options.length > 0 ? JSON.stringify(n.gate.options) : null,
        n.gate.summaryMd,
        n.gate.recommended,
        t,
        t,
      );
    }

    const insertedEdgeSet = new Set<string>();
    for (const e of edges) {
      const sig = `${e.fromKey}\0${e.toKey}`;
      if (insertedEdgeSet.has(sig)) continue;
      insertedEdgeSet.add(sig);
      db.run(
        "INSERT INTO task_graph_edges (graph_id, from_key, to_key) VALUES (?, ?, ?)",
        graphRow.id,
        e.fromKey,
        e.toKey,
      );
    }

    const turned = recomputeGraphProgressIn(p, graphRow, caller);
    const graph = loadGraph(graphRow.id)!;
    p.changes.push({ type: "task_graph.created", data: { graph } });
    const progressNote = unlockedNoteOf(turned, graph).replace(/^；/u, "");

    return {
      text: `已创建${formatGraphText(graph)}${progressNote !== "" ? `\n${progressNote}` : ""}`,
      data: { graph },
    };
  };

  /** hub graph show [<graphId>] */
  const show = (
    caller: AgentSessionRow & { pmId: PmId },
    args: HubArgs<"graph.show">,
  ): HubResult<"graph.show"> => {
    const row = resolveGraphForPm(caller.pmId, { graphId: args.graphId, requireActive: false });
    const graph = loadGraph(row.id)!;
    return { text: formatGraphText(graph), data: { graph } };
  };

  /** hub graph list [--all | --status active|completed|cancelled] */
  const list = (
    caller: AgentSessionRow & { pmId: PmId },
    args: HubArgs<"graph.list">,
  ): HubResult<"graph.list"> => {
    const rows =
      args.all === true
        ? db.all<TaskGraphDbRow>(
            "SELECT * FROM task_graphs WHERE pm_id = ? ORDER BY id DESC LIMIT ?",
            caller.pmId,
            HUB_GRAPH_LIST_LIMIT,
          )
        : args.status !== undefined && args.status !== "active"
          ? db.all<TaskGraphDbRow>(
              "SELECT * FROM task_graphs WHERE pm_id = ? AND status = ? ORDER BY id DESC LIMIT ?",
              caller.pmId,
              args.status,
              HUB_GRAPH_LIST_LIMIT,
            )
          : db.all<TaskGraphDbRow>(
              "SELECT * FROM task_graphs WHERE pm_id = ? AND status = 'active' ORDER BY updated_at DESC, id DESC LIMIT ?",
              caller.pmId,
              MAX_ACTIVE_GRAPHS_PER_PROJECT,
            );
    const graphs = hydrateGraphs(rows);
    if (graphs.length === 0) {
      return {
        text: args.all === true || (args.status !== undefined && args.status !== "active") ? "还没有符合条件的任务图。" : "当前没有活跃的任务图。",
        data: { graphs: [] },
      };
    }
    return {
      // 列表最多 HUB_GRAPH_LIST_LIMIT 张图，只列各节点的状态；节点的结果（分支、PR、摘要、定案）用 hub graph show <图编号> 看
      text: graphs.map((g) => formatGraphText(g, false)).join("\n\n"),
      data: { graphs },
    };
  };

  /**
   * hub graph ask <nodeKey>：给还没开工的步骤挂上（或改）拍板卡：问题、选项、推荐和背景摘要。
   * 前置都完了的立即等用户（发卡片消息），否则轮到时再出卡。在干、完了的步骤不能挂（那是第 6 步 hub ask --node 的事）。
   */
  const askIn = (
    p: Pending,
    caller: AgentSessionRow & { pmId: PmId },
    args: HubArgs<"graph.ask">,
  ): HubResult<"graph.ask"> => {
    assertPmNotArchived(caller.pmId);
    const nodeKey = validateNodeKey(args.nodeKey);
    const graphRow = resolveGraphForPm(caller.pmId, { graphId: args.graphId, nodeKey, requireActive: true });
    const node = db.get<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE graph_id = ? AND node_key = ?",
      graphRow.id,
      nodeKey,
    );
    if (node === undefined) throw fail("not_found", `任务图 #${graphRow.id} 中没有节点「${nodeKey}」`);
    if (node.status === "done") throw fail("conflict", `步骤「${nodeKey}」已经完了，不能再挂拍板卡`);
    if (node.status === "running" || node.active_worker_id !== null) {
      throw fail("conflict", `步骤「${nodeKey}」有 Worker #${node.active_worker_id ?? "?"} 挂着，不能挂拍板卡：要它问用户就让它在汇报里写，或先收工`);
    }

    const gate = validateGateFields({
      question: args.question,
      options: args.options,
      recommended: args.recommended,
      summaryMd: args.summaryMd,
    });
    if (gate.question === null) throw fail("invalid", "拍板卡的问题不能为空");

    const t = now();
    // 若这张拍板卡此前已发过旧 AskMeta，先将旧消息标为已答再重发新提问
    if (node.gate_ask_message_id !== null) {
      messages.markAskAnsweredIn(p, node.gate_ask_message_id);
    }
    db.run(
      `UPDATE task_graph_steps
          SET gate_question = ?,
              gate_options_json = ?,
              gate_summary_md = ?,
              gate_recommended = ?,
              gate_ask_message_id = NULL,
              status = CASE WHEN status = 'waiting' THEN 'pending' ELSE status END,
              waiting_for = NULL,
              updated_at = ?
        WHERE id = ?`,
      gate.question,
      gate.options.length > 0 ? JSON.stringify(gate.options) : null,
      gate.summaryMd,
      gate.recommended,
      t,
      node.id,
    );

    recomputeGraphProgressIn(p, graphRow, caller);
    const graph = loadGraph(graphRow.id)!;
    const updatedNode = graph.nodes.find((n) => n.key === nodeKey)!;
    p.changes.push({ type: "task_graph.updated", data: { graph } });

    return {
      text: isTaskNodeWaitingUser(updatedNode)
        ? `已给任务图 #${graph.id} 的步骤「${nodeKey}」挂上拍板卡，等用户拍板。`
        : `已给任务图 #${graph.id} 的步骤「${nodeKey}」挂上拍板卡（前置步骤都完了时出卡）。`,
      data: { graph, messageId: updatedNode.gateAskMessageId },
    };
  };

  /** hub graph patch [<graphId>] --stdin：增量增删改节点和依赖边，严格保护运行态与已完成节点。 */
  const patchIn = (
    p: Pending,
    caller: AgentSessionRow & { pmId: PmId },
    args: HubArgs<"graph.patch">,
  ): HubResult<"graph.patch"> => {
    assertPmNotArchived(caller.pmId);
    if (typeof args.specJson !== "string" || Buffer.byteLength(args.specJson, "utf8") > MAX_GRAPH_SPEC_BYTES) {
      throw fail("invalid", `patch JSON 不能为空，且不超过 ${MAX_GRAPH_SPEC_BYTES} 字节`);
    }
    let rawObj: unknown;
    try {
      rawObj = JSON.parse(args.specJson);
    } catch {
      throw fail("invalid", "patch 内容不是合法的 JSON");
    }
    const parsed = patchSpecSchema.safeParse(rawObj);
    if (!parsed.success) throw fail("invalid", "patch 字段格式不正确");
    const patch: PatchTaskGraphSpecInput = parsed.data;

    const graphRow = resolveGraphForPm(caller.pmId, { graphId: args.graphId, requireActive: true });
    const existingNodes = db.all<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE graph_id = ? ORDER BY sort_order ASC, id ASC",
      graphRow.id,
    );
    const existingEdges = db.all<TaskEdgeDbRow>(
      "SELECT * FROM task_graph_edges WHERE graph_id = ?",
      graphRow.id,
    );

    const nodesByKey = new Map<TaskNodeKey, TaskNodeDbRow>(existingNodes.map((n) => [n.node_key, n]));
    const removeKeySet = new Set<TaskNodeKey>((patch.removeNodes ?? []).map(validateNodeKey));

    for (const rmKey of removeKeySet) {
      const target = nodesByKey.get(rmKey);
      if (target === undefined) throw fail("not_found", `要删除的节点「${rmKey}」不存在`);
      if (target.status === "running" || target.status === "done" || target.active_worker_id !== null) {
        throw fail(
          "conflict",
          `节点「${rmKey}」${taskNodeStatusText(toTaskNode(target), "pm")}，不允许通过 patch 删除（历史与在跑节点受保护）`,
        );
      }
      nodesByKey.delete(rmKey);
    }

    const addedNodes = (patch.addNodes ?? []).map((n) => {
      const key = validateNodeKey(n.key);
      if (nodesByKey.has(key)) throw fail("conflict", `节点「${key}」已存在`);
      const nodeTitle = validateNodeTitle(n.title);
      const gate = validateGateFields(n);
      return {
        key,
        title: nodeTitle,
        deps: (n.deps ?? []).map(validateNodeKey),
        gate,
      };
    });

    const addedKeySet = new Set<TaskNodeKey>();
    for (const a of addedNodes) {
      if (addedKeySet.has(a.key)) throw fail("invalid", `addNodes 中重复出现了「${a.key}」`);
      addedKeySet.add(a.key);
    }

    // 构造更新后的边集合
    const edgeSet = new Map<string, TaskEdge>();
    for (const e of existingEdges) {
      if (removeKeySet.has(e.from_key) || removeKeySet.has(e.to_key)) continue;
      edgeSet.set(`${e.from_key}\0${e.to_key}`, { fromKey: e.from_key, toKey: e.to_key });
    }
    for (const rm of patch.removeEdges ?? []) {
      const fk = validateNodeKey(rm.from);
      const tk = validateNodeKey(rm.to);
      edgeSet.delete(`${fk}\0${tk}`);
    }
    for (const a of addedNodes) {
      for (const dep of a.deps) {
        edgeSet.set(`${dep}\0${a.key}`, { fromKey: dep, toKey: a.key });
      }
    }
    for (const u of patch.updateNodes ?? []) {
      const uk = validateNodeKey(u.key);
      const target = nodesByKey.get(uk);
      if (target === undefined) throw fail("not_found", `要更新的节点「${uk}」不存在`);
      if (u.deps !== undefined) {
        if (target.status === "running" || target.status === "done") {
          throw fail("conflict", `节点「${uk}」${taskNodeStatusText(toTaskNode(target), "pm")}，不能修改其前置依赖`);
        }
        for (const [sig, edge] of [...edgeSet.entries()]) {
          if (edge.toKey === uk) edgeSet.delete(sig);
        }
        for (const dep of u.deps.map(validateNodeKey)) {
          edgeSet.set(`${dep}\0${uk}`, { fromKey: dep, toKey: uk });
        }
      }
    }
    for (const ae of patch.addEdges ?? []) {
      const fk = validateNodeKey(ae.from);
      const tk = validateNodeKey(ae.to);
      const target = nodesByKey.get(tk);
      if (target !== undefined && (target.status === "running" || target.status === "done")) {
        throw fail("conflict", `节点「${tk}」${taskNodeStatusText(toTaskNode(target), "pm")}，不能向其追加前置依赖`);
      }
      edgeSet.set(`${fk}\0${tk}`, { fromKey: fk, toKey: tk });
    }

    const finalNodeKeys: TaskNodeKey[] = [...nodesByKey.keys(), ...addedNodes.map((a) => a.key)];
    const finalEdges: TaskEdge[] = [...edgeSet.values()];
    const topoOrder = validateDagAndOrder(finalNodeKeys, finalEdges);
    const rankOf = new Map<TaskNodeKey, number>(topoOrder.map((k, idx) => [k, idx]));

    const t = now();
    if (patch.title !== undefined) {
      const nextTitle = validateGraphTitle(patch.title);
      db.run("UPDATE task_graphs SET title = ?, updated_at = ? WHERE id = ?", nextTitle, t, graphRow.id);
    }

    for (const rmKey of removeKeySet) {
      const removed = existingNodes.find((n) => n.node_key === rmKey);
      if (removed?.gate_ask_message_id != null) {
        messages.markAskAnsweredIn(p, removed.gate_ask_message_id);
      }
      db.run("DELETE FROM task_graph_steps WHERE graph_id = ? AND node_key = ?", graphRow.id, rmKey);
    }

    for (const a of addedNodes) {
      db.run(
        `INSERT INTO task_graph_steps (
           graph_id, node_key, title, status, waiting_for, skipped, sort_order,
           active_worker_id, worker_ids_json, artifact_json,
           gate_question, gate_options_json, gate_summary_md, gate_recommended, gate_ask_message_id, decision_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', NULL, 0, ?, NULL, '[]', NULL, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        graphRow.id,
        a.key,
        a.title,
        rankOf.get(a.key) ?? 0,
        a.gate.question,
        a.gate.options.length > 0 ? JSON.stringify(a.gate.options) : null,
        a.gate.summaryMd,
        a.gate.recommended,
        t,
        t,
      );
    }

    for (const u of patch.updateNodes ?? []) {
      const uk = validateNodeKey(u.key);
      const cur = nodesByKey.get(uk)!;
      const nextTitle = u.title !== undefined ? validateNodeTitle(u.title) : cur.title;
      if (u.question !== undefined || u.options !== undefined || u.summaryMd !== undefined || u.recommended !== undefined) {
        // 改拍板卡的内容只允许改没人在干、还没完的步骤；若此前已出过旧卡先收起，再交由 recomputeGraphProgressIn 重算激活或退回
        if (cur.status === "running" || cur.status === "done" || cur.active_worker_id !== null) {
          throw fail("conflict", `步骤「${uk}」${taskNodeStatusText(toTaskNode(cur), "pm")}，不能改它的拍板卡`);
        }
        const gate = validateGateFields({
          question: u.question ?? cur.gate_question ?? undefined,
          options: u.options ?? parseJsonOr<string[] | undefined>(cur.gate_options_json, undefined),
          summaryMd: u.summaryMd ?? cur.gate_summary_md ?? undefined,
          recommended: u.recommended ?? cur.gate_recommended ?? undefined,
        });
        if (cur.gate_ask_message_id !== null) {
          messages.markAskAnsweredIn(p, cur.gate_ask_message_id);
        }
        db.run(
          `UPDATE task_graph_steps
              SET title = ?,
                  gate_question = ?,
                  gate_options_json = ?,
                  gate_summary_md = ?,
                  gate_recommended = ?,
                  gate_ask_message_id = NULL,
                  status = CASE WHEN status = 'waiting' THEN 'pending' ELSE status END,
                  waiting_for = NULL,
                  updated_at = ?
            WHERE id = ?`,
          nextTitle,
          gate.question,
          gate.options.length > 0 ? JSON.stringify(gate.options) : null,
          gate.summaryMd,
          gate.recommended,
          t,
          cur.id,
        );
      } else {
        db.run("UPDATE task_graph_steps SET title = ?, updated_at = ? WHERE id = ?", nextTitle, t, cur.id);
      }
    }

    for (const skRaw of patch.skipNodes ?? []) {
      const sk = validateNodeKey(skRaw);
      const cur = nodesByKey.get(sk);
      if (cur === undefined) throw fail("not_found", `要跳过的节点「${sk}」不存在`);
      if (cur.status === "done" || cur.status === "running" || cur.active_worker_id !== null) {
        throw fail("conflict", `节点「${sk}」${taskNodeStatusText(toTaskNode(cur), "pm")}，无法跳过`);
      }
      db.run("UPDATE task_graph_steps SET status = 'done', waiting_for = NULL, skipped = 1, updated_at = ? WHERE id = ?", t, cur.id);
      if (cur.gate_ask_message_id !== null) {
        messages.markAskAnsweredIn(p, cur.gate_ask_message_id);
      }
    }

    for (const [k, idx] of rankOf) {
      db.run("UPDATE task_graph_steps SET sort_order = ? WHERE graph_id = ? AND node_key = ?", idx, graphRow.id, k);
    }

    const wasAllSettled = existingNodes.length > 0 && existingNodes.every((n) => n.status === "done");

    db.run("DELETE FROM task_graph_edges WHERE graph_id = ?", graphRow.id);
    for (const e of finalEdges) {
      db.run("INSERT INTO task_graph_edges (graph_id, from_key, to_key) VALUES (?, ?, ?)", graphRow.id, e.fromKey, e.toKey);
    }

    const refreshedRow = getGraphRow(graphRow.id)!;
    const turned = recomputeGraphProgressIn(p, refreshedRow, caller);
    syncDeliveryNoteAfterProgressIn(p, refreshedRow, wasAllSettled);
    const graph = loadGraph(graphRow.id)!;
    p.changes.push({ type: "task_graph.updated", data: { graph } });
    const progressNote = unlockedNoteOf(turned, graph).replace(/^；/u, "");
    return {
      text: `已更新${formatGraphText(graph)}${progressNote !== "" ? `\n${progressNote}` : ""}`,
      data: { graph },
    };
  };

  /**
   * hub graph done <nodeKey>：项目经理放行（第 3.2 节第 11 行）：把没轮到、等人的步骤标完了并记录产物摘要，或给完了的步骤补记结果；
   * 有 Worker 在干（running）的拒绝，先收工。挂着没点的拍板卡一并收起。
   */
  const doneIn = (
    p: Pending,
    caller: AgentSessionRow & { pmId: PmId },
    args: HubArgs<"graph.done">,
  ): HubResult<"graph.done"> => {
    assertPmNotArchived(caller.pmId);
    const nodeKey = validateNodeKey(args.nodeKey);
    const graphRow = resolveGraphForPm(caller.pmId, { graphId: args.graphId, nodeKey, requireActive: false });
    const node = db.get<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE graph_id = ? AND node_key = ?",
      graphRow.id,
      nodeKey,
    );
    if (node === undefined) throw fail("not_found", `任务图 #${graphRow.id} 中没有节点「${nodeKey}」`);
    if (graphRow.status !== "active" && !(graphRow.status === "completed" && node.status === "done")) {
      throw fail("conflict", `任务图 #${graphRow.id} 已经结束（${graphRow.status}）`);
    }
    // 在干的节点不能绕过 Worker 直接标完成（它还在改东西，下游会基于没做完的结果开工）：先让 Worker 收工，节点由收工时的汇报决定
    if (node.status === "running") {
      const who = node.active_worker_id === null ? "Worker" : `Worker #${node.active_worker_id}`;
      const end = node.active_worker_id === null ? `${HUB_COMMAND} worker end <编号>` : `${HUB_COMMAND} worker end ${node.active_worker_id}`;
      throw fail(
        "conflict",
        `节点「${nodeKey}」正在由 ${who} 执行，不能直接标完成。先用 ${end} 让它收工：它最近一轮汇报是“做完了”时节点会自动标完成；要补记 PR 等结果，收工后再调 ${HUB_COMMAND} graph done ${nodeKey} --graph ${graphRow.id}`,
      );
    }

    const summary = args.summary?.trim();
    if (summary !== undefined && charLen(summary) > MAX_NODE_ARTIFACT_SUMMARY_CHARS) {
      throw fail("invalid", `节点产物摘要最多 ${MAX_NODE_ARTIFACT_SUMMARY_CHARS} 字`);
    }
    const existingArtifact = parseJsonOr<TaskArtifact>(node.artifact_json, {});
    const artifact: TaskArtifact = {
      ...existingArtifact,
      ...(args.prUrl?.trim() ? { prUrl: args.prUrl.trim() } : {}),
      ...(args.commit?.trim() ? { commit: args.commit.trim() } : {}),
      ...(args.branch?.trim() ? { branch: args.branch.trim() } : {}),
      ...(summary ? { summary } : {}),
    };

    const wasAllSettled = graphRow.status === "active" && isGraphAllSettled(graphRow.id);
    const t = now();
    // 已经完了（包括跳过的）只补记结果，不改“是不是跳过的”
    db.run(
      `UPDATE task_graph_steps
          SET status = 'done',
              waiting_for = NULL,
              active_worker_id = NULL,
              artifact_json = ?,
              updated_at = ?
        WHERE id = ?`,
      Object.keys(artifact).length > 0 ? JSON.stringify(artifact) : null,
      t,
      node.id,
    );
    if (node.status !== "done" && node.gate_ask_message_id !== null && node.decision_json === null) {
      messages.markAskAnsweredIn(p, node.gate_ask_message_id);
    }

    const unlocked = graphRow.status === "active" ? recomputeGraphProgressIn(p, graphRow, caller) : [];
    if (graphRow.status === "active") syncDeliveryNoteAfterProgressIn(p, graphRow, wasAllSettled);
    const graph = loadGraph(graphRow.id)!;
    p.changes.push({ type: "task_graph.updated", data: { graph } });

    return {
      text: `节点「${nodeKey}」已标记为完了${unlockedNoteOf(unlocked, graph)}`,
      data: { graph },
    };
  };

  /** hub graph decide <nodeKey>：用户在对话里口头明确拍板后，项目经理把定案记在步骤上，步骤完了，下游轮到（第 3.2 节第 11 行）。 */
  const decideIn = (
    p: Pending,
    caller: AgentSessionRow & { pmId: PmId },
    args: HubArgs<"graph.decide">,
  ): HubResult<"graph.decide"> => {
    assertPmNotArchived(caller.pmId);
    const nodeKey = validateNodeKey(args.nodeKey);
    const choice = args.choice.trim();
    if (choice === "" || charLen(choice) > MAX_DECISION_CHOICE_CHARS) {
      throw fail("invalid", `定案选项不能为空，且最多 ${MAX_DECISION_CHOICE_CHARS} 字`);
    }
    const note = args.note?.trim() || null;
    if (note !== null && charLen(note) > MAX_DECISION_NOTE_CHARS) {
      throw fail("invalid", `补充说明最多 ${MAX_DECISION_NOTE_CHARS} 字`);
    }

    const graphRow = resolveGraphForPm(caller.pmId, { graphId: args.graphId, nodeKey, requireActive: true });
    const node = db.get<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE graph_id = ? AND node_key = ?",
      graphRow.id,
      nodeKey,
    );
    if (node === undefined) throw fail("not_found", `任务图 #${graphRow.id} 中没有节点「${nodeKey}」`);
    if (node.status === "done") {
      const graph = loadGraph(graphRow.id)!;
      return { text: `步骤「${nodeKey}」此前已经完了。`, data: { graph } };
    }
    // 定案交给在干的 Worker 接着干是第 6 步（hub ask --node）的事；现在只记在没人在干的步骤上
    if (node.status === "running" || node.active_worker_id !== null) {
      throw fail(
        "conflict",
        `步骤「${nodeKey}」有 Worker #${node.active_worker_id ?? "?"} 挂着，不能直接记定案：用 ${HUB_COMMAND} worker send 把用户的答复告诉它`,
      );
    }

    const wasAllSettled = isGraphAllSettled(graphRow.id);
    const t = now();
    const decision: TaskDecision = {
      choice,
      note,
      decidedBy: "pm",
      decidedAt: t,
    };
    db.run(
      "UPDATE task_graph_steps SET status = 'done', waiting_for = NULL, decision_json = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(decision),
      t,
      node.id,
    );
    if (node.gate_ask_message_id !== null) {
      messages.markAskAnsweredIn(p, node.gate_ask_message_id, choice);
    }

    const unlocked = recomputeGraphProgressIn(p, graphRow, caller);
    syncDeliveryNoteAfterProgressIn(p, graphRow, wasAllSettled);
    const graph = loadGraph(graphRow.id)!;
    p.changes.push({ type: "task_graph.updated", data: { graph } });

    return {
      text: `步骤「${nodeKey}」已记录定案「${choice}」${unlockedNoteOf(unlocked, graph)}`,
      data: { graph },
    };
  };

  /**
   * 内部共用跳过节点逻辑（供 CLI hub graph skip 与界面 POST /skip 共用）：没轮到、等人的步骤变完了（skipped），
   * 只跳过它自己，下游在所有前置完了后照常轮到。byUser（网页上用户点的）时，轮到的手动步骤叫醒项目经理（第 3.2 节第 12、3 行）。
   */
  const skipNodeInternalIn = (
    p: Pending,
    graphRow: TaskGraphDbRow,
    nodeKey: TaskNodeKey,
    reason: string | undefined,
    byUser: boolean,
  ): { graph: TaskGraph; messageId: MessageId | null; turned: TurnedStep[] } => {
    if (graphRow.status !== "active") throw fail("conflict", `任务图 #${graphRow.id} 已经结束（${graphRow.status}）`);
    const node = db.get<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE graph_id = ? AND node_key = ?",
      graphRow.id,
      nodeKey,
    );
    if (node === undefined) throw fail("not_found", `任务图 #${graphRow.id} 中没有节点「${nodeKey}」`);
    if (node.status === "done") {
      if (node.skipped === 1) return { graph: loadGraph(graphRow.id)!, messageId: null, turned: [] };
      throw fail("conflict", `节点「${nodeKey}」已经完了，不能跳过`);
    }
    if (node.status === "running" || node.active_worker_id !== null) {
      throw fail("conflict", `节点「${nodeKey}」正在由 Worker #${node.active_worker_id} 执行，请先收工再跳过`);
    }

    const wasAllSettled = isGraphAllSettled(graphRow.id);
    const t = now();
    const trimmedReason = reason?.trim();
    const artifact: TaskArtifact | null = trimmedReason ? { summary: `已跳过：${trimmedReason}` } : parseJsonOr<TaskArtifact | null>(node.artifact_json, null);
    db.run(
      "UPDATE task_graph_steps SET status = 'done', waiting_for = NULL, skipped = 1, artifact_json = ?, updated_at = ? WHERE id = ?",
      artifact === null ? null : JSON.stringify(artifact),
      t,
      node.id,
    );
    if (node.gate_ask_message_id !== null) {
      messages.markAskAnsweredIn(p, node.gate_ask_message_id);
    }

    const turned = recomputeGraphProgressIn(p, graphRow);
    syncDeliveryNoteAfterProgressIn(p, graphRow, wasAllSettled);
    const messageId = byUser
      ? wakePmForTurnedIn(p, graphRow, turned, `用户在网页上跳过了步骤「${nodeKey}（${node.title}）」${trimmedReason ? `（说明：${trimmedReason}）` : ""}，`, `skip:${nodeKey}:${t}`)
      : null;
    const graph = loadGraph(graphRow.id)!;
    p.changes.push({ type: "task_graph.updated", data: { graph } });

    return { graph, messageId, turned };
  };

  /** hub graph skip <nodeKey> */
  const skipIn = (
    p: Pending,
    caller: AgentSessionRow & { pmId: PmId },
    args: HubArgs<"graph.skip">,
  ): HubResult<"graph.skip"> => {
    assertPmNotArchived(caller.pmId);
    const nodeKey = validateNodeKey(args.nodeKey);
    const graphRow = resolveGraphForPm(caller.pmId, { graphId: args.graphId, nodeKey, requireActive: true });
    const { graph, turned } = skipNodeInternalIn(p, graphRow, nodeKey, args.reason, false);
    return {
      text: `已跳过节点「${nodeKey}」${unlockedNoteOf(turned, graph)}\n${formatGraphText(graph)}`,
      data: { graph },
    };
  };

  /** 内部共用取消整张图逻辑。 */
  const cancelGraphInternalIn = (
    p: Pending,
    graphRow: TaskGraphDbRow,
    reason: string | undefined,
    wakePm: boolean,
  ): { graph: TaskGraph; messageId: MessageId | null } => {
    if (graphRow.status === "cancelled") {
      return { graph: loadGraph(graphRow.id)!, messageId: null };
    }
    if (graphRow.status === "completed") {
      throw fail("conflict", `任务图 #${graphRow.id} 已经全部完成，无需取消`);
    }

    const t = now();
    const waitingNodes = db.all<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE graph_id = ? AND gate_ask_message_id IS NOT NULL",
      graphRow.id,
    );
    for (const n of waitingNodes) {
      if (n.gate_ask_message_id !== null) messages.markAskAnsweredIn(p, n.gate_ask_message_id);
    }
    db.run(
      "UPDATE task_graph_steps SET active_worker_id = NULL, updated_at = ? WHERE graph_id = ? AND active_worker_id IS NOT NULL",
      t,
      graphRow.id,
    );
    db.run(
      "UPDATE task_graphs SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?",
      t,
      t,
      graphRow.id,
    );
    stopQueuedDeliveryNotesIn(p, graphRow.conversation_id, graphRow.id);

    const graph = loadGraph(graphRow.id)!;
    p.changes.push({ type: "task_graph.updated", data: { graph } });

    let messageId: MessageId | null = null;
    if (wakePm) {
      const trimmedReason = reason?.trim();
      const wake = messages.enqueueWakeupUserMessageIn(p, {
        conversationId: graph.conversationId,
        dedupeKey: userMessageDedupeKey(graph.conversationId, `graph-cancel:${graph.id}:${t}`),
        text: `【任务图 #${graph.id} · ${graph.title}】用户取消了整张任务图${trimmedReason ? `（说明：${trimmedReason}）` : ""}。若有关联 Worker 仍在运行，请按需收工。`,
      });
      messageId = wake.id;
    }

    return { graph, messageId };
  };

  /** hub graph cancel [<graphId>] */
  const cancelIn = (
    p: Pending,
    caller: AgentSessionRow & { pmId: PmId },
    args: HubArgs<"graph.cancel">,
  ): HubResult<"graph.cancel"> => {
    assertPmNotArchived(caller.pmId);
    const graphRow = resolveGraphForPm(caller.pmId, { graphId: args.graphId, requireActive: true });
    const { graph } = cancelGraphInternalIn(p, graphRow, args.reason, false);
    return {
      text: `已取消任务图 #${graph.id}「${graph.title}」。`,
      data: { graph },
    };
  };

  /**
   * hub graph finish [<graphId>] [--unmerged-ok] --stdin：
   * 唯一的任务图正常结束出口——所有节点必须已处于终态（done / skipped），默认拦截分支上仍处于 OPEN 的 PR，
   * 结束图（标 completed）并在同一事务里将交付摘要同步投递到总助汇报流。
   */
  const finishIn = (
    p: Pending,
    caller: AgentSessionRow & { pmId: PmId },
    args: HubArgs<"graph.finish">,
    context?: HubCallContext,
  ): HubResult<"graph.finish"> => {
    assertPmNotArchived(caller.pmId);
    const summary = typeof args.summary === "string" ? args.summary.trim() : "";
    if (summary === "") {
      throw fail("invalid", "交付摘要不能是空的（用 --stdin 传入交付摘要）");
    }

    const graphRow = resolveGraphForPm(caller.pmId, { graphId: args.graphId, requireActive: true });
    const nodeRows = db.all<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE graph_id = ? ORDER BY sort_order ASC, id ASC",
      graphRow.id,
    );
    const unsettled = nodeRows.filter((n) => n.status !== "done");
    if (nodeRows.length === 0 || unsettled.length > 0) {
      const listText = unsettled.map((n) => `${n.node_key} [${taskNodeStatusText(toTaskNode(n), "pm")}]`).join("、");
      throw fail(
        "conflict",
        `任务图 #${graphRow.id} 还有未完成的节点：${listText}。所有节点完成后才能 ${HUB_COMMAND} graph finish；若要中途放弃整张图，请用 ${HUB_COMMAND} graph cancel ${graphRow.id}`,
      );
    }

    const branches = collectGraphBranches(graphRow);
    const graphPrs = context?.graphPrs;
    if (args.unmergedOk !== true && graphPrs !== undefined) {
      // 按分支查到的和按手工补记网址查到的可能是同一个 PR，按网址去重后一起列出
      const openPrs = new Map<string, string>();
      const noteOpen = (pr: WorkerPr | undefined, where: string) => {
        if (pr === undefined || pr.state.toUpperCase() !== "OPEN" || openPrs.has(pr.url)) return;
        openPrs.set(pr.url, `${where}：PR #${pr.number}（${pr.url}）`);
      };
      for (const b of branches) noteOpen(graphPrs[b.branch], `节点「${b.nodeKey}」分支 ${b.branch}`);
      for (const u of collectGraphPrUrls(graphRow)) noteOpen(graphPrs[u.prUrl], `节点「${u.nodeKey}」补记的 PR`);
      if (openPrs.size > 0) {
        const listText = [...openPrs.values()].join("；");
        throw fail(
          "conflict",
          `任务图 #${graphRow.id} 还有未合并（OPEN）的 PR：${listText}。请合并后再调 ${HUB_COMMAND} graph finish ${graphRow.id} --stdin；若确认不合并直接结束，请加 --unmerged-ok`,
        );
      }
    }

    // 收集图上各已完成节点的 PR 链接，随汇报卡一起带进总助（去重并受 ROUTER_REPORT_LINKS_MAX 约束）
    const seenTargets = new Set<string>();
    const links: RouterReportLink[] = [];
    const pushLink = (label: string, target: string) => {
      const l = truncateChars(label.trim(), ROUTER_REPORT_LINK_LABEL_MAX_CHARS);
      const u = target.trim();
      if (l === "" || u === "" || seenTargets.has(u)) return;
      if (charLen(u) > ROUTER_REPORT_LINK_TARGET_MAX_CHARS) return;
      if (links.length >= ROUTER_REPORT_LINKS_MAX) return;
      seenTargets.add(u);
      links.push({ label: l, target: u });
    };
    for (const b of branches) {
      const pr = graphPrs?.[b.branch];
      if (pr?.url) pushLink(`PR #${pr.number}`, pr.url);
    }
    for (const n of nodeRows) {
      if (n.status !== "done" || n.skipped === 1) continue;
      const artifact = parseJsonOr<TaskArtifact | null>(n.artifact_json, null);
      if (artifact?.prUrl) pushLink(`${n.node_key} PR`, artifact.prUrl);
    }

    const report = router.reportIn(p, caller, {
      summary,
      ...(links.length > 0 ? { links } : {}),
    });

    const t = now();
    db.run(
      "UPDATE task_graphs SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
      t,
      t,
      graphRow.id,
    );
    stopQueuedDeliveryNotesIn(p, graphRow.conversation_id, graphRow.id);

    const graph = loadGraph(graphRow.id)!;
    p.changes.push({ type: "task_graph.updated", data: { graph } });

    return {
      text: `任务图 #${graph.id}「${graph.title}」已结束（completed），交付摘要已同步至总助（汇报 #${report.data.item.id}）。`,
      data: { graph, reportItem: report.data.item },
    };
  };

  /** agent 接口在 graph.finish 前只读查询需要探 PR 的目标：各分支（gh pr list --head），以及手工补记的 PR 网址（gh pr view）。 */
  const graphPrTargets = (
    caller: AgentSessionRow | null,
    graphId?: TaskGraphId,
  ): GraphPrTarget[] => {
    if (caller === null || caller.role !== "pm" || caller.pmId === null) return [];
    let graphRow: TaskGraphDbRow | undefined;
    if (graphId !== undefined) {
      const row = getGraphRow(graphId);
      if (row === undefined || row.pm_id !== caller.pmId || row.status !== "active") return [];
      graphRow = row;
    } else {
      const activeRows = db.all<TaskGraphDbRow>(
        "SELECT * FROM task_graphs WHERE pm_id = ? AND status = 'active' ORDER BY id DESC",
        caller.pmId,
      );
      if (activeRows.length !== 1) return [];
      graphRow = activeRows[0]!;
    }
    return [
      ...collectGraphBranches(graphRow).map(({ cwd, branch }) => ({ cwd, branch })),
      ...collectGraphPrUrls(graphRow).map(({ cwd, prUrl }) => ({ cwd, prUrl })),
    ];
  };

  /** session.send 处理函数在发送交付单前只读查询需异步探测 git diff 与 PR 的目标。 */
  const graphDeliveryProbeTarget = (
    messageId: MessageId,
  ): {
    graphId: TaskGraphId;
    repoFolder: string | null;
    branches: Array<{ branch: string; cwd: string; baseCommit: string | null }>;
  } | null => {
    const msg = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", messageId);
    if (msg === undefined || msg.sender !== "system" || msg.status !== "queued") return null;
    const meta = parseJsonOr<Record<string, unknown> | null>(msg.meta, null);
    if (meta?.event !== "task_graph.ready_to_finish" || meta.diffProbed === true || typeof meta.graphId !== "number") {
      return null;
    }
    const graphRow = getGraphRow(meta.graphId);
    if (graphRow === undefined || graphRow.status !== "active") return null;
    const repoFolder = mainFolderOf(graphRow.project_id);
    const branches = collectGraphBranches(graphRow).map(({ branch, cwd, baseCommit }) => ({ branch, cwd, baseCommit }));
    return { graphId: graphRow.id, repoFolder, branches };
  };

  /** session.send 处理函数将异步探得的改动文件名单与 PR 状态写回交付单消息正文。 */
  const enrichDeliveryNoteMessage = (
    messageId: MessageId,
    input: {
      files?: ReadonlyArray<{ file: string; added: number | null; deleted: number | null }>;
      prs?: Readonly<Record<string, WorkerPr>>;
    },
  ): void => {
    write((p) => {
      const msg = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", messageId);
      // 探测在事务外跑，期间图可能已 finish / cancel / 打回（交付单被收起），这时不再改写已收起的消息
      if (msg === undefined || msg.sender !== "system" || msg.status !== "queued") return;
      const meta = parseJsonOr<Record<string, unknown> | null>(msg.meta, null);
      if (meta?.event !== "task_graph.ready_to_finish" || meta.diffProbed === true || typeof meta.graphId !== "number") return;
      const graph = loadGraph(meta.graphId);
      if (graph === null) return;
      const nextText = formatDeliveryNote(graph, input);
      const nextMeta: SystemMessageMeta = {
        event: "task_graph.ready_to_finish",
        graphId: meta.graphId,
        seq: typeof meta.seq === "number" ? meta.seq : 1,
        diffProbed: true,
      };
      db.run(
        "UPDATE messages SET text = ?, meta = ?, updated_at = ? WHERE id = ?",
        nextText,
        JSON.stringify(nextMeta),
        now(),
        messageId,
      );
      p.changes.push({
        type: "message.updated",
        data: { message: toMessage(db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", messageId)!) },
      });
    });
  };

  // ---- Web UI / Router 同源门禁接口 ----

  const gateDecideWakeupKey = (
    conversationId: ConversationId,
    graphId: TaskGraphId,
    nodeKey: TaskNodeKey,
    clientId: string,
  ): string => userMessageDedupeKey(conversationId, `gate-decide:${graphId}:${nodeKey}:${clientId}`);

  /**
   * POST /api/task-graphs/:graphId/nodes/:nodeKey/decide：
   * 用户在 Router 顶栏、右栏流图或对话卡片点击拍板按钮，单事务完成：
   * 挂卡的步骤（等人）-> 完了、下游轮到、标记 AskMeta.answered = true、插入用户拍板消息唤醒 PM（轮到的手动步骤写在同一条里），按 clientId 严格幂等。
   * 定案直接交给这一步的 Worker、不叫醒 PM 是第 6 步的事。
   */
  const decideNode = (
    graphId: TaskGraphId,
    rawNodeKey: TaskNodeKey,
    input: DecideTaskNodeRequest,
  ): DecideTaskNodeResponse =>
    write((p) => {
      const clientId = input.clientId.trim();
      if (clientId === "") throw fail("invalid", "缺少 clientId");
      const nodeKey = validateNodeKey(rawNodeKey);

      const graphRow = getGraphRow(graphId);
      if (graphRow === undefined) throw fail("not_found", `没有编号 #${graphId} 的任务图`);
      const node = db.get<TaskNodeDbRow>(
        "SELECT * FROM task_graph_steps WHERE graph_id = ? AND node_key = ?",
        graphId,
        nodeKey,
      );
      if (node === undefined) throw fail("not_found", `任务图 #${graphId} 中没有节点「${nodeKey}」`);

      if (graphRow.status === "cancelled") {
        throw fail("conflict", `任务图 #${graphId} 已结束（cancelled）`);
      }

      if (node.status === "done") {
        const existingDec = parseJsonOr<TaskDecision | null>(node.decision_json, null);
        if (existingDec?.clientId === clientId) {
          const dedupeKey = gateDecideWakeupKey(graphRow.conversation_id, graphId, nodeKey, clientId);
          const existingMsg = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", dedupeKey);
          return {
            graph: loadGraph(graphId)!,
            messageId: existingMsg?.id ?? null,
          };
        }
        throw fail("conflict", `步骤「${nodeKey}」已经完了`);
      }

      if (graphRow.status !== "active") {
        throw fail("conflict", `任务图 #${graphId} 已结束（${graphRow.status}）`);
      }
      if (node.status !== "waiting" || node.active_worker_id !== null) {
        throw fail("conflict", `步骤「${nodeKey}」${taskNodeStatusText(toTaskNode(node), "user")}，现在不能拍板`);
      }

      assertPmNotArchived(graphRow.pm_id);

      const choice = input.choice !== undefined && input.choice !== null && input.choice.trim() !== "" ? input.choice.trim() : null;
      const note = input.note !== undefined && input.note !== null && input.note.trim() !== "" ? input.note.trim() : null;
      if (choice === null && note === null) {
        throw fail("invalid", "请至少选择一个方案或填写拍板意见");
      }
      if (choice !== null && charLen(choice) > MAX_DECISION_CHOICE_CHARS) {
        throw fail("invalid", `所选方案最多 ${MAX_DECISION_CHOICE_CHARS} 字`);
      }
      if (note !== null && charLen(note) > MAX_DECISION_NOTE_CHARS) {
        throw fail("invalid", `补充说明最多 ${MAX_DECISION_NOTE_CHARS} 字`);
      }
      const gateOptions = parseJsonOr<string[]>(node.gate_options_json, []);
      if (choice !== null && gateOptions.length > 0 && !gateOptions.includes(choice)) {
        throw fail("invalid", `所选方案「${choice}」不在拍板卡的选项中`);
      }

      const wasAllSettled = isGraphAllSettled(graphRow.id);
      const t = now();
      const decision: TaskDecision = {
        choice,
        note,
        decidedBy: "user",
        decidedAt: t,
        clientId,
      };
      db.run(
        "UPDATE task_graph_steps SET status = 'done', waiting_for = NULL, decision_json = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(decision),
        t,
        node.id,
      );

      if (node.gate_ask_message_id !== null) {
        messages.markAskAnsweredIn(p, node.gate_ask_message_id, choice ?? undefined);
      }

      const unlocked = recomputeGraphProgressIn(p, graphRow);
      syncDeliveryNoteAfterProgressIn(p, graphRow, wasAllSettled);
      const graph = loadGraph(graphId)!;

      const wakeLines = [`【任务图 #${graph.id}「${graph.title}」用户拍板】步骤「${nodeKey}（${node.title}）」`];
      if (choice !== null) wakeLines.push(`定案：${choice}`);
      if (note !== null) wakeLines.push(`补充说明：${note}`);
      if (unlocked.length > 0) {
        wakeLines.push(`轮到了：${turnedListText(unlocked)}`);
        const forPm = unlocked.find((u) => u.waitingFor === "pm");
        if (forPm !== undefined) {
          wakeLines.push(`给它派 Worker 用 ${HUB_COMMAND} worker start --node ${forPm.key} --graph ${graph.id}`);
        }
      }
      const wakeMsg = messages.enqueueWakeupUserMessageIn(p, {
        conversationId: graph.conversationId,
        dedupeKey: gateDecideWakeupKey(graph.conversationId, graphId, nodeKey, clientId),
        text: wakeLines.join("\n"),
      });

      p.changes.push({ type: "task_graph.updated", data: { graph } });
      return { graph, messageId: wakeMsg.id };
    });

  /** POST /api/task-graphs/:graphId/nodes/:nodeKey/skip */
  const skipNode = (
    graphId: TaskGraphId,
    rawNodeKey: TaskNodeKey,
    input: SkipTaskNodeRequest,
  ): SkipTaskNodeResponse =>
    write((p) => {
      const nodeKey = validateNodeKey(rawNodeKey);
      const graphRow = getGraphRow(graphId);
      if (graphRow === undefined) throw fail("not_found", `没有编号 #${graphId} 的任务图`);
      assertPmNotArchived(graphRow.pm_id);
      const { graph, messageId } = skipNodeInternalIn(p, graphRow, nodeKey, input.reason, true);
      return { graph, messageId };
    });

  /** POST /api/task-graphs/:graphId/cancel */
  const cancelGraph = (graphId: TaskGraphId, input: CancelTaskGraphRequest): CancelTaskGraphResponse =>
    write((p) => {
      const graphRow = getGraphRow(graphId);
      if (graphRow === undefined) throw fail("not_found", `没有编号 #${graphId} 的任务图`);
      assertPmNotArchived(graphRow.pm_id);
      return cancelGraphInternalIn(p, graphRow, input.reason, true);
    });

  /** GET /api/projects/:id/task-graphs：按 idx_task_graphs_project_history 倒序分页读取已完结/已取消历史任务图。 */
  const listProjectHistory = (
    projectId: ProjectId,
    beforeId?: TaskGraphId,
    limit?: number,
  ): TaskGraphsPage => {
    const take = Math.max(1, Math.min(limit ?? GRAPH_HISTORY_PAGE_SIZE, 50));
    const rows =
      beforeId === undefined
        ? db.all<TaskGraphDbRow>(
            `SELECT * FROM task_graphs
              WHERE project_id = ? AND status != 'active'
              ORDER BY id DESC
              LIMIT ?`,
            projectId,
            take + 1,
          )
        : db.all<TaskGraphDbRow>(
            `SELECT * FROM task_graphs
              WHERE project_id = ? AND status != 'active' AND id < ?
              ORDER BY id DESC
              LIMIT ?`,
            projectId,
            beforeId,
            take + 1,
          );
    const hasMore = rows.length > take;
    const graphs = hydrateGraphs(rows.slice(0, take));
    return { graphs, hasMore };
  };

  // ---- Worker 绑定与状态联动钩子 ----

  /**
   * hub worker start --node 派活前校验目标步骤：等项目经理（轮到了的手动步骤、出了问题停着的）、完了（支持待交付时打回重派），
   * 或者还有 Worker 挂着（在干、或停着等人）——这时是换人：workers.ts 先把挂着的那个按“没做完”收工（同 --incomplete），再派新的。
   * 没轮到的、挂着拍板卡等用户的不能派。
   */
  const prepareWorkerBind = (
    pmId: PmId,
    rawNodeKey: TaskNodeKey,
    graphId?: TaskGraphId,
  ): WorkerBindTarget => {
    const nodeKey = validateNodeKey(rawNodeKey);
    const graphRow = resolveGraphForPm(pmId, { graphId, nodeKey, requireActive: true });
    const nodes = db.all<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE graph_id = ? ORDER BY sort_order ASC, id ASC",
      graphRow.id,
    );
    const index = nodes.findIndex((n) => n.node_key === nodeKey);
    const node = nodes[index];
    if (node === undefined) throw fail("not_found", `任务图 #${graphRow.id} 中没有节点「${nodeKey}」`);
    const replacing = node.active_worker_id !== null;
    const dispatchable = node.status === "done" ? node.skipped === 0 : node.status === "waiting" && node.waiting_for === "pm";
    if (!replacing && !dispatchable) {
      throw fail(
        "conflict",
        `节点「${nodeKey}」${taskNodeStatusText(toTaskNode(node), "pm")}（等你处理、已经完了要打回，或者有 Worker 挂着要换人，才能派 Worker）`,
      );
    }
    return {
      graphId: graphRow.id,
      nodeKey,
      graphTitle: graphRow.title,
      nodeTitle: node.title,
      index: index + 1,
      total: nodes.length,
      activeWorkerId: node.active_worker_id,
      workerIds: parseJsonOr<WorkerId[]>(node.worker_ids_json, []),
    };
  };

  /** Worker 已入库：绑定到节点并置为 running，保留完整历史 workerIds 轨迹；若从 done 打回重派则重算下游并停掉排队中的旧交付单。 */
  const bindWorkerStartedIn = (p: Pending, target: WorkerBindTarget, workerId: WorkerId): void => {
    const node = db.get<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE graph_id = ? AND node_key = ?",
      target.graphId,
      target.nodeKey,
    );
    if (node === undefined) return;
    const wasDone = node.status === "done";
    const prevIds = parseJsonOr<WorkerId[]>(node.worker_ids_json, []);
    const nextIds = prevIds.includes(workerId) ? prevIds : [...prevIds, workerId];
    const t = now();
    db.run(
      `UPDATE task_graph_steps
          SET status = 'running',
              waiting_for = NULL,
              skipped = 0,
              active_worker_id = ?,
              worker_ids_json = ?,
              updated_at = ?
        WHERE id = ?`,
      workerId,
      JSON.stringify(nextIds),
      t,
      node.id,
    );
    if (wasDone) {
      const graphRow = getGraphRow(target.graphId);
      if (graphRow !== undefined && graphRow.status === "active") {
        recomputeGraphProgressIn(p, graphRow);
        stopQueuedDeliveryNotesIn(p, graphRow.conversation_id, graphRow.id);
      } else {
        db.run("UPDATE task_graphs SET updated_at = ? WHERE id = ?", t, target.graphId);
      }
    } else {
      db.run("UPDATE task_graphs SET updated_at = ? WHERE id = ?", t, target.graphId);
    }
    const graph = loadGraph(target.graphId);
    if (graph !== null) p.changes.push({ type: "task_graph.updated", data: { graph } });
  };

  /** Worker 汇报“有问题/放弃了”、turn_failed 或 worktree_failed 时，绑定的步骤变等人（等项目经理，第 3.2 节第 6 行；叫醒由 workers.ts 的汇报行负责）。 */
  const onWorkerAttentionIn = (
    p: Pending,
    workerId: WorkerId,
    opts: { clearActiveWorker: boolean },
  ): void => {
    const node = db.get<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE active_worker_id = ?",
      workerId,
    );
    if (node === undefined) return;
    const graphRow = getGraphRow(node.graph_id);
    if (graphRow === undefined || graphRow.status !== "active") return;
    const t = now();
    db.run(
      `UPDATE task_graph_steps
          SET status = 'waiting',
              waiting_for = 'pm',
              active_worker_id = ?,
              updated_at = ?
        WHERE id = ?`,
      opts.clearActiveWorker ? null : node.active_worker_id,
      t,
      node.id,
    );
    db.run("UPDATE task_graphs SET updated_at = ? WHERE id = ?", t, graphRow.id);
    const graph = loadGraph(graphRow.id);
    if (graph !== null) p.changes.push({ type: "task_graph.updated", data: { graph } });
  };

  /** 项目经理向等它处理的步骤上挂着的 Worker、或刚完了但还没收工的 Worker 追加指令（hub worker send）时，步骤回到在干（第 3.2 节第 7、13 行）。 */
  const onWorkerResumedIn = (p: Pending, workerId: WorkerId): void => {
    const attnNode = db.get<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE active_worker_id = ? AND status = 'waiting' AND waiting_for = 'pm'",
      workerId,
    );
    if (attnNode !== undefined) {
      const graphRow = getGraphRow(attnNode.graph_id);
      if (graphRow === undefined || graphRow.status !== "active") return;
      const t = now();
      db.run("UPDATE task_graph_steps SET status = 'running', waiting_for = NULL, updated_at = ? WHERE id = ?", t, attnNode.id);
      db.run("UPDATE task_graphs SET updated_at = ? WHERE id = ?", t, graphRow.id);
      const graph = loadGraph(graphRow.id);
      if (graph !== null) p.changes.push({ type: "task_graph.updated", data: { graph } });
      return;
    }
    const candidates = db.all<TaskNodeDbRow>(
      `SELECT n.* FROM task_graph_steps n
         JOIN task_graphs g ON g.id = n.graph_id
        WHERE g.status = 'active' AND n.status = 'done' AND n.skipped = 0 AND n.active_worker_id IS NULL`,
    );
    const reopened = candidates.find((c) => {
      const ids = parseJsonOr<WorkerId[]>(c.worker_ids_json, []);
      return ids[ids.length - 1] === workerId;
    });
    if (reopened === undefined) return;
    const graphRow = getGraphRow(reopened.graph_id);
    if (graphRow === undefined || graphRow.status !== "active") return;
    const t = now();
    db.run(
      "UPDATE task_graph_steps SET status = 'running', active_worker_id = ?, updated_at = ? WHERE id = ?",
      workerId,
      t,
      reopened.id,
    );
    recomputeGraphProgressIn(p, graphRow);
    stopQueuedDeliveryNotesIn(p, graphRow.conversation_id, graphRow.id);
    const graph = loadGraph(graphRow.id);
    if (graph !== null) p.changes.push({ type: "task_graph.updated", data: { graph } });
  };

  /**
   * Worker 收工（hub worker end 或归档收工）：
   * - 仅当 !incomplete 且最近一轮汇报状态为“做完了”时，步骤完了，下游轮到（若全部步骤都完了则发交付单通知 PM）；
   * - 传了 --incomplete（如对话超过 WORKER_SEND_MAX_TOKENS 的 200K 上限换人接力）或未汇报“做完了”即收工时，变等人（等项目经理）且清空 active_worker_id，等待接力 Worker 重绑。
   * 返回给 hub worker end 回执用的一句话：它绑定的节点变成了什么、解锁了谁、接下来怎么办；没绑节点（或图已结束）返回 null。
   */
  const onWorkerEndedIn = (
    p: Pending,
    workerId: WorkerId,
    opts: {
      hadLatestDoneReport: boolean;
      incomplete: boolean;
      summary?: string | null;
      branch?: string | null;
      commit?: string | null;
    },
  ): string | null => {
    const node = db.get<TaskNodeDbRow>(
      "SELECT * FROM task_graph_steps WHERE active_worker_id = ?",
      workerId,
    );
    if (node === undefined) return null;
    const graphRow = getGraphRow(node.graph_id);
    if (graphRow === undefined || graphRow.status !== "active") return null;
    const t = now();
    const where = `任务图 #${graphRow.id} 的节点「${node.node_key}」`;
    let note: string;

    if (!opts.incomplete && opts.hadLatestDoneReport) {
      const wasAllSettled = isGraphAllSettled(graphRow.id);
      const prevArtifact = parseJsonOr<TaskArtifact>(node.artifact_json, {});
      const artifact: TaskArtifact = {
        ...prevArtifact,
        ...(opts.branch ? { branch: opts.branch } : {}),
        // 打回重做后由新 Worker 收工：用这一轮汇报的提交号覆盖上一轮的，交付单不能还显示旧提交
        ...(opts.commit ? { commit: opts.commit } : {}),
        ...(opts.summary ? { summary: opts.summary } : {}),
      };
      db.run(
        `UPDATE task_graph_steps
            SET status = 'done',
                waiting_for = NULL,
                active_worker_id = NULL,
                artifact_json = ?,
                updated_at = ?
          WHERE id = ?`,
        Object.keys(artifact).length > 0 ? JSON.stringify(artifact) : null,
        t,
        node.id,
      );
      const unlocked = recomputeGraphProgressIn(p, graphRow);
      syncDeliveryNoteAfterProgressIn(p, graphRow, wasAllSettled);
      const after = loadGraph(graphRow.id);
      const tail = after === null ? "" : unlockedNoteOf(unlocked, after);
      note = `它绑定的${where}已标记为完了（它最近一轮汇报是“做完了”）${tail}${tail.endsWith("！") ? "" : "。"}`;
    } else {
      db.run(
        `UPDATE task_graph_steps
            SET status = 'waiting',
                waiting_for = 'pm',
                active_worker_id = NULL,
                updated_at = ?
          WHERE id = ?`,
        t,
        node.id,
      );
      db.run("UPDATE task_graphs SET updated_at = ? WHERE id = ?", t, graphRow.id);
      const why = opts.incomplete ? "带了 --incomplete" : "它最近一轮没有汇报“做完了”";
      note = `它绑定的${where}变成等你处理，等人接手（${why}）：用 ${HUB_COMMAND} worker start --node ${node.node_key} --graph ${graphRow.id} 新派 Worker 接手，不需要了用 ${HUB_COMMAND} graph skip ${node.node_key} --graph ${graphRow.id}。`;
    }

    const graph = loadGraph(graphRow.id);
    if (graph !== null) p.changes.push({ type: "task_graph.updated", data: { graph } });
    return note;
  };

  // ---- 快照、status 摘要、交接实时注入与保留期清理 ----

  /** 供 ledger.snapshot() 内嵌：只读活跃项目的 active 任务图（走部分索引 idx_task_graphs_active）。 */
  const activeSnapshotGraphs = (): TaskGraph[] => {
    const rows = db.all<TaskGraphDbRow>(
      `SELECT g.* FROM task_graphs g
         JOIN projects p ON p.id = g.project_id
        WHERE g.status = 'active' AND p.status = 'active'
        ORDER BY g.updated_at DESC, g.id DESC`,
    );
    return hydrateGraphs(rows);
  };

  /** 供 hub status 返回结构化活跃图计数摘要与简要文本。 */
  const pmStatusGraphs = (pmId: PmId): { summaries: PmActiveGraphSummary[]; textBlock: string } => {
    const rows = db.all<TaskGraphDbRow>(
      "SELECT * FROM task_graphs WHERE pm_id = ? AND status = 'active' ORDER BY updated_at DESC, id DESC",
      pmId,
    );
    if (rows.length === 0) return { summaries: [], textBlock: "" };
    const graphs = hydrateGraphs(rows);
    const summaries: PmActiveGraphSummary[] = graphs.map((g) => ({
      id: g.id,
      title: g.title,
      totalNodes: g.nodes.length,
      doneCount: g.nodes.filter((n) => n.status === "done").length,
      runningCount: g.nodes.filter((n) => n.status === "running").length,
      waitingPmCount: g.nodes.filter(isTaskNodeWaitingPm).length,
      waitingUserCount: g.nodes.filter(isTaskNodeWaitingUser).length,
      readyToFinish: isTaskGraphReadyToFinish(g),
    }));
    const lines = graphs.map((g) => {
      const runningKeys = g.nodes.filter((n) => n.status === "running").map((n) => n.key);
      const waitingPmKeys = g.nodes.filter(isTaskNodeWaitingPm).map((n) => n.key);
      const waitingUserKeys = g.nodes.filter(isTaskNodeWaitingUser).map((n) => n.key);
      const doneCount = g.nodes.filter((n) => n.status === "done").length;
      const tags: string[] = [`进度 ${doneCount}/${g.nodes.length}`];
      if (isTaskGraphReadyToFinish(g)) tags.push("待交付");
      if (runningKeys.length > 0) tags.push(`在干：${runningKeys.join("、")}`);
      if (waitingPmKeys.length > 0) tags.push(`等你处理：${waitingPmKeys.join("、")}`);
      if (waitingUserKeys.length > 0) tags.push(`等用户拍板：${waitingUserKeys.join("、")}`);
      return `- #${g.id}「${g.title}」（${tags.join("；")}）`;
    });
    return {
      summaries,
      textBlock: `\n活跃任务图：\n${lines.join("\n")}`,
    };
  };

  /** 供 handover.ts 的 sessionPreamble 实时注入：PM 换新会话时一眼看清当前全部活跃图、各节点实时状态和已有的结果（分支、PR、摘要、定案）。 */
  const liveHandoverSection = (pmId: PmId): string | null => {
    const rows = db.all<TaskGraphDbRow>(
      "SELECT * FROM task_graphs WHERE pm_id = ? AND status = 'active' ORDER BY id ASC",
      pmId,
    );
    if (rows.length === 0) return null;
    const graphs = hydrateGraphs(rows);
    // 每个节点带着分支、PR、摘要、定案（formatGraphText）；总字数有上限：按最近动过的先给全文，
    // 放不下的退一档只列各节点的状态，还放不下的只留一行进度（用 hub graph show 看）
    const byRecent = [...graphs].sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
    // 先预留每张图的最简进度和分隔符，后续只花费升级档位的增量。
    const texts = new Map(graphs.map((graph) => [graph.id, formatGraphBrief(graph)]));
    let used = [...texts.values()].reduce((sum, text) => sum + charLen(text), 0) + (graphs.length - 1) * 2;
    for (const graph of byRecent) {
      const brief = texts.get(graph.id)!;
      for (const candidate of [formatGraphText(graph), formatGraphText(graph, false)]) {
        const extra = charLen(candidate) - charLen(brief);
        if (used + extra <= HANDOVER_GRAPHS_MAX_CHARS) {
          texts.set(graph.id, candidate);
          used += extra;
          break;
        }
      }
    }
    return graphs.map((g) => texts.get(g.id)!).join("\n\n");
  };

  /** 定期清理：删除已完成/已取消满 COMPLETED_GRAPH_RETENTION_MS（90 天）的任务图（外键 CASCADE 自动删节点与边）。 */
  const purgeExpiredBatch = (nowMs: number, maxRows: number): number => {
    if (maxRows <= 0) return 0;
    return write(() => {
      const cutoff = nowMs - COMPLETED_GRAPH_RETENTION_MS;
      return db.run(
        `DELETE FROM task_graphs
          WHERE id IN (
            SELECT id FROM task_graphs
             WHERE status != 'active' AND COALESCE(completed_at, updated_at) <= ?
             LIMIT ?
          )`,
        cutoff,
        maxRows,
      ).changes;
    });
  };

  return {
    createIn,
    show,
    list,
    askIn,
    patchIn,
    doneIn,
    decideIn,
    skipIn,
    cancelIn,
    finishIn,
    graphPrTargets,
    graphDeliveryProbeTarget,
    enrichDeliveryNoteMessage,
    decideNode,
    skipNode,
    cancelGraph,
    listProjectHistory,
    prepareWorkerBind,
    bindWorkerStartedIn,
    onWorkerAttentionIn,
    onWorkerResumedIn,
    onWorkerEndedIn,
    activeSnapshotGraphs,
    pmStatusGraphs,
    liveHandoverSection,
    purgeExpiredBatch,
  };
}

import { truncateChars } from "../../../shared/domain.ts";
import type {
  AgentSessionRow,
  ConversationId,
  MessageId,
  TaskGraph,
  TaskGraphId,
  TaskNode,
  TaskNodeKey,
  WorkerId,
} from "../../../shared/domain.ts";
import { HUB_HELP_ONLY_COMMANDS, type WorkerPr } from "../../../shared/hub.ts";
import type { GraphPrTarget } from "../../../shared/ledger.ts";
import { DELIVERY_FILES_MAX, DELIVERY_NOTE_MAX_CHARS } from "../../../shared/limits.ts";
import { graphDeliveryWakeupRef, readyNoticeSubjectOf } from "../../../shared/pm-notice.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { parseWorkerReport } from "../../../shared/worker.ts";
import type { Db } from "../../store/index.ts";
import type { Pending } from "../context.ts";
import { graphReadySince, isReadyAgendaNoticeCurrent } from "../pm-agenda.ts";
import { enqueuePmNoticeIn } from "../pm-notices.ts";
import { systemWakeupKey } from "../system-wakeups.ts";
import { toMessage, type MessageDbRow } from "../rows.ts";
import { readStoredArtifact, workerIdsOf } from "./rows.ts";
import { activeGraphRowsOfPm, getGraphRow, lastReportText, loadGraph, mainFolderOf } from "./store.ts";
import { collapseOneLine, prStateLabelZh } from "./text.ts";
import type { TaskGraphCtx, TaskGraphDbRow, TaskNodeDbRow } from "./types.ts";

type DeliveryExtra = {
  files?: ReadonlyArray<{ file: string; added: number | null; deleted: number | null }>;
  prs?: Readonly<Record<string, WorkerPr>>;
};

type GraphBranch = { branch: string; nodeKey: TaskNodeKey; cwd: string; baseCommit: string | null };

export function collectGraphBranches(db: Db, graphRow: TaskGraphDbRow): GraphBranch[] {
  const mainFolder = mainFolderOf(db, graphRow.project_id);
  const nodeRows = db.all<TaskNodeDbRow>(
    "SELECT * FROM task_graph_steps WHERE graph_id = ? AND status = 'done' AND skipped = 0 ORDER BY sort_order ASC, id ASC",
    graphRow.id,
  );
  const seen = new Set<string>();
  const out: GraphBranch[] = [];
  const pushBranch = (branch: string | null | undefined, nodeKey: TaskNodeKey, cwd: string | null, baseCommit: string | null) => {
    const b = branch?.trim() ?? "";
    if (b === "" || seen.has(b)) return;
    const targetCwd = mainFolder || cwd || "";
    if (targetCwd === "") return;
    seen.add(b);
    out.push({ branch: b, nodeKey, cwd: targetCwd, baseCommit });
  };
  for (const node of nodeRows) {
    for (const wid of workerIdsOf(node)) {
      const w = db.get<{ branch: string | null; worktree_path: string | null; base_commit: string | null }>(
        "SELECT branch, worktree_path, base_commit FROM workers WHERE id = ?",
        wid,
      );
      if (w?.branch) pushBranch(w.branch, node.node_key, w.worktree_path, w.base_commit);
    }
    const { artifact } = readStoredArtifact(node.artifact_json);
    if (artifact?.branch) pushBranch(artifact.branch, node.node_key, null, null);
  }
  return out;
}

/** Only http(s) URLs are returned so `gh pr view` never sees them as flags. */
export function collectGraphPrUrls(db: Db, graphRow: TaskGraphDbRow): Array<{ prUrl: string; nodeKey: TaskNodeKey; cwd: string }> {
  const mainFolder = mainFolderOf(db, graphRow.project_id);
  if (mainFolder === null) return [];
  const nodeRows = db.all<Pick<TaskNodeDbRow, "node_key" | "artifact_json">>(
    "SELECT node_key, artifact_json FROM task_graph_steps WHERE graph_id = ? AND status = 'done' AND skipped = 0 ORDER BY sort_order ASC, id ASC",
    graphRow.id,
  );
  const seen = new Set<string>();
  const out: Array<{ prUrl: string; nodeKey: TaskNodeKey; cwd: string }> = [];
  for (const node of nodeRows) {
    const prUrl = readStoredArtifact(node.artifact_json).artifact?.prUrl?.trim() ?? "";
    if (!/^https?:\/\/\S+$/iu.test(prUrl) || seen.has(prUrl)) continue;
    seen.add(prUrl);
    out.push({ prUrl, nodeKey: node.node_key, cwd: mainFolder });
  }
  return out;
}

function lastReportOf(db: Db, conversationId: number, workerId: WorkerId) {
  const text = lastReportText(db, conversationId, workerId);
  return text === undefined ? null : parseWorkerReport(text);
}

function deliveryNodeLine(db: Db, graph: TaskGraph, n: TaskNode, i: number, extra: DeliveryExtra | undefined): string {
  if (n.skipped) {
    const skipSummary = n.artifact?.summary ? ` · ${collapseOneLine(n.artifact.summary, 200)}` : "";
    return `${i + 1}. [已跳过] ${n.key} ${n.title}${skipSummary}`;
  }
  const parts: string[] = [`${i + 1}. [完了] ${n.key} ${n.title}`];
  const lastWid = n.workerIds.at(-1) ?? null;
  let workerBranch: string | null = null;
  let report: { summary: string | null; commit: string | null; tests: string | null } = { summary: null, commit: null, tests: null };
  if (lastWid !== null) {
    parts.push(`Worker #${lastWid}`);
    workerBranch = db.get<{ branch: string | null }>("SELECT branch FROM workers WHERE id = ?", lastWid)?.branch ?? null;
    const parsed = lastReportOf(db, graph.conversationId, lastWid);
    if (parsed?.kind === "ok") {
      report = { summary: parsed.report.summary, commit: parsed.report.commit, tests: parsed.report.tests.trim() || null };
    } else if (parsed?.summary) {
      report = { ...report, summary: parsed.summary };
    }
  }
  const summaryText =
    n.artifact?.summary?.trim() || report.summary || (n.decision !== null ? `定案 ${n.decision.choice ?? n.decision.note ?? ""}` : "");
  if (summaryText) parts.push(collapseOneLine(summaryText, 200));
  const branch = n.artifact?.branch?.trim() || workerBranch;
  if (branch) parts.push(`分支 ${branch}`);
  const commit = n.artifact?.commit?.trim() || report.commit;
  if (commit) parts.push(`提交 ${collapseOneLine(commit, 40)}`);
  if (n.artifact?.reviewVerdict) parts.push(`审查 ${n.artifact.reviewVerdict}`);
  if (n.artifact?.verifiedCommit) parts.push(`验证提交 ${n.artifact.verifiedCommit}`);
  const probedPr = branch ? extra?.prs?.[branch] : undefined;
  if (probedPr !== undefined) parts.push(`PR #${probedPr.number}（${prStateLabelZh(probedPr.state)}）`);
  else if (n.artifact?.prUrl?.trim()) parts.push(`PR ${collapseOneLine(n.artifact.prUrl, 120)}`);
  if (report.tests) parts.push(`测试：${collapseOneLine(report.tests, 200)}`);
  return parts.join(" · ");
}

function decisionLines(graph: TaskGraph): string[] {
  return graph.nodes.flatMap((n) => {
    if (n.decision === null) return [];
    const q = collapseOneLine(n.gateQuestion?.trim() || n.title, 120);
    const choiceText = n.decision.choice !== null ? collapseOneLine(n.decision.choice, 120) : "自定义意见";
    const noteText = n.decision.note ? `（${collapseOneLine(n.decision.note, 120)}）` : "";
    return [`拍板：「${q}」定案 ${choiceText}${noteText}`];
  });
}

function lastHandoffLine(db: Db, graph: TaskGraph): string[] {
  const lastActiveNode = [...graph.nodes].reverse().find((n) => !n.skipped && n.workerIds.length > 0);
  if (lastActiveNode === undefined) return [];
  const parsed = lastReportOf(db, graph.conversationId, lastActiveNode.workerIds.at(-1)!);
  if (parsed?.kind !== "ok" || parsed.report.handoff.trim() === "") return [];
  return [`最后一步的交棒：\n${parsed.report.handoff.trim()}`];
}

function changedFileLines(files: DeliveryExtra["files"]): string[] {
  if (files === undefined) return [];
  if (files.length === 0) return ["改动文件（相对主干）：无提交改动"];
  const lines = [`改动文件（相对主干，共 ${files.length} 个）：`];
  for (const f of files.slice(0, DELIVERY_FILES_MAX)) {
    const stat = f.added === null || f.deleted === null ? "二进制" : `+${f.added} -${f.deleted}`;
    lines.push(`  ${f.file} | ${stat}`);
  }
  if (files.length > DELIVERY_FILES_MAX) lines.push(`  …另有 ${files.length - DELIVERY_FILES_MAX} 个文件省略`);
  return lines;
}

function formatDeliveryNote(db: Db, graph: TaskGraph, extra?: DeliveryExtra): string {
  const lines: string[] = [
    `【任务图 #${graph.id}「${graph.title}」图里画的步骤都做完了，等你验收交付】`,
    ...graph.nodes.map((n, i) => deliveryNodeLine(db, graph, n, i, extra)),
    ...decisionLines(graph),
    ...lastHandoffLine(db, graph),
    ...changedFileLines(extra?.files),
  ];
  const footer = [
    "",
    "",
    `图里只有上面这些步骤；项目规矩或用户要求、但没画进图的步骤（比如审查），后台看不出来，缺了用 ${HUB_COMMAND} graph patch 补。`,
    HUB_HELP_ONLY_COMMANDS["watch.add"],
    `验收看上面的证据，按项目约定交付后用 ${HUB_COMMAND} graph finish 结束这张图。`,
  ].join("\n");
  const bodyBudget = Math.max(200, DELIVERY_NOTE_MAX_CHARS - [...footer].length);
  return `${truncateChars(lines.join("\n"), bodyBudget)}${footer}`;
}

export function deliveryNoteKeys(conversationId: ConversationId, graphId: TaskGraphId) {
  return {
    legacy: `system:${conversationId}:task_graph.ready_to_finish:${graphId}:*`,
    current: systemWakeupKey(conversationId, "task_graph", graphDeliveryWakeupRef(graphId, "*")),
  };
}

export function latestDeliveryNoteId(db: Db, conversationId: ConversationId, graphId: TaskGraphId): MessageId | undefined {
  const { legacy, current } = deliveryNoteKeys(conversationId, graphId);
  return db.get<{ id: MessageId }>(
    "SELECT max(id) AS id FROM messages WHERE dedupe_key GLOB ? OR dedupe_key GLOB ?",
    legacy, current,
  )?.id ?? undefined;
}

export function stopQueuedDeliveryNotesIn(g: TaskGraphCtx, p: Pending, conversationId: ConversationId, graphId: TaskGraphId): void {
  const { legacy, current } = deliveryNoteKeys(conversationId, graphId);
  const queuedRows = g.db.all<{ id: number }>(
    "SELECT id FROM messages WHERE (dedupe_key GLOB ? OR dedupe_key GLOB ?) AND status = 'queued'",
    legacy, current,
  );
  for (const r of queuedRows) g.messages.transition(p, r.id, "stopped");
}

export function syncDeliveryNoteAfterProgressIn(g: TaskGraphCtx, p: Pending, graphRow: TaskGraphDbRow, wasAllSettled: boolean): void {
  const since = graphReadySince(g.db, graphRow.pm_id, graphRow.id);
  if (since === null) {
    stopQueuedDeliveryNotesIn(g, p, graphRow.conversation_id, graphRow.id);
    return;
  }
  if (wasAllSettled) return;
  const pmSession = g.sessions.currentSession(graphRow.conversation_id);
  if (pmSession === null) return;
  const graph = loadGraph(g, graphRow.id);
  if (graph === null) return;
  const previousNoticeId = latestDeliveryNoteId(g.db, graphRow.conversation_id, graphRow.id);
  enqueuePmNoticeIn(g, p, pmSession, {
    conversationId: graphRow.conversation_id,
    text: formatDeliveryNote(g.db, graph),
    subject: { kind: "graph.ready_to_finish", graphId: graph.id, since, ...(previousNoticeId === undefined ? {} : { previousNoticeId }) },
  });
}

export function graphPrTargets(db: Db, caller: AgentSessionRow | null, graphId?: TaskGraphId): GraphPrTarget[] {
  if (caller === null || caller.role !== "pm" || caller.pmId === null) return [];
  let graphRow: TaskGraphDbRow | undefined;
  if (graphId !== undefined) {
    const row = getGraphRow(db, graphId);
    if (row === undefined || row.pm_id !== caller.pmId || row.status !== "active") return [];
    graphRow = row;
  } else {
    const activeRows = activeGraphRowsOfPm(db, caller.pmId);
    if (activeRows.length !== 1) return [];
    graphRow = activeRows[0]!;
  }
  return [
    ...collectGraphBranches(db, graphRow).map(({ cwd, branch }) => ({ cwd, branch })),
    ...collectGraphPrUrls(db, graphRow).map(({ cwd, prUrl }) => ({ cwd, prUrl })),
  ];
}

function queuedReadyNote(db: Db, messageId: MessageId): { message: MessageDbRow; graphId: TaskGraphId } | null {
  const row = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ? AND sender = 'system' AND status = 'queued'", messageId);
  if (row === undefined) return null;
  const message = toMessage(row);
  if (message.meta?.diffProbed === true) return null;
  const subject = readyNoticeSubjectOf(message);
  if (subject === null) return null;
  const graph = getGraphRow(db, subject.graphId);
  return graph?.conversation_id === message.conversationId &&
    latestDeliveryNoteId(db, message.conversationId, graph.id) === message.id &&
    isReadyAgendaNoticeCurrent(db, graph.pm_id, graph.id, subject.since)
    ? { message: row, graphId: graph.id } : null;
}

export function graphDeliveryProbeTarget(
  db: Db,
  messageId: MessageId,
): { graphId: TaskGraphId; repoFolder: string | null; branches: Array<{ branch: string; cwd: string; baseCommit: string | null }> } | null {
  const meta = queuedReadyNote(db, messageId);
  if (meta === null) return null;
  const graphRow = getGraphRow(db, meta.graphId);
  if (graphRow === undefined || graphRow.status !== "active") return null;
  const repoFolder = mainFolderOf(db, graphRow.project_id);
  const branches = collectGraphBranches(db, graphRow).map(({ branch, cwd, baseCommit }) => ({ branch, cwd, baseCommit }));
  return { graphId: graphRow.id, repoFolder, branches };
}

export function enrichDeliveryNoteMessage(g: TaskGraphCtx, messageId: MessageId, input: DeliveryExtra): void {
  g.write((p) => {
    // The probe ran outside the transaction; skip notes that were stopped meanwhile.
    const meta = queuedReadyNote(g.db, messageId);
    if (meta === null) return;
    const graph = loadGraph(g, meta.graphId);
    if (graph === null) return;
    const nextText = formatDeliveryNote(g.db, graph, input);
    g.db.run("UPDATE messages SET text = ?, meta = json_set(meta, '$.diffProbed', json('true')), updated_at = ? WHERE id = ?", nextText, g.now(), meta.message.id);
    p.changes.push({
      type: "message.updated",
      data: { message: toMessage(g.db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", messageId)!) },
    });
  });
}

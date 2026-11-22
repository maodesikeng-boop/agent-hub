import { CONFIRM_CHECKPOINT_OPTIONS, CONFIRM_PASS_OPTION, truncateChars } from "../../../shared/domain.ts";
import type { MessageId, TaskArtifact, WorkerId } from "../../../shared/domain.ts";
import { MAX_GATE_QUESTION_CHARS, MAX_GATE_SUMMARY_CHARS, MAX_NODE_ARTIFACT_COMMIT_CHARS, MAX_NODE_ARTIFACT_SUMMARY_CHARS } from "../../../shared/limits.ts";
import { reviewReportProblem, reviewVerifyFailedText, type ReviewTarget, type ReviewVerifyResult } from "../../../shared/review.ts";
import {
  extractReportPrUrl,
  hasReportQuestion,
  isReportFieldNone,
  type ParsedWorkerReport,
} from "../../../shared/worker.ts";
import { stepDeliverablesOfReport } from "../../deliverables.ts";
import type { Pending } from "../context.ts";
import { formatStepWaitingPmMessage } from "../task-graph-handoff.ts";
import type { ReportMessage } from "../workers.ts";
import { syncDeliveryNoteAfterProgressIn } from "./delivery.ts";
import { recomputeGraphProgressIn, wakePmForTurnedIn } from "./progress.ts";
import { isStoredCheckpoint, readStoredArtifact, serializeArtifact } from "./rows.ts";
import { getGraphRow, isGraphAllSettled, leaveStepIn, pushSlimGraphIn, stepOfActiveWorker, stepPosition, touchGraph } from "./store.ts";
import { gateChatMessageText } from "./text.ts";
import type { TaskGraphCtx, TaskGraphDbRow, TaskNodeDbRow } from "./types.ts";

type OkReport = Extract<ParsedWorkerReport, { kind: "ok" }>["report"];

type TurnReportOutcome =
  | { handled: false }
  | { handled: true; outcome: "verify" }
  | { handled: true; outcome: "completed"; wakePmWithReport: boolean; completeStep: () => void }
  | { handled: true; outcome: "waiting_user" }
  | { handled: true; outcome: "waiting_pm"; pmDeliverBody: string };

type ReportWorker = { id: WorkerId; branch: string | null; review: ReviewTarget | null };
type TurnReportOpts = { hasPendingFollowup?: boolean; reviewVerified?: ReviewVerifyResult; reportMessage?: ReportMessage | null };
type ReviewStop = { label: string; detail: string | null };

interface TurnRun {
  node: TaskNodeDbRow;
  graphRow: TaskGraphDbRow;
  mergedArtifact: TaskArtifact;
  artifactJson: string | null;
  prUrl: string | null;
}

function mergeReportArtifact(node: TaskNodeDbRow, worker: ReportWorker, parsed: ParsedWorkerReport, opts: TurnReportOpts | undefined, prUrl: string | null): TaskArtifact {
  const prevArtifact = readStoredArtifact(node.artifact_json).artifact ?? {};
  const reportDeliverables =
    parsed.kind === "ok" && opts?.reportMessage != null ? stepDeliverablesOfReport(parsed.report, opts.reportMessage) : [];
  return {
    ...prevArtifact,
    ...(reportDeliverables.length > 0 ? { deliverables: reportDeliverables } : {}),
    ...(worker.branch ? { branch: worker.branch } : {}),
    ...(parsed.kind === "ok" && parsed.report.commit ? { commit: parsed.report.commit } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(parsed.kind === "ok" ? { summary: truncateChars(parsed.report.summary, MAX_NODE_ARTIFACT_SUMMARY_CHARS) } : {}),
    ...(worker.review !== null && parsed.kind === "ok"
      ? {
          reviewStamp: undefined,
          reviewVerdict: parsed.report.verdict ?? undefined,
          verifiedCommit:
            parsed.report.verifiedCommit === null ? undefined : truncateChars(parsed.report.verifiedCommit, MAX_NODE_ARTIFACT_COMMIT_CHARS),
        }
      : {}),
  };
}

function saveArtifactOnlyIn(g: TaskGraphCtx, p: Pending, run: TurnRun): TurnReportOutcome {
  const t = g.now();
  g.db.run("UPDATE task_graph_steps SET artifact_json = ?, updated_at = ? WHERE id = ?", run.artifactJson, t, run.node.id);
  touchGraph(g.db, run.graphRow.id, t);
  pushSlimGraphIn(g, p, run.graphRow.id);
  return { handled: true, outcome: "waiting_user" };
}

function reviewStopOf(worker: ReportWorker, parsed: ParsedWorkerReport, forcedNote: string | null, opts: TurnReportOpts | undefined): ReviewStop | null {
  if (worker.review === null || forcedNote !== null || parsed.kind !== "ok") return null;
  const problem = reviewReportProblem(parsed.report, worker.review);
  const changed = opts?.reviewVerified?.problems ?? [];
  if (parsed.report.verdict === "FAIL") return { label: "审查判 FAIL", detail: null };
  if (problem !== null) return { label: problem, detail: null };
  if (changed.length > 0) return { label: "被审分支在审查期间被动过", detail: reviewVerifyFailedText(changed) };
  return null;
}

function checkpointSummaryMd(report: OkReport, prUrl: string | null): string | null {
  const parts: string[] = [];
  if (report.summary.trim() !== "") parts.push(`**摘要**：${report.summary.trim().replace(/\n\s*\n/gu, "\n")}`);
  const handoffText = report.handoff.trim();
  if (handoffText !== "" && !isReportFieldNone(handoffText)) parts.push(`**交棒要点**：\n${handoffText}`);
  const refs: string[] = [];
  if (report.commit) refs.push(`提交 \`${report.commit}\``);
  if (prUrl) refs.push(`PR ${prUrl}`);
  else if (report.pr) refs.push(`PR ${report.pr}`);
  if (refs.length > 0) parts.push(refs.join(" · "));
  if (hasReportQuestion(report.questions)) parts.push(`**附带说明**：\n${report.questions.trim()}`);
  return parts.length > 0 ? truncateChars(parts.join("\n\n"), MAX_GATE_SUMMARY_CHARS) : null;
}

function openCheckpointCardIn(g: TaskGraphCtx, p: Pending, run: TurnRun, report: OkReport): TurnReportOutcome {
  const { node, graphRow, mergedArtifact } = run;
  const t = g.now();
  if (node.gate_ask_message_id !== null) g.messages.settleAskIn(p, node.gate_ask_message_id, { by: "close" });
  const gateQuestion = truncateChars(`请确认步骤「${node.title}」的结果`, MAX_GATE_QUESTION_CHARS);
  const gateOptions = [...CONFIRM_CHECKPOINT_OPTIONS];
  const gateOptionsJson = JSON.stringify(gateOptions);
  const gateSummaryMd = checkpointSummaryMd(report, run.prUrl);
  const pmSession = g.sessions.currentSession(graphRow.conversation_id);
  let askMsgId: MessageId | null = null;
  if (pmSession !== null) {
    const chatText = gateChatMessageText({
      title: node.title,
      gate_question: gateQuestion,
      gate_options_json: gateOptionsJson,
      gate_summary_md: gateSummaryMd,
      gate_recommended: CONFIRM_PASS_OPTION,
    });
    askMsgId = g.messages.insertAskMessage(p, { ...pmSession, conversationId: graphRow.conversation_id }, chatText, gateOptions, {
      gateRef: { graphId: graphRow.id, nodeKey: node.node_key, checkpoint: true },
      recommended: CONFIRM_PASS_OPTION,
      ...(mergedArtifact.deliverables !== undefined ? { deliverables: mergedArtifact.deliverables } : {}),
    }).id;
  }
  g.db.run(
    `UPDATE task_graph_steps
        SET status = 'waiting', waiting_for = 'user', artifact_json = ?, gate_question = ?, gate_options_json = ?,
            gate_summary_md = ?, gate_recommended = ?, gate_ask_message_id = ?, decision_json = NULL, updated_at = ?
      WHERE id = ?`,
    serializeArtifact(mergedArtifact, true),
    gateQuestion,
    gateOptionsJson,
    gateSummaryMd,
    CONFIRM_PASS_OPTION,
    askMsgId,
    t,
    node.id,
  );
  touchGraph(g.db, graphRow.id, t);
  pushSlimGraphIn(g, p, graphRow.id);
  return { handled: true, outcome: "waiting_user" };
}

function completeStepIn(g: TaskGraphCtx, p: Pending, run: TurnRun): void {
  const { node, graphRow } = run;
  const wasAllSettled = isGraphAllSettled(g.db, graphRow.id);
  const t = g.now();
  g.db.run(
    "UPDATE task_graph_steps SET status = 'done', waiting_for = NULL, active_worker_id = NULL, artifact_json = ?, updated_at = ? WHERE id = ?",
    run.artifactJson,
    t,
    node.id,
  );
  const progress = recomputeGraphProgressIn(g, p, graphRow, undefined, undefined, { retractBlockedWaiting: false });
  syncDeliveryNoteAfterProgressIn(g, p, graphRow, wasAllSettled);
  if (progress.turned.some((u) => u.waitingFor === "pm")) {
    wakePmForTurnedIn(g, p, graphRow, progress.turned, `步骤「${node.node_key}（${node.title}）」已完成，`, `auto-done:${node.node_key}:${t}`);
  }
  pushSlimGraphIn(g, p, graphRow.id);
}

function cleanDoneIn(g: TaskGraphCtx, p: Pending, run: TurnRun, report: OkReport): TurnReportOutcome {
  const { node } = run;
  const waitingOnAskCard = node.status === "waiting" && node.waiting_for === "user" && !isStoredCheckpoint(node);
  if (waitingOnAskCard) return saveArtifactOnlyIn(g, p, run);
  if (node.confirm === 1) return openCheckpointCardIn(g, p, run, report);
  return {
    handled: true,
    outcome: "completed",
    wakePmWithReport: hasReportQuestion(report.questions),
    completeStep: () => completeStepIn(g, p, run),
  };
}

function brakeReasonLabel(parsed: ParsedWorkerReport, forcedNote: string | null, reviewStop: ReviewStop | null): string {
  if (forcedNote !== null) return "这一轮没做完（后台命令中断）";
  if (reviewStop !== null) return reviewStop.label;
  if (parsed.kind !== "ok") return "没按格式";
  if (parsed.report.status === "problem") return "汇报有问题";
  if (parsed.report.status === "gave_up") return "放弃了";
  if (parsed.report.deviation !== null) return "报告偏离";
  return "汇报做完了（此步骤标了 confirm 待确认）";
}

function brakeToPmIn(
  g: TaskGraphCtx,
  p: Pending,
  run: TurnRun,
  workerId: WorkerId,
  body: { parsed: ParsedWorkerReport; rawBody: string; forcedNote: string | null; reviewStop: ReviewStop | null },
): TurnReportOutcome {
  const { node, graphRow } = run;
  const pos = stepPosition(g.db, graphRow.id, node.node_key);
  const t = g.now();
  leaveStepIn(g, p, node, { status: "waiting", waitingFor: "pm", artifactJson: run.artifactJson }, t);
  touchGraph(g.db, graphRow.id, t);
  pushSlimGraphIn(g, p, graphRow.id);
  const note = body.forcedNote ?? body.reviewStop?.detail ?? null;
  return {
    handled: true,
    outcome: "waiting_pm",
    pmDeliverBody: formatStepWaitingPmMessage({
      graph: { id: graphRow.id, title: graphRow.title },
      step: { key: node.node_key, title: node.title, ...pos },
      workerId,
      reasonLabel: brakeReasonLabel(body.parsed, body.forcedNote, body.reviewStop),
      detailBody: note === null ? body.rawBody : `${note}\n\n${body.rawBody}`,
    }),
  };
}

export function onWorkerTurnReportIn(
  g: TaskGraphCtx,
  p: Pending,
  worker: ReportWorker,
  parsed: ParsedWorkerReport,
  rawBody: string,
  forcedNote: string | null,
  opts?: TurnReportOpts,
): TurnReportOutcome {
  const node = stepOfActiveWorker(g.db, worker.id);
  if (node === undefined) return { handled: false };
  const graphRow = getGraphRow(g.db, node.graph_id);
  if (graphRow === undefined || graphRow.status !== "active") return { handled: false };
  const prUrl = parsed.kind === "ok" ? extractReportPrUrl(parsed.report.pr) : null;
  const mergedArtifact = mergeReportArtifact(node, worker, parsed, opts, prUrl);
  const run: TurnRun = { node, graphRow, mergedArtifact, artifactJson: serializeArtifact(mergedArtifact, false), prUrl };
  if (opts?.hasPendingFollowup === true) return saveArtifactOnlyIn(g, p, run);
  const reviewStop = reviewStopOf(worker, parsed, forcedNote, opts);
  if (reviewStop === null && forcedNote === null && parsed.kind === "ok" && parsed.report.status === "done" && parsed.report.deviation === null) {
    // Review workers verify the reviewed branch outside the transaction before their PASS counts.
    if (worker.review !== null && opts?.reviewVerified === undefined) return { handled: true, outcome: "verify" };
    return cleanDoneIn(g, p, run, parsed.report);
  }
  return brakeToPmIn(g, p, run, worker.id, { parsed, rawBody, forcedNote, reviewStop });
}

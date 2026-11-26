import { truncateChars } from "../../../shared/domain.ts";
import type { TaskArtifact, WorkerId } from "../../../shared/domain.ts";
import { MAX_NODE_ARTIFACT_COMMIT_CHARS, MAX_NODE_ARTIFACT_SUMMARY_CHARS } from "../../../shared/limits.ts";
import { reviewReportProblem, reviewVerifyFailedText, type ReviewTarget, type ReviewVerifyResult } from "../../../shared/review.ts";
import {
  extractReportPrUrl,
  hasReportQuestion,
  type ParsedWorkerReport,
} from "../../../shared/worker.ts";
import { stepDeliverablesOfReport } from "../../deliverables.ts";
import type { Pending } from "../context.ts";
import { formatStepWaitingPmMessage } from "../task-graph-handoff.ts";
import type { ReportMessage } from "../workers.ts";
import { syncDeliveryNoteAfterProgressIn } from "./delivery.ts";
import { recomputeGraphProgressIn, wakePmForTurnedIn } from "./progress.ts";
import { isStoredCheckpoint, readStoredArtifact, serializeArtifact } from "./rows.ts";
import { getGraphRow, hasPendingStepAsk, isGraphAllSettled, leaveStepIn, pushSlimGraphIn, stepOfActiveWorker, stepPosition, touchGraph } from "./store.ts";
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
  artifactJson: string | null;
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
          reviewVerdict: parsed.report.verdict ?? undefined,
          verifiedCommit:
            parsed.report.verifiedCommit === null ? undefined : truncateChars(parsed.report.verifiedCommit, MAX_NODE_ARTIFACT_COMMIT_CHARS),
        }
      : {}),
  };
}

function saveArtifactOnlyIn(g: TaskGraphCtx, p: Pending, run: TurnRun, waitForCard = false): TurnReportOutcome {
  const t = g.now();
  const wait = waitForCard ? "status = 'waiting', waiting_for = 'user'," : "";
  g.db.run(`UPDATE task_graph_steps SET ${wait} artifact_json = ?, updated_at = ? WHERE id = ?`, run.artifactJson, t, run.node.id);
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
  if (hasPendingStepAsk(g, node)) return saveArtifactOnlyIn(g, p, run, true);
  return {
    handled: true,
    outcome: "completed",
    wakePmWithReport: hasReportQuestion(report.questions),
    completeStep: () => completeStepIn(g, p, run),
  };
}

function brakeReasonLabel(parsed: ParsedWorkerReport, forcedNote: string | null, reviewStop: ReviewStop | null, nodeKey: string): string {
  if (forcedNote !== null) return "这一轮没做完（后台命令中断）";
  if (reviewStop !== null) return reviewStop.label;
  if (parsed.kind !== "ok") return "没按格式";
  if (parsed.report.status === "problem") return "汇报有问题";
  if (parsed.report.status === "gave_up") return "放弃了";
  if (parsed.report.deviation !== null) return "报告偏离";
  return `步骤「${nodeKey}」做完了，等你审（检查点）`;
}

function brakeToPmIn(
  g: TaskGraphCtx,
  p: Pending,
  run: TurnRun,
  workerId: WorkerId,
  body: { parsed: ParsedWorkerReport; rawBody: string; forcedNote: string | null; reviewStop: ReviewStop | null; checkpoint?: boolean },
): TurnReportOutcome {
  const { node, graphRow } = run;
  const pos = stepPosition(g.db, graphRow.id, node.node_key);
  const t = g.now();
  leaveStepIn(g.db, node, { status: "waiting", waitingFor: "pm", artifactJson: run.artifactJson }, t);
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
      reasonLabel: brakeReasonLabel(body.parsed, body.forcedNote, body.reviewStop, node.node_key),
      checkpoint: body.checkpoint,
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
  const pendingAsk = hasPendingStepAsk(g, node);
  const run: TurnRun = { node, graphRow, artifactJson: serializeArtifact(mergedArtifact, pendingAsk && isStoredCheckpoint(node)) };
  if (opts?.hasPendingFollowup === true) return saveArtifactOnlyIn(g, p, run);
  const reviewStop = reviewStopOf(worker, parsed, forcedNote, opts);
  if (reviewStop === null && forcedNote === null && parsed.kind === "ok" && parsed.report.status === "done" && parsed.report.deviation === null) {
    // Review workers verify the reviewed branch outside the transaction before their PASS counts.
    if (worker.review !== null && opts?.reviewVerified === undefined) return { handled: true, outcome: "verify" };
    if (node.confirm === 1 && !pendingAsk) {
      const checkpointRun = { ...run, artifactJson: serializeArtifact(mergedArtifact, true) };
      return brakeToPmIn(g, p, checkpointRun, worker.id, { parsed, rawBody, forcedNote, reviewStop, checkpoint: true });
    }
    return cleanDoneIn(g, p, run, parsed.report);
  }
  return brakeToPmIn(g, p, run, worker.id, { parsed, rawBody, forcedNote, reviewStop });
}

import { existsSync } from "node:fs";
import type { SessionId, TaskNodeKey } from "../../../shared/domain.ts";
import type { WorkerHubStatusUpstream } from "../../../shared/hub.ts";
import { extractReportPrUrl, parseWorkerReport, unwrapWorkerReportText } from "../../../shared/worker.ts";
import type { Db } from "../../store/index.ts";
import { upstreamReportFilePath, type DirectUpstreamEntry, type UpstreamSourceInfo } from "../task-graph-handoff.ts";
import { decisionOf, lastWorkerIdOf, readStoredArtifact } from "./rows.ts";
import { lastReportText } from "./store.ts";
import type { KeyAdjacency, TaskGraphDbRow, TaskNodeDbRow } from "./types.ts";

interface ReportFields {
  summary: string | null;
  commit: string | null;
  pr: string | null;
  tests: string | null;
  handoff: string;
  rawBody: string;
}

function lastWorkerReport(db: Db, graphRow: TaskGraphDbRow, workerId: number, workerTitle: string): ReportFields {
  const out: ReportFields = { summary: null, commit: null, pr: null, tests: null, handoff: "", rawBody: "" };
  const text = lastReportText(db, graphRow.conversation_id, workerId);
  if (text === undefined) return out;
  out.rawBody = unwrapWorkerReportText({ id: workerId, title: workerTitle }, text);
  const parsed = parseWorkerReport(out.rawBody);
  if (parsed.kind === "ok") {
    out.summary = parsed.report.summary;
    out.commit = parsed.report.commit;
    out.pr = parsed.report.pr;
    out.tests = parsed.report.tests.trim() || null;
    out.handoff = parsed.report.handoff;
  } else if (parsed.summary) {
    out.summary = parsed.summary;
  }
  return out;
}

function fullReportMarkdown(node: TaskNodeDbRow, rawBody: string, summary: string | null | undefined): string {
  const pmNote = node.pm_note;
  const parts = [`# 上游步骤「${node.title}」（${node.node_key}）完整汇报`];
  if (rawBody.trim() !== "") parts.push(rawBody.trim());
  if (pmNote && pmNote.trim() !== "") parts.push(`## 项目经理放行补充\n\n${pmNote.trim()}`);
  if (rawBody.trim() === "" && (!pmNote || pmNote.trim() === "") && summary) parts.push(summary);
  return parts.join("\n\n") + "\n";
}

function buildUpstreamSourceInfo(db: Db, graphRow: TaskGraphDbRow, node: TaskNodeDbRow): UpstreamSourceInfo {
  const { artifact } = readStoredArtifact(node.artifact_json);
  const lastWid = lastWorkerIdOf(node);
  let workerBranch: string | null = null;
  let report: ReportFields = { summary: null, commit: null, pr: null, tests: null, handoff: "", rawBody: "" };
  if (lastWid !== null) {
    const w = db.get<{ title: string; branch: string | null }>("SELECT title, branch FROM workers WHERE id = ?", lastWid);
    workerBranch = w?.branch ?? null;
    report = lastWorkerReport(db, graphRow, lastWid, w?.title ?? node.title);
  }
  const summary = artifact?.summary?.trim() || report.summary;
  return {
    key: node.node_key,
    title: node.title,
    workerId: lastWid,
    summary: summary ?? null,
    commit: (artifact?.commit?.trim() || report.commit) ?? null,
    pr: (artifact?.prUrl?.trim() || report.pr) ?? null,
    tests: report.tests,
    branch: (artifact?.branch?.trim() || workerBranch) ?? null,
    handoff: report.handoff,
    pmNote: node.pm_note,
    fullReportMarkdown: fullReportMarkdown(node, report.rawBody, summary),
    decision: decisionOf(node),
    gateQuestion: node.gate_question,
  };
}

function traceNearestNonSkippedAncestors(
  db: Db,
  graphRow: TaskGraphDbRow,
  startKey: TaskNodeKey,
  byKey: ReadonlyMap<TaskNodeKey, TaskNodeDbRow>,
  incoming: KeyAdjacency,
): UpstreamSourceInfo[] {
  const queue = [...(incoming.get(startKey) ?? [])];
  const visited = new Set<TaskNodeKey>();
  const found: TaskNodeDbRow[] = [];
  while (queue.length > 0) {
    const k = queue.shift()!;
    if (visited.has(k)) continue;
    visited.add(k);
    const n = byKey.get(k);
    if (n === undefined) continue;
    if (n.skipped === 1) queue.push(...(incoming.get(k) ?? []));
    else if (n.status === "done") found.push(n);
  }
  found.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  return found.map((n) => buildUpstreamSourceInfo(db, graphRow, n));
}

export function collectDirectUpstreams(
  db: Db,
  graphRow: TaskGraphDbRow,
  stepKey: TaskNodeKey,
  byKey: ReadonlyMap<TaskNodeKey, TaskNodeDbRow>,
  incoming: KeyAdjacency,
): DirectUpstreamEntry[] {
  const upKeys = [...(incoming.get(stepKey) ?? [])];
  upKeys.sort((a, b) => {
    const na = byKey.get(a);
    const nb = byKey.get(b);
    return (na?.sort_order ?? 0) - (nb?.sort_order ?? 0) || (na?.id ?? 0) - (nb?.id ?? 0);
  });
  return upKeys.flatMap((uk): DirectUpstreamEntry[] => {
    const u = byKey.get(uk);
    if (u === undefined) return [];
    if (u.skipped === 0) return [{ kind: "active", source: buildUpstreamSourceInfo(db, graphRow, u) }];
    const { artifact } = readStoredArtifact(u.artifact_json);
    const skipReason = artifact?.summary ? artifact.summary.replace(/^已跳过[:：]\s*/u, "").trim() || null : null;
    return [
      {
        kind: "skipped",
        key: u.node_key,
        title: u.title,
        skipReason,
        decision: decisionOf(u),
        gateQuestion: u.gate_question,
        tracedSources: traceNearestNonSkippedAncestors(db, graphRow, u.node_key, byKey, incoming),
      },
    ];
  });
}

function reportFileOf(launchDir: string, sessionId: SessionId, key: TaskNodeKey): string | null {
  if (launchDir === "") return null;
  let candidate: string | null;
  try {
    candidate = upstreamReportFilePath(launchDir, sessionId, key);
  } catch {
    candidate = null;
  }
  return candidate !== null && existsSync(candidate) ? candidate : null;
}

function activeUpstreamStatus(source: UpstreamSourceInfo, launchDir: string, sessionId: SessionId): WorkerHubStatusUpstream {
  const reportFile = reportFileOf(launchDir, sessionId, source.key);
  const prUrl = extractReportPrUrl(source.pr) ?? source.pr;
  return {
    key: source.key,
    title: source.title,
    skipped: false,
    summary: source.summary,
    branch: source.branch,
    prUrl: prUrl ?? null,
    reportFile,
  };
}

export function upstreamStatusEntries(
  direct: readonly DirectUpstreamEntry[],
  launchDir: string,
  sessionId: SessionId,
): WorkerHubStatusUpstream[] {
  const upstream: WorkerHubStatusUpstream[] = [];
  for (const entry of direct) {
    if (entry.kind === "active") {
      upstream.push(activeUpstreamStatus(entry.source, launchDir, sessionId));
      continue;
    }
    upstream.push({
      key: entry.key,
      title: entry.title,
      skipped: true,
      summary: entry.skipReason ? `已跳过：${entry.skipReason}` : "已跳过",
      branch: null,
      prUrl: null,
      reportFile: null,
    });
    for (const traced of entry.tracedSources) {
      if (upstream.some((u) => u.key === traced.key)) continue;
      upstream.push(activeUpstreamStatus(traced, launchDir, sessionId));
    }
  }
  return upstream;
}

// Invariant: harness_noise events never inflate product pain-point severity counts, and every reported PainPoint cites concrete step evidence.
import { createHash } from "node:crypto";
import { BLIND_REPORT_MAX_BYTES, BLIND_TRACE_SCHEMA_VERSION } from "./limits.ts";
import type {
  BlindMissionId,
  FrictionSignal,
  PainPoint,
  PainPointReport,
  PainSeverity,
  ViewportClass,
  WalkthroughStep,
  WalkthroughTrace,
} from "./types.ts";

const SEVERITY_ORDER: readonly PainSeverity[] = ["P0", "P1", "P2", "P3"];
const SEVERITY_RANK: Readonly<Record<PainSeverity, number>> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function higherSeverity(a: PainSeverity, b: PainSeverity): PainSeverity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim()
    .slice(0, 120);
}

function painPointId(key: string): string {
  return `pp-${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
}

function stepEvidence(step: WalkthroughStep): readonly string[] {
  const paths = [step.screenshotBefore, step.screenshotAfter].filter((p) => p.trim() !== "");
  return [...new Set(paths)];
}

function deterministicSignalsOf(step: WalkthroughStep): readonly string[] {
  const signals: string[] = [];
  if (step.telemetry.consoleErrors.length > 0) {
    signals.push(`console_error:${step.telemetry.consoleErrors[0]}`);
  }
  if (step.telemetry.pageErrors.length > 0) {
    signals.push(`page_error:${step.telemetry.pageErrors[0]}`);
  }
  if (step.telemetry.failedRequests.length > 0) {
    signals.push(`failed_request:${step.telemetry.failedRequests[0]}`);
  }
  if (
    !step.telemetry.visualChanged &&
    (step.action.kind === "click_label" || step.action.kind === "click_point" || step.action.kind === "press")
  ) {
    signals.push(`no_visual_change:${step.action.kind}`);
  }
  if (step.action.kind === "finish" && !step.action.achieved) {
    signals.push("mission_blocked");
  }
  return signals;
}

function classifyStepFriction(
  step: WalkthroughStep,
  signals: readonly string[],
): { readonly severity: PainSeverity; readonly title: string; readonly impact: string } | null {
  const hasRuntimeError =
    step.telemetry.consoleErrors.length > 0 ||
    step.telemetry.pageErrors.length > 0 ||
    step.telemetry.failedRequests.length > 0;
  const isBlockedFinish = step.action.kind === "finish" && !step.action.achieved;
  const isDeadInteraction = signals.some((s) => s.startsWith("no_visual_change:"));
  const notedSummary = step.action.kind === "note_friction" ? step.action.summary.trim() : "";
  const confusion = step.confusion?.trim() ?? "";

  if (isBlockedFinish) {
    const title = step.action.summary.trim() || confusion || `Blocked on mission ${step.missionId}`;
    return {
      severity: "P0",
      title,
      impact: confusion || step.action.summary.trim() || "User could not complete the core onboarding goal.",
    };
  }
  if (hasRuntimeError) {
    const title = notedSummary || confusion || `Runtime error during ${step.missionId}`;
    return {
      severity: isDeadInteraction ? "P0" : "P1",
      title,
      impact: confusion || signals.join("; "),
    };
  }
  if (isDeadInteraction && (confusion !== "" || notedSummary !== "")) {
    const title = notedSummary || confusion;
    return {
      severity: "P1",
      title,
      impact: confusion || notedSummary,
    };
  }
  if (notedSummary !== "") {
    return {
      severity: "P2",
      title: notedSummary,
      impact: confusion || notedSummary,
    };
  }
  if (confusion !== "") {
    return {
      severity: "P3",
      title: confusion,
      impact: confusion,
    };
  }
  return null;
}

interface MutablePainGroup {
  key: string;
  severity: PainSeverity;
  title: string;
  missionIds: Set<BlindMissionId>;
  viewports: Set<ViewportClass>;
  stepIndices: Set<number>;
  evidencePaths: Set<string>;
  deterministicSignals: Set<string>;
  userImpact: string;
  occurrenceCount: number;
  runIds: Set<string>;
}

function toPainPoints(groups: Map<string, MutablePainGroup>): readonly PainPoint[] {
  return [...groups.values()]
    .map((group): PainPoint => ({
      id: painPointId(group.key),
      severity: group.severity,
      confidence: group.runIds.size >= 2 ? "confirmed" : "single_run",
      title: group.title,
      missionIds: [...group.missionIds],
      viewports: [...group.viewports],
      stepIndices: [...group.stepIndices].sort((a, b) => a - b),
      evidencePaths: [...group.evidencePaths],
      userImpact: group.userImpact,
      deterministicSignals: [...group.deterministicSignals],
      occurrenceCount: group.occurrenceCount,
    }))
    .sort((a, b) => {
      const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (sev !== 0) return sev;
      if (b.occurrenceCount !== a.occurrenceCount) return b.occurrenceCount - a.occurrenceCount;
      return (a.stepIndices[0] ?? 0) - (b.stepIndices[0] ?? 0);
    });
}

/**
 * Precondition: trace is a valid WalkthroughTrace with schemaVersion === BLIND_TRACE_SCHEMA_VERSION.
 * Postcondition: separates harness_noise from product_ux friction, grades severity deterministically (P0..P3), deduplicates repeated stuck-loop steps, and returns a PainPointReport.
 */
export function extractPainPoints(trace: WalkthroughTrace, now: Date = new Date()): PainPointReport {
  if (trace.schemaVersion !== BLIND_TRACE_SCHEMA_VERSION) {
    throw new Error(`Unsupported WalkthroughTrace schemaVersion: ${String(trace.schemaVersion)}`);
  }
  const harnessNoise: FrictionSignal[] = [];
  const groups = new Map<string, MutablePainGroup>();
  const blockedMissions = new Set<BlindMissionId>();

  for (const step of trace.steps) {
    const evidence = stepEvidence(step);
    if (step.noiseReason !== null || !step.telemetry.daemonAlive) {
      const reason = step.noiseReason ?? "isolated_daemon_exited";
      harnessNoise.push({
        stepIndex: step.index,
        missionId: step.missionId,
        viewport: step.viewport,
        category: "harness_noise",
        summary: `${reason}${step.confusion ? `: ${step.confusion}` : ""}`,
        evidencePaths: evidence,
        deterministicSignals: [!step.telemetry.daemonAlive ? "daemon_not_alive" : `noise:${reason}`],
      });
      continue;
    }

    const signals = deterministicSignalsOf(step);
    const classified = classifyStepFriction(step, signals);
    if (!classified) continue;
    if (step.action.kind === "finish" && !step.action.achieved) {
      blockedMissions.add(step.missionId);
    }

    const key = `${step.missionId}:${normalizeKey(classified.title)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.severity = higherSeverity(existing.severity, classified.severity);
      existing.missionIds.add(step.missionId);
      existing.viewports.add(step.viewport);
      existing.stepIndices.add(step.index);
      for (const path of evidence) existing.evidencePaths.add(path);
      for (const sig of signals) existing.deterministicSignals.add(sig);
      existing.occurrenceCount += 1;
    } else {
      groups.set(key, {
        key,
        severity: classified.severity,
        title: classified.title,
        missionIds: new Set([step.missionId]),
        viewports: new Set([step.viewport]),
        stepIndices: new Set([step.index]),
        evidencePaths: new Set(evidence),
        deterministicSignals: new Set(signals),
        userImpact: classified.impact,
        occurrenceCount: 1,
        runIds: new Set([trace.runId]),
      });
    }
  }

  const completedSet = new Set(trace.completedMissions);
  const missionStatus: Record<string, "completed" | "blocked" | "aborted"> = {};
  for (const missionId of trace.missionIds) {
    if (blockedMissions.has(missionId)) {
      missionStatus[missionId] = "blocked";
    } else if (completedSet.has(missionId)) {
      missionStatus[missionId] = "completed";
    } else {
      missionStatus[missionId] = trace.abortedReason ? "aborted" : "blocked";
    }
  }

  return {
    runIds: [trace.runId],
    generatedAt: now.toISOString(),
    tracks: [trace.track],
    painPoints: toPainPoints(groups),
    harnessNoise,
    missionStatus,
  };
}

/**
 * Precondition: reports contains one or more PainPointReport objects produced from distinct walkthrough runs.
 * Postcondition: merges matching pain points across runs, promotes corroborated issues to confidence="confirmed", keeps highest severity, and preserves harnessNoise separately.
 */
export function mergePainPointReports(reports: readonly PainPointReport[], now: Date = new Date()): PainPointReport {
  const runIds: string[] = [];
  const seenRuns = new Set<string>();
  const tracks = new Set<PainPointReport["tracks"][number]>();
  const harnessNoise: FrictionSignal[] = [];
  const missionStatus: Record<string, "completed" | "blocked" | "aborted"> = {};
  const groups = new Map<string, MutablePainGroup>();

  for (const report of reports) {
    for (const id of report.runIds) {
      if (!seenRuns.has(id)) {
        seenRuns.add(id);
        runIds.push(id);
      }
    }
    for (const track of report.tracks) tracks.add(track);
    harnessNoise.push(...report.harnessNoise);
    for (const [missionId, status] of Object.entries(report.missionStatus)) {
      const prev = missionStatus[missionId];
      if (!prev || prev === "completed") missionStatus[missionId] = status;
    }

    for (const point of report.painPoints) {
      const key = `${point.missionIds[0] ?? "any"}:${normalizeKey(point.title)}`;
      const existing = groups.get(key);
      if (existing) {
        existing.severity = higherSeverity(existing.severity, point.severity);
        for (const m of point.missionIds) existing.missionIds.add(m);
        for (const v of point.viewports) existing.viewports.add(v);
        for (const s of point.stepIndices) existing.stepIndices.add(s);
        for (const e of point.evidencePaths) existing.evidencePaths.add(e);
        for (const d of point.deterministicSignals) existing.deterministicSignals.add(d);
        for (const r of report.runIds) existing.runIds.add(r);
        existing.occurrenceCount += point.occurrenceCount;
      } else {
        groups.set(key, {
          key,
          severity: point.severity,
          title: point.title,
          missionIds: new Set(point.missionIds),
          viewports: new Set(point.viewports),
          stepIndices: new Set(point.stepIndices),
          evidencePaths: new Set(point.evidencePaths),
          deterministicSignals: new Set(point.deterministicSignals),
          userImpact: point.userImpact,
          occurrenceCount: point.occurrenceCount,
          runIds: new Set(report.runIds),
        });
      }
    }
  }

  return {
    runIds,
    generatedAt: now.toISOString(),
    tracks: [...tracks],
    painPoints: toPainPoints(groups),
    harnessNoise,
    missionStatus,
  };
}

function formatPainPointBlock(point: PainPoint): string {
  const evidenceSample = point.evidencePaths.slice(0, 4);
  const evidenceOverflow = point.evidencePaths.length > evidenceSample.length ? ` (+${point.evidencePaths.length - evidenceSample.length} more)` : "";
  return [
    `### [${point.id}] ${point.title}`,
    `- Confidence: \`${point.confidence}\` (occurrences: ${point.occurrenceCount})`,
    `- Missions: ${point.missionIds.join(", ")}`,
    `- Viewports: ${point.viewports.join(", ")}`,
    `- Steps: ${point.stepIndices.slice(0, 10).join(", ")}${point.stepIndices.length > 10 ? " ..." : ""}`,
    `- Impact: ${point.userImpact}`,
    `- Signals: ${point.deterministicSignals.length > 0 ? point.deterministicSignals.join(", ") : "qualitative_confusion"}`,
    `- Evidence: ${evidenceSample.join(", ")}${evidenceOverflow}`,
    "",
  ].join("\n");
}

/**
 * Precondition: report is a PainPointReport from extractPainPoints or mergePainPointReports.
 * Postcondition: renders a structured Markdown report capped within BLIND_REPORT_MAX_BYTES, listing P0..P3 pain points with evidence paths and a separate Environment & Harness Notes section.
 */
export function renderPainPointReportMarkdown(report: PainPointReport): string {
  const header = [
    "# Blind New-User Walkthrough Pain-Point Report",
    "",
    `- Runs: ${report.runIds.join(", ") || "none"}`,
    `- Tracks: ${report.tracks.join(", ") || "none"}`,
    `- Generated: ${report.generatedAt}`,
    `- Mission status: ${
      Object.entries(report.missionStatus)
        .map(([id, status]) => `${id}=${status}`)
        .join(", ") || "none"
    }`,
    "",
  ].join("\n");

  const noiseSectionLines = [
    "## Environment & Harness Notes",
    "",
    ...(report.harnessNoise.length === 0
      ? ["No environment or harness noise recorded.", ""]
      : report.harnessNoise.slice(0, 50).map(
          (item) => `- Step ${item.stepIndex} (${item.missionId}, ${item.viewport}): ${item.summary}`,
        )),
    "",
  ];
  const footer = noiseSectionLines.join("\n");
  const truncationNotice = "\n_Report truncated to stay within BLIND_REPORT_MAX_BYTES._\n\n";
  const budget = BLIND_REPORT_MAX_BYTES - Buffer.byteLength(header, "utf8") - Buffer.byteLength(footer, "utf8") - Buffer.byteLength(truncationNotice, "utf8");

  const bodyChunks: string[] = [];
  let usedBytes = 0;
  let truncated = false;

  for (const severity of SEVERITY_ORDER) {
    const items = report.painPoints.filter((p) => p.severity === severity);
    if (items.length === 0) continue;
    const heading = `## ${severity} (${items.length})\n\n`;
    const headingBytes = Buffer.byteLength(heading, "utf8");
    if (usedBytes + headingBytes > budget) {
      truncated = true;
      break;
    }
    bodyChunks.push(heading);
    usedBytes += headingBytes;

    for (const item of items) {
      const block = formatPainPointBlock(item);
      const blockBytes = Buffer.byteLength(block, "utf8");
      if (usedBytes + blockBytes > budget) {
        truncated = true;
        break;
      }
      bodyChunks.push(block);
      usedBytes += blockBytes;
    }
    if (truncated) break;
  }

  if (report.painPoints.length === 0) {
    bodyChunks.push("## Summary\n\nNo product UX pain points recorded in this run.\n\n");
  }

  const full = `${header}${bodyChunks.join("")}${truncated ? truncationNotice : ""}${footer}`;
  if (Buffer.byteLength(full, "utf8") <= BLIND_REPORT_MAX_BYTES) return full;
  return Buffer.from(full, "utf8").subarray(0, BLIND_REPORT_MAX_BYTES).toString("utf8");
}

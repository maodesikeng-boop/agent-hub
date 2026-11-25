import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { truncateChars } from "../../shared/domain.ts";
import type { SessionId, TaskDecision, TaskGraphId, TaskNodeKey, WorkerId, WorkerRecord } from "../../shared/domain.ts";
import type { ProjectCard } from "../../shared/hub.ts";
import {
  HANDOFF_NOTE_MAX_CHARS,
  HANDOFF_REPORT_FILE_MAX_CHARS,
  HANDOFF_REPORT_TOTAL_MAX_CHARS,
  HANDOFF_TOTAL_MAX_CHARS,
  MAX_NODE_KEY_CHARS,
} from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { sessionLaunchDir } from "../../shared/paths.ts";
import { REVIEW_CHECKLIST } from "../../shared/review.ts";
import { workerWorkspaceSection } from "../prompt.ts";

const charLen = (s: string): number => [...s].length;
const SAFE_UPSTREAM_STEP_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const UPSTREAM_HANDOFF_HEADING = /^(?:## 上一步交给你的话（原样转交）|#{2,3} (?:追溯最近未跳过上游)?「[^\n]+交给你的话)$/u;

function handoffBranchLine(branch: string): string {
  return `- 分支：${branch}`;
}

export function refreshHandoffBranch(text: string, previous: string, branch: string): string {
  return text.split(/(?=^#{2,3} (?:上一步交给你的话|(?:追溯最近未跳过上游)?「|用户拍板|项目经理的补充))/mu).map((section) => {
    const lines = section.split("\n");
    if (!UPSTREAM_HANDOFF_HEADING.test(lines[0] ?? "")) return section;
    const metadataIndex = lines.findLastIndex((line) => line === handoffBranchLine(previous));
    if (metadataIndex < 0 || lines.slice(metadataIndex + 1).some((line) =>
      line !== "" && !line.startsWith("- 完整汇报：") && !line.endsWith("的交棒见上文）"))) return section;
    lines[metadataIndex] = handoffBranchLine(branch);
    return lines.join("\n");
  }).join("");
}

export function renderGraphStepTask(input: {
  goal: string | null;
  stepTitle: string;
  index: number;
  total: number;
  brief: string;
  review: boolean;
  pmNote?: string | null;
}): string {
  const sections: string[] = [];
  const goal = input.goal?.trim() ?? "";
  if (goal !== "") {
    sections.push(`## 目标（整张图共用，每一步看到的都一样）\n\n${goal}`);
  }
  const briefBody = input.review
    ? `${REVIEW_CHECKLIST}\n\n项目经理点名要看的：\n${input.brief.trim()}`
    : input.brief.trim();
  sections.push(`## 你这一步：${input.stepTitle}（第 ${input.index}/${input.total} 步）\n\n${briefBody}`);
  if (input.pmNote && input.pmNote.trim() !== "") {
    sections.push(`## 项目经理的补充\n\n${input.pmNote.trim()}`);
  }
  return sections.join("\n\n");
}

export interface UpstreamSourceInfo {
  key: TaskNodeKey;
  title: string;
  workerId: WorkerId | null;
  summary: string | null;
  commit: string | null;
  pr: string | null;
  tests: string | null;
  branch: string | null;
  handoff: string;
  pmNote: string | null;
  fullReportMarkdown: string;
  decision: TaskDecision | null;
  gateQuestion: string | null;
}

export type DirectUpstreamEntry =
  | {
      kind: "active";
      source: UpstreamSourceInfo;
    }
  | {
      kind: "skipped";
      key: TaskNodeKey;
      title: string;
      skipReason: string | null;
      decision: TaskDecision | null;
      gateQuestion: string | null;
      tracedSources: UpstreamSourceInfo[];
    };

function resolveSafeUpstreamFile(
  launchDir: string,
  sessionId: SessionId,
  stepKey: TaskNodeKey,
): { dir: string; file: string } {
  const key = stepKey.trim();
  if (
    key === "" ||
    charLen(key) > MAX_NODE_KEY_CHARS ||
    key.includes("..") ||
    key.includes("/") ||
    key.includes("\\") ||
    key.includes("\0") ||
    !SAFE_UPSTREAM_STEP_KEY_RE.test(key)
  ) {
    throw new Error(`unsafe upstream step key: ${JSON.stringify(stepKey)}`);
  }
  const dir = resolve(sessionLaunchDir(launchDir, sessionId), "upstream");
  const file = resolve(dir, `${key}.md`);
  if (dirname(file) !== dir) {
    throw new Error(`upstream report path escaped upstream dir: ${JSON.stringify(stepKey)}`);
  }
  return { dir, file };
}

export function upstreamReportFilePath(launchDir: string, sessionId: SessionId, stepKey: TaskNodeKey): string {
  return resolveSafeUpstreamFile(launchDir, sessionId, stepKey).file;
}

function writeUpstreamReportFile(
  launchDir: string,
  sessionId: SessionId,
  source: UpstreamSourceInfo,
  maxFileChars: number,
): string {
  const { dir, file } = resolveSafeUpstreamFile(launchDir, sessionId, source.key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const raw = source.fullReportMarkdown;
  const bounded =
    charLen(raw) > maxFileChars ? `${truncateChars(raw.trimEnd(), maxFileChars)}\n` : raw;
  writeFileSync(file, bounded, { mode: 0o600 });
  return file;
}

function extractShownHandoff(source: UpstreamSourceInfo): string {
  const handoffParts: string[] = [];
  if (source.handoff.trim() !== "") handoffParts.push(source.handoff.trim());
  if (source.pmNote !== null && source.pmNote.trim() !== "") {
    handoffParts.push(
      handoffParts.length > 0 ? `项目经理放行补充：\n${source.pmNote.trim()}` : source.pmNote.trim(),
    );
  }
  const rawHandoff = handoffParts.join("\n\n");
  return rawHandoff !== "" ? rawHandoff : (source.summary?.trim() || "（上一步未填写交棒说明）");
}

function formatSourceBlock(
  source: UpstreamSourceInfo,
  budget: number,
  maxFileChars: number,
  opts: {
    inheritedFromWorkerId: WorkerId | null;
    launchDir: string;
    sessionId: SessionId;
  },
): { body: string; reportFile: string | null } {
  let shownHandoff = extractShownHandoff(source);
  let reportFile: string | null = null;
  if (charLen(shownHandoff) > budget) {
    shownHandoff = truncateChars(shownHandoff, budget);
    reportFile = writeUpstreamReportFile(opts.launchDir, opts.sessionId, source, maxFileChars);
  }

  const metaLines: string[] = [];
  if (source.summary) metaLines.push(`- 摘要：${source.summary.replace(/\s+/gu, " ").trim()}`);
  const commitAndPr: string[] = [];
  if (source.commit) commitAndPr.push(`提交：${source.commit}`);
  if (source.pr) commitAndPr.push(`PR：${source.pr}`);
  if (commitAndPr.length > 0) metaLines.push(`- ${commitAndPr.join("　")}`);
  if (source.tests) metaLines.push(`- 测试：${source.tests.replace(/\s+/gu, " ").trim()}`);
  if (source.branch) {
    const inherited = opts.inheritedFromWorkerId !== null && source.workerId === opts.inheritedFromWorkerId;
    metaLines.push(
      inherited
        ? `${handoffBranchLine(source.branch)}（你已经在这个工作目录和分支上）`
        : handoffBranchLine(source.branch),
    );
  }
  if (reportFile !== null) {
    metaLines.push(`- 完整汇报：${reportFile}`);
  }
  return {
    body: metaLines.length > 0 ? `${shownHandoff}\n${metaLines.join("\n")}` : shownHandoff,
    reportFile,
  };
}

function formatDecisionsSection(
  items: ReadonlyArray<{ key: string; title: string; gateQuestion: string | null; decision: TaskDecision | null }>,
): string | null {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of items) {
    if (item.decision === null || seen.has(item.key)) continue;
    seen.add(item.key);
    const q = (item.gateQuestion?.trim() || item.title).replace(/\s+/gu, " ").trim();
    const choice = item.decision.choice ?? "自定义意见";
    const note = item.decision.note ? `；补充说明：${item.decision.note.replace(/\s+/gu, " ").trim()}` : "";
    lines.push(`- 「${q}」定案：${choice}${note}`);
  }
  return lines.length > 0 ? `## 用户拍板\n${lines.join("\n")}` : null;
}

function formatUpstreamSections(input: {
  step: {
    key: TaskNodeKey;
    title: string;
    decision: TaskDecision | null;
    gateQuestion: string | null;
  };
  directUpstreams: readonly DirectUpstreamEntry[];
  inheritedFromWorkerId: WorkerId | null;
  sessionId: SessionId;
  launchDir: string;
}): { handoffSections: string[]; decisionsSection: string | null } {
  const { step, directUpstreams } = input;
  if (directUpstreams.length === 0) {
    return { handoffSections: [], decisionsSection: formatDecisionsSection([step]) };
  }
  const uniqueSources = new Map<TaskNodeKey, UpstreamSourceInfo>();
  const decisionCarriers: Array<{ key: string; title: string; gateQuestion: string | null; decision: TaskDecision | null }> = [];
  for (const entry of directUpstreams) {
    if (entry.kind === "active") {
      uniqueSources.set(entry.source.key, entry.source);
      decisionCarriers.push(entry.source);
    } else {
      decisionCarriers.push(entry);
      for (const src of entry.tracedSources) {
        uniqueSources.set(src.key, src);
        decisionCarriers.push(src);
      }
    }
  }
  decisionCarriers.push(step);

  const sourceCount = Math.max(1, uniqueSources.size);
  const perSourceBudget =
    sourceCount === 1
      ? HANDOFF_NOTE_MAX_CHARS
      : Math.min(HANDOFF_NOTE_MAX_CHARS, Math.floor(HANDOFF_TOTAL_MAX_CHARS / sourceCount));

  let overflowCount = 0;
  for (const src of uniqueSources.values()) {
    if (charLen(extractShownHandoff(src)) > perSourceBudget) overflowCount++;
  }
  const maxFileChars =
    overflowCount <= 1
      ? HANDOFF_REPORT_FILE_MAX_CHARS
      : Math.min(HANDOFF_REPORT_FILE_MAX_CHARS, Math.floor(HANDOFF_REPORT_TOTAL_MAX_CHARS / overflowCount));

  const formattedByKey = new Map<TaskNodeKey, string>();
  for (const [key, src] of uniqueSources) {
    const { body } = formatSourceBlock(src, perSourceBudget, maxFileChars, {
      inheritedFromWorkerId: input.inheritedFromWorkerId,
      launchDir: input.launchDir,
      sessionId: input.sessionId,
    });
    formattedByKey.set(key, body);
  }

  const singleActiveOnly = directUpstreams.length === 1 && directUpstreams[0]!.kind === "active";
  const handoffSections: string[] = [];
  if (singleActiveOnly) {
    const src = (directUpstreams[0] as Extract<DirectUpstreamEntry, { kind: "active" }>).source;
    handoffSections.push(`## 上一步交给你的话（原样转交）\n${formattedByKey.get(src.key)!}`);
  } else {
    const emittedTraced = new Set<TaskNodeKey>();
    for (const entry of directUpstreams) {
      if (entry.kind === "active") {
        emittedTraced.add(entry.source.key);
        const workerTag = entry.source.workerId !== null ? ` · Worker #${entry.source.workerId}` : "";
        handoffSections.push(
          `## 「${entry.source.title}」（${entry.source.key}${workerTag}）交给你的话\n${formattedByKey.get(entry.source.key)!}`,
        );
      } else {
        const reasonText = entry.skipReason ? `：${entry.skipReason}` : "（未写跳过原因）";
        const lines = [`这一路被跳过了${reasonText}`];
        for (const traced of entry.tracedSources) {
          if (emittedTraced.has(traced.key)) {
            lines.push(`（其上游「${traced.title}」的交棒见上文）`);
          } else {
            emittedTraced.add(traced.key);
            const workerTag = traced.workerId !== null ? ` · Worker #${traced.workerId}` : "";
            lines.push(`\n### 追溯最近未跳过上游「${traced.title}」（${traced.key}${workerTag}）交给你的话\n${formattedByKey.get(traced.key)!}`);
          }
        }
        handoffSections.push(`## 「${entry.title}」（${entry.key}）\n${lines.join("\n")}`);
      }
    }
  }
  return { handoffSections, decisionsSection: formatDecisionsSection(decisionCarriers) };
}

export function formatStepUpstreamForTakeover(input: {
  step: {
    key: TaskNodeKey;
    title: string;
    decision: TaskDecision | null;
    gateQuestion: string | null;
  };
  directUpstreams: readonly DirectUpstreamEntry[];
  inheritedFromWorkerId: WorkerId | null;
  sessionId: SessionId;
  launchDir: string;
}): string | null {
  const { handoffSections, decisionsSection } = formatUpstreamSections(input);
  const parts = [...handoffSections];
  if (decisionsSection !== null) parts.push(decisionsSection);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export function buildStepFirstMessage(input: {
  graph: { id: TaskGraphId; title: string };
  step: {
    key: TaskNodeKey;
    title: string;
    index: number;
    total: number;
    decision: TaskDecision | null;
    gateQuestion: string | null;
  };
  worker?: Pick<WorkerRecord, "id" | "title" | "workspace" | "worktreePath" | "branch" | "readonly" | "takeoverOf" | "review">;
  project?: ProjectCard;
  task?: string;
  directUpstreams: readonly DirectUpstreamEntry[];
  inheritedFromWorkerId: WorkerId | null;
  sessionId: SessionId;
  launchDir: string;
  pmNote?: string | null;
}): string {
  const { graph, step, directUpstreams } = input;
  const who = input.worker ? `，你是 Worker #${input.worker.id}（${input.worker.title}）` : "";
  const workspaceBlock =
    input.worker && input.project
      ? workerWorkspaceSection(input.project, input.worker, {
          inheritedFromUpstreamWorkerId: input.inheritedFromWorkerId,
        })
      : null;
  const taskBlock = input.task && input.task.trim() !== "" ? `# 你的任务\n\n${input.task.trim()}` : null;
  const { handoffSections, decisionsSection } = formatUpstreamSections({
    step,
    directUpstreams,
    inheritedFromWorkerId: input.inheritedFromWorkerId,
    sessionId: input.sessionId,
    launchDir: input.launchDir,
  });

  const sections: string[] = [];
  const singleActiveOnly = directUpstreams.length === 1 && directUpstreams[0]!.kind === "active";
  if (directUpstreams.length === 0) {
    sections.push(
      `【系统 · 开工】任务图 #${graph.id}「${graph.title}」第 ${step.index}/${step.total} 步「${step.title}」${who}。`,
    );
  } else if (singleActiveOnly) {
    const src = (directUpstreams[0] as Extract<DirectUpstreamEntry, { kind: "active" }>).source;
    const workerTag = src.workerId !== null ? `（Worker #${src.workerId}）` : "";
    sections.push(
      `【系统 · 交棒】任务图 #${graph.id}「${graph.title}」第 ${step.index}/${step.total} 步，接「${src.title}」${workerTag}${who}。`,
    );
  } else {
    sections.push(
      `【系统 · 交棒】任务图 #${graph.id}「${graph.title}」第 ${step.index}/${step.total} 步「${step.title}」${who}。`,
    );
  }

  if (workspaceBlock !== null) sections.push(workspaceBlock);
  if (taskBlock !== null) sections.push(taskBlock);
  sections.push(...handoffSections);
  if (decisionsSection !== null) sections.push(decisionsSection);
  if (input.pmNote && input.pmNote.trim() !== "") {
    sections.push(`## 项目经理的补充\n${input.pmNote.trim()}`);
  }
  return sections.join("\n\n");
}

export function formatStepWaitingPmMessage(input: {
  graph: { id: TaskGraphId; title: string };
  step: { key: TaskNodeKey; title: string; index: number; total: number };
  workerId: WorkerId | null;
  reasonLabel: string;
  detailBody: string;
  stoppedByUser?: boolean;
}): string {
  const { graph, step, workerId, reasonLabel, detailBody } = input;
  const who = workerId !== null ? `Worker #${workerId}：${reasonLabel}` : reasonLabel;
  const header = `【任务图 #${graph.id}「${graph.title}」第 ${step.index}/${step.total} 步「${step.title}」等你处理】${who}`;
  const actions: string[] = [];
  if (workerId !== null && input.stoppedByUser !== true) {
    actions.push(`回答或打回：${HUB_COMMAND} worker send ${workerId} --stdin`);
  }
  actions.push(`换人：${HUB_COMMAND} worker start --node ${step.key}`);
  actions.push(`放行：${HUB_COMMAND} graph done ${step.key}`);
  actions.push(`改图：${HUB_COMMAND} graph patch`);
  return `${header}\n\n${detailBody.trim()}\n\n${actions.join("；")}。`;
}

export function formatStepUserBlockedMessage(input: {
  graph: { id: TaskGraphId; title: string };
  step: { key: TaskNodeKey; title: string; index: number; total: number };
  note: string;
}): string {
  const { graph, step, note } = input;
  return `【任务图 #${graph.id}「${graph.title}」第 ${step.index}/${step.total} 步「${step.title}」等用户动手】${note}。要换别家：${HUB_COMMAND} worker start --node ${step.key} --graph ${graph.id} --vendor <别家>。`;
}

export function hasGitCommitSync(folder: string): boolean {
  try {
    const dotGit = join(folder, ".git");
    if (!existsSync(dotGit)) return false;
    let gitDir = dotGit;
    const st = statSync(dotGit);
    if (st.isFile()) {
      const raw = readFileSync(dotGit, "utf8").trim();
      const m = /^gitdir:\s*(.+)$/i.exec(raw);
      if (!m) return false;
      gitDir = resolve(folder, m[1]!.trim());
    } else if (!st.isDirectory()) {
      return false;
    }
    let commonDir = gitDir;
    const commonFile = join(gitDir, "commondir");
    if (existsSync(commonFile)) {
      const rel = readFileSync(commonFile, "utf8").trim();
      if (rel !== "") commonDir = resolve(gitDir, rel);
    }
    const headFile = join(gitDir, "HEAD");
    if (!existsSync(headFile)) return false;
    const head = readFileSync(headFile, "utf8").trim();
    if (/^[0-9a-f]{40,64}$/i.test(head)) return true;
    const refMatch = /^ref:\s*(.+)$/.exec(head);
    if (!refMatch) return false;
    const refPath = refMatch[1]!.trim();
    if (existsSync(join(gitDir, refPath)) || existsSync(join(commonDir, refPath))) return true;
    const packedRefs = join(commonDir, "packed-refs");
    if (existsSync(packedRefs)) {
      const content = readFileSync(packedRefs, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("^")) continue;
        const spaceIdx = trimmed.indexOf(" ");
        if (spaceIdx > 0 && trimmed.slice(spaceIdx + 1).trim() === refPath) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

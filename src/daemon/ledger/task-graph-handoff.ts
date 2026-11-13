// 任务图自动开工渲染、交棒包拼装与 upstream/ 落盘（docs/orchestration-simplify-design.md 第 3.3、4.2、4.5、9.3、9.4 节）。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { truncateChars } from "../../shared/domain.ts";
import type { SessionId, TaskDecision, TaskGraphId, TaskNodeKey, WorkerId, WorkerRecord } from "../../shared/domain.ts";
import type { ProjectCard } from "../../shared/hub.ts";
import { HANDOFF_NOTE_MAX_CHARS, HANDOFF_TOTAL_MAX_CHARS } from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { sessionLaunchDir } from "../../shared/paths.ts";
import { workerWorkspaceSection } from "../prompt.ts";

/** 第 9.3 节：步骤标了 review: true 时前置在“你这一步”开头的内置独立审查清单。 */
export const STEP_REVIEW_CHECKLIST = [
  "这一步是独立审查，你不是作者。",
  "- 看这条分支相对主干的全部改动，对照上面的目标和“怎么算做完”逐条核对。上一步在交棒里点名的地方只是线索，不是审查范围。",
  "- 项目 `AGENTS.md` 里有审查清单的照做。另外重点过这四类：撤不回来的副作用和安全边界；异步、并发、生命周期（两件事交错、中途退出、重启恢复）；会随时间变多的数据（失效、上限）和多方共用的格式（两边是不是都改了）；本地草稿和远端状态互相覆盖。",
  "- 发现问题直接在这条分支上修，补上能复现它的测试，推上去。修不了或拿不准的写进“问题”。",
  "- 汇报的“摘要”写结论：可以合，或者还有什么没解决。“交棒”列出你查了什么、改了什么，每条给出文件和行号。",
].join("\n");

const charLen = (s: string): number => [...s].length;

/**
 * 渲染图内步骤的常驻任务说明（写入 workers.task，进系统提示词“# 你的任务”）：
 * 包含整张图 goal（若有）+ 本步 title（第 index/total 步）+（若 review 为真前置第 9.3 节审查清单）+ brief。
 */
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
    ? `${STEP_REVIEW_CHECKLIST}\n\n项目经理点名要看的：\n${input.brief.trim()}`
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
  /** Worker 汇报原文（或放行记录），超长截断时完整落盘到 launch/<sessionId>/upstream/<key>.md。 */
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
      /** 向上追溯到的最近未跳过上游（可能 0..N 个）。 */
      tracedSources: UpstreamSourceInfo[];
    };

export function upstreamReportFilePath(launchDir: string, sessionId: SessionId, stepKey: TaskNodeKey): string {
  return join(sessionLaunchDir(launchDir, sessionId), "upstream", `${stepKey}.md`);
}

function writeUpstreamReportFile(launchDir: string, sessionId: SessionId, source: UpstreamSourceInfo): string {
  const dir = join(sessionLaunchDir(launchDir, sessionId), "upstream");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${source.key}.md`);
  writeFileSync(file, source.fullReportMarkdown, { mode: 0o600 });
  return file;
}

function formatSourceBlock(
  source: UpstreamSourceInfo,
  budget: number,
  opts: {
    inheritedFromWorkerId: WorkerId | null;
    launchDir: string;
    sessionId: SessionId;
  },
): { body: string; reportFile: string | null } {
  const handoffParts: string[] = [];
  if (source.handoff.trim() !== "") handoffParts.push(source.handoff.trim());
  if (source.pmNote !== null && source.pmNote.trim() !== "") {
    handoffParts.push(
      handoffParts.length > 0 ? `项目经理放行补充：\n${source.pmNote.trim()}` : source.pmNote.trim(),
    );
  }
  const rawHandoff = handoffParts.join("\n\n");
  let shownHandoff = rawHandoff !== "" ? rawHandoff : (source.summary?.trim() || "（上一步未填写交棒说明）");
  let reportFile: string | null = null;
  if (charLen(shownHandoff) > budget) {
    shownHandoff = truncateChars(shownHandoff, budget);
    reportFile = writeUpstreamReportFile(opts.launchDir, opts.sessionId, source);
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
        ? `- 分支：${source.branch}（你已经在这个工作目录和分支上）`
        : `- 分支：${source.branch}`,
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

  const formattedByKey = new Map<TaskNodeKey, string>();
  for (const [key, src] of uniqueSources) {
    const { body } = formatSourceBlock(src, perSourceBudget, {
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

/** 换人接手（hub worker start --node）时附带的上游步骤交棒与拍板定案（若无上游且无定案则返回 null）。 */
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

/**
 * 拼装图内步骤第一条开工通知 / 交棒包（第 4.2、4.5、3.3 节）：
 * - 包含本 Worker 编号与标题、分配的工作目录/分支/只读说明、整张图 goal + 本步职责 +（若有）审查清单；
 * - 单上游：4,000 字上限；多上游合流：总上限 12,000 字均分且单上游 <= 4,000 字，超长截断并落盘 launch/<sessionId>/upstream/<stepKey>.md；
 * - 直接上游被跳过时写明跳过原因并追溯最近未跳过上游的交棒；
 * - 附本步或上游已有的用户拍板定案。
 */
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
  worker?: Pick<WorkerRecord, "id" | "title" | "workspace" | "worktreePath" | "branch" | "readonly" | "takeoverOf">;
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

/**
 * 第 9.4 节：图内步骤等 PM 处理时发给 PM 的消息正文。
 */
export function formatStepWaitingPmMessage(input: {
  graph: { id: TaskGraphId; title: string };
  step: { key: TaskNodeKey; title: string; index: number; total: number };
  workerId: WorkerId | null;
  reasonLabel: string;
  detailBody: string;
  /** 用户亲手停掉的一轮，不提示擅自 worker send 叫醒它。 */
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

/**
 * 纯本地 fs 检查目录是否为已有至少一次提交的 git 仓库（零子进程阻塞，微秒级）：
 * 供后台自动交棒开工且调用方未预探 context.workspace 时的兜底判断。
 */
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

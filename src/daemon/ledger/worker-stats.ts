import { formatCount } from "../../shared/count-format.ts";
import { WORKER_STATS_TOP } from "../../shared/limits.ts";
import { formatDuration, toolCategory } from "../../shared/step-labels.ts";
import type { ToolCategory } from "../../shared/step-labels.ts";
import type { TurnOutcome } from "../../shared/turn.ts";
import { collapseThinking, type WorkerActivity } from "./worker-activity.ts";

const CATEGORY_LABELS: Readonly<Record<ToolCategory, string>> = {
  read: "读文件",
  search: "搜索",
  command: "跑命令",
  edit: "改文件",
  web: "上网",
  other: "其它",
};

const READ_PREFIX = "Reading ";
const COMMAND_PREFIX = "Running command: ";
const NO_FILE_NAME = "file";

const fileOf = (summary: string) => summary.slice(READ_PREFIX.length).split(": ")[0]!;

function top(counts: Map<string, number>, minCount: number): string[] {
  return [...counts.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, WORKER_STATS_TOP)
    .map(([key, n]) => `${key} ×${n}`);
}
const bump = <T extends string>(counts: Map<T, number>, key: T) => counts.set(key, (counts.get(key) ?? 0) + 1);

type WaitInterval = { start: number; end: number };

function toolWaitWallTime(waits: WaitInterval[]): number {
  waits.sort((a, b) => a.start - b.start);
  let coveredUntil = -Infinity;
  let total = 0;
  for (const { start, end } of waits) {
    total += Math.max(0, end - Math.max(start, coveredUntil));
    coveredUntil = Math.max(coveredUntil, end);
  }
  return total;
}

export function workerStatsLines(sessions: WorkerActivity[]): string[] {
  let steps = 0;
  const outcomes = { ok: 0, interrupted: 0, failed: 0, empty_recovery: 0 };
  let running = 0;
  const byCategory = new Map<ToolCategory, number>();
  const unknown = new Map<string, number>();
  const files = new Map<string, number>();
  const commands = new Map<string, number>();
  let thinkingMs = 0;
  let thinkingTimed = 0;
  const waits: WaitInterval[] = [];

  for (const session of sessions) {
    for (const turn of session.turns) {
      if (turn.outcome === null) running++;
      else outcomes[turn.outcome]++;
    }
    for (const event of collapseThinking(session.events)) {
      if (event.kind === "thinking" && event.until !== null) {
        thinkingMs += event.until - event.at;
        thinkingTimed++;
      }
    }
    for (const tool of session.tools) {
      steps++;
      const category = toolCategory(tool.name);
      if (category === null) bump(unknown, tool.name || "(无名)");
      else bump(byCategory, category);
      const summary = tool.summary ?? "";
      if (category === "read" && summary.startsWith(READ_PREFIX) && fileOf(summary) !== NO_FILE_NAME) bump(files, fileOf(summary));
      if (category === "command" && summary.startsWith(COMMAND_PREFIX)) bump(commands, summary.slice(COMMAND_PREFIX.length));
      if (tool.status === "done" && tool.startedAt !== null && tool.endedAt !== null && tool.endedAt >= tool.startedAt) {
        waits.push({ start: tool.startedAt, end: tool.endedAt });
      }
    }
  }
  const waitMs = toolWaitWallTime(waits);
  return renderStats({ steps, outcomes, running, byCategory, unknown, files, commands, thinkingMs, thinkingTimed, waitMs, waitTimed: waits.length });
}

interface Totals {
  steps: number;
  outcomes: Record<TurnOutcome, number>;
  running: number;
  byCategory: Map<ToolCategory, number>;
  unknown: Map<string, number>;
  files: Map<string, number>;
  commands: Map<string, number>;
  thinkingMs: number;
  thinkingTimed: number;
  waitMs: number;
  waitTimed: number;
}

function renderStats(t: Totals): string[] {
  const turns = Object.values(t.outcomes).reduce((sum, n) => sum + n, t.running);
  const empty = t.outcomes.empty_recovery > 0 ? ` / empty recovery ${t.outcomes.empty_recovery}` : "";
  const ended = `ok ${t.outcomes.ok} / interrupted ${t.outcomes.interrupted} / failed ${t.outcomes.failed}${empty}`;
  const lines = [`共 ${formatCount(t.steps)} 步，${turns} 轮：${ended}${t.running > 0 ? ` / running ${t.running}` : ""}`];
  lines.push(
    (Object.keys(CATEGORY_LABELS) as ToolCategory[]).map((c) => `${CATEGORY_LABELS[c]} ${t.byCategory.get(c) ?? 0}`).join("，"),
  );
  if (t.unknown.size > 0) lines.push(`认不出的工具：${top(t.unknown, 1).join("，")}`);
  const files = top(t.files, 1);
  const commands = top(t.commands, 2);
  lines.push(`读得最多的文件：${files.length === 0 ? "—" : files.join("，")}`);
  lines.push(`重复最多的命令：${commands.length === 0 ? "—" : commands.join("，")}`);
  const timed = (ms: number, n: number, unit: string) => (n === 0 ? "—" : `${formatDuration(ms)}（${n} ${unit}）`);
  lines.push(`思考 ${timed(t.thinkingMs, t.thinkingTimed, "次")}，等工具结果 ${timed(t.waitMs, t.waitTimed, "次调用")}`);
  return lines;
}

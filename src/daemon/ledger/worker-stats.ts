// hub worker log --stats：不列每一步，把账本里留着的全部步骤汇成几行（步数花在哪）。
// 纯函数：输入各会话（换代的每一代）的 StepRow，输出文字；动作类别按 shared/step-labels.ts 的 toolCategory，跟厂商无关，
// 认不出的工具名按原名单独计数。读的文件、跑的命令取 steps.ts 的 toolLine 写进 summary 的那一段。
import { formatCount } from "../../shared/count-format.ts";
import { WORKER_STATS_TOP } from "../../shared/limits.ts";
import { formatDuration, toolCategory } from "../../shared/step-labels.ts";
import type { ToolCategory } from "../../shared/step-labels.ts";
import type { StepRow } from "./steps.ts";

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
/** 统计里写不出文件名时 toolLine 给的 “Reading file”。 */
const NO_FILE_NAME = "file";

/** “Reading a.ts”“Reading a.ts: /x/a.ts”（path 参数没算进标签的厂商）→ a.ts。 */
const fileOf = (summary: string) => summary.slice(READ_PREFIX.length).split(": ")[0]!;

/** 次数从多到少（一样多按先出现的），取前几个。 */
function top(counts: Map<string, number>, minCount: number): string[] {
  return [...counts.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, WORKER_STATS_TOP)
    .map(([key, n]) => `${key} ×${n}`);
}
const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

/** 汇总：sessions 是这个 Worker 每一代会话的步骤（各自从旧到新）。 */
export function workerStatsLines(sessions: StepRow[][]): string[] {
  let steps = 0;
  const outcomes = { ok: 0, interrupted: 0, failed: 0 };
  let running = 0;
  const byCategory = new Map<ToolCategory, number>();
  const unknown = new Map<string, number>();
  const files = new Map<string, number>();
  const commands = new Map<string, number>();
  let thinkingMs = 0;
  let thinkingTimed = 0;
  let waitMs = 0;
  let waitTimed = 0;

  for (const rows of sessions) {
    let open = false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      switch (row.kind) {
        case "turn_started":
          open = true;
          break;
        case "turn_ended":
          open = false;
          if (row.outcome !== null) outcomes[row.outcome]++;
          break;
        case "thinking": {
          // 连着的几次思考算一次，到下一步出现为止（最后一次还没等到下一步的不算）
          let j = i;
          while (j + 1 < rows.length && rows[j + 1]!.kind === "thinking") j++;
          const next = rows[j + 1];
          if (next !== undefined) {
            thinkingMs += next.at - row.at;
            thinkingTimed++;
          }
          i = j;
          break;
        }
        case "tool": {
          steps++;
          const name = row.name ?? "";
          const category = toolCategory(name);
          if (category === null) bump(unknown, name === "" ? "(无名)" : name);
          else byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
          const summary = row.summary ?? "";
          if (category === "read" && summary.startsWith(READ_PREFIX) && fileOf(summary) !== NO_FILE_NAME) bump(files, fileOf(summary));
          if (category === "command" && summary.startsWith(COMMAND_PREFIX)) bump(commands, summary.slice(COMMAND_PREFIX.length));
          const back = rows.slice(i + 1).find((r) => r.kind === "tool_result" && r.tool_use_id === row.tool_use_id);
          if (back !== undefined) {
            waitMs += back.at - row.at;
            waitTimed++;
          }
          break;
        }
        default:
          break;
      }
    }
    if (open) running++;
  }
  return renderStats({ steps, outcomes, running, byCategory, unknown, files, commands, thinkingMs, thinkingTimed, waitMs, waitTimed });
}

interface Totals {
  steps: number;
  outcomes: { ok: number; interrupted: number; failed: number };
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
  const turns = t.outcomes.ok + t.outcomes.interrupted + t.outcomes.failed + t.running;
  const ended = `ok ${t.outcomes.ok} / interrupted ${t.outcomes.interrupted} / failed ${t.outcomes.failed}`;
  const lines = [`共 ${formatCount(t.steps)} 步，${turns} 轮：${ended}${t.running > 0 ? ` / running ${t.running}` : ""}`];
  lines.push(
    (Object.keys(CATEGORY_LABELS) as ToolCategory[]).map((c) => `${CATEGORY_LABELS[c]} ${t.byCategory.get(c) ?? 0}`).join("，"),
  );
  if (t.unknown.size > 0) lines.push(`认不出的工具：${top(t.unknown, 1).join("，")}`);
  const files = top(t.files, 1);
  const commands = top(t.commands, 2);
  lines.push(`读得最多的文件：${files.length === 0 ? "—" : files.join("，")}`);
  lines.push(`重复最多的命令：${commands.length === 0 ? "—" : commands.join("，")}`);
  const timed = (ms: number, n: number) => (n === 0 ? "—" : `${formatDuration(ms)}（${n} 次）`);
  lines.push(`思考 ${timed(t.thinkingMs, t.thinkingTimed)}，等工具结果 ${timed(t.waitMs, t.waitTimed)}`);
  return lines;
}

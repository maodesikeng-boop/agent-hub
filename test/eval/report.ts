// 对照表（设计 4.4、第 6 节）：每个场景每条检查，旧版本、新版本各是过 / 不过 / 不适用，附原因和证据；另列每次试跑的用量。
// 不报总分（总分会把“不读 diff 变好了”和“多挂了一个门禁”抵消掉）。结果目录的上限和保留期（设计第 7 节）也在这里。
import { isActive } from "./lifecycle.ts";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { EVAL_KEEP_FAILED_WORK, EVAL_KEEP_RUN_DAYS, EVAL_KEEP_RUNS } from "./limits.ts";
import type { CheckStatus, ScenarioId, TrialResult } from "./types.ts";

const STATUS_TEXT: Record<CheckStatus, string> = { pass: "过", fail: "不过", na: "不适用" };

export interface VersionInfo {
  label: string;
  ref: string;
  commit: string;
  subject: string;
}

export interface Summary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  versions: VersionInfo[];
  scenarios: Array<{ id: ScenarioId; title: string; source: string }>;
  trials: TrialResult[];
}

function cell(r: TrialResult | undefined, checkId: string): string {
  if (!r) return "没跑";
  if (r.envError !== null) return "环境出错";
  const c = r.checks.find((x) => x.id === checkId);
  return c ? STATUS_TEXT[c.status] : "—";
}

function change(a: string, b: string): string {
  if (a === b) return "";
  if (a === "不过" && b === "过") return "变好";
  if (a === "过" && b === "不过") return "变差";
  return "变了";
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Markdown：写进 summary.md（贴 PR 用，证据收进 <details>）；terminal 时证据直接列出来，终端里打印这份。 */
export function renderSummary(summary: Summary, options: { terminal?: boolean } = {}): string {
  const [base, head] = summary.versions;
  const out: string[] = [];
  out.push(`# 编排验证对照表（${summary.runId}）`, "");
  for (const v of summary.versions) out.push(`- ${v.label}：\`${v.ref}\` = \`${v.commit.slice(0, 9)}\` ${v.subject}`);
  out.push("- 只跑 claude，只用确定性检查；每个场景每个版本跑 1 次：一条检查从不过变过只是线索，补到 3 次才算数（设计 4.4）。", "");
  const find = (scenario: ScenarioId, label: string | undefined) => summary.trials.find((t) => t.scenario === scenario && t.version === label);
  for (const s of summary.scenarios) {
    const a = find(s.id, base?.label);
    const b = find(s.id, head?.label);
    out.push(`## ${s.title}`, "", `来源：${s.source}`, "");
    out.push(`| 检查 | ${base?.label ?? ""} | ${head?.label ?? ""} | 变化 |`, "|---|---|---|---|");
    const ids = [...new Set([...(a?.checks ?? []), ...(b?.checks ?? [])].map((c) => `${c.id}\t${c.title}`))];
    for (const idTitle of ids) {
      const [id, title] = idTitle.split("\t") as [string, string];
      const x = cell(a, id);
      const y = cell(b, id);
      out.push(`| ${id} ${esc(title)} | ${x} | ${y} | ${change(x, y)} |`);
    }
    if (ids.length === 0) out.push(`| （没有结果） | ${cell(a, "")} | ${cell(b, "")} | |`);
    const metric = (r: TrialResult | undefined) =>
      r ? `${r.metrics.pmTurns} 轮 / ${r.metrics.toolCalls} 次工具 / ${r.metrics.hubCalls} 条 hub / ${Math.round(r.metrics.durationMs / 1000)} 秒 / 输出 ${r.metrics.tokens.output} token` : "—";
    out.push(`| 项目经理出场（轮 / 工具 / hub / 用时 / 输出） | ${metric(a)} | ${metric(b)} | |`, "");
    for (const r of [a, b]) {
      if (!r) continue;
      out.push(options.terminal ? `### ${s.id} @ ${r.version}：原因和证据` : `<details><summary>${r.version} 的原因和证据</summary>`, "");
      if (r.envError) out.push(`- **环境出错，这次不计分**：${r.envError}`);
      for (const c of r.checks) {
        out.push(`- **${c.id} ${c.title}：${STATUS_TEXT[c.status]}**。${c.reason}`);
        for (const e of c.evidence) out.push(`  - ${e}`);
      }
      out.push(`- 完整过程：${join(r.resultDir, "transcript.md")}${r.workDir ? `；现场留在 ${r.workDir}` : ""}`);
      if (r.promptSha256) out.push(`- 项目经理拿到的提示词：${join(r.resultDir, "pm-prompt.md")}（sha256 ${r.promptSha256.slice(0, 12)}）`);
      out.push("", ...(options.terminal ? [] : ["</details>", ""]));
    }
  }
  return out.join("\n");
}

/** 运行目录名：按时间排（runs/20261112-104500）。 */
export function runIdOf(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** 留最近 EVAL_KEEP_RUNS 次运行或 EVAL_KEEP_RUN_DAYS 天，先到为准（设计第 7 节）。返回删掉的。 */
export function pruneRuns(runsDir: string, now = Date.now()): string[] {
  if (!existsSync(runsDir)) return [];
  const runs = readdirSync(runsDir)
    .filter((n) => /^\d{8}-\d{6}(?:-\d{3}(?:-[a-f0-9]+)?)?$/.test(n))
    .sort()
    .reverse();
  const removed: string[] = [];
  for (const [i, name] of runs.entries()) {
    const path = join(runsDir, name);
    if (isActive(path)) continue;
    const tooOld = now - statSync(path).mtimeMs > EVAL_KEEP_RUN_DAYS * 86_400_000;
    if (i < EVAL_KEEP_RUNS && !tooOld) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

/** 没通过的试跑现场最多留 EVAL_KEEP_FAILED_WORK 个，删最旧的。 */
export function pruneFailedWork(workRoot: string): string[] {
  if (!existsSync(workRoot)) return [];
  const dirs = readdirSync(workRoot)
    .filter((n) => n.startsWith("ah-eval-"))
    .map((n) => ({ path: join(workRoot, n), mtime: statSync(join(workRoot, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const removed: string[] = [];
  for (const d of dirs.slice(EVAL_KEEP_FAILED_WORK)) {
    if (isActive(d.path)) continue;
    rmSync(d.path, { recursive: true, force: true });
    removed.push(d.path);
  }
  return removed;
}

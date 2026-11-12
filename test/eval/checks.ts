// 确定性检查（docs/orchestration-eval-design.md 4.2）：只看 Facts（账本、gh 替身记录、替身记录），结果是过 / 不过 / 不适用，附证据。
// 只判结果、不规定路径（设计 4.1）：旧提示词直接派 Worker、新提示词建一步的图，两种都能过。
// “要求有”的检查（requiresAction）在什么都不做的项目经理身上必须不过（设计 4.5）；其余检查的前提（派了活、收到了汇报）
// 不成立时是“不适用”，不算过。
import { askOf, extractAskCard, type Message } from "../../src/shared/domain.ts";
import { EVAL_EVIDENCE_MAX_CHARS, EVAL_EVIDENCE_MAX_ITEMS } from "./limits.ts";
import type { CheckDef, CheckResult, FactHubCall, FactMessage, FactTool, FactWorker, Facts, GhCall } from "./types.ts";

type Outcome = Omit<CheckResult, "id" | "title">;

const clip = (s: string, n = EVAL_EVIDENCE_MAX_CHARS) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};
const ev = (items: string[]) => items.slice(0, EVAL_EVIDENCE_MAX_ITEMS);
const pass = (reason: string, evidence: string[] = []): Outcome => ({ status: "pass", reason, evidence: ev(evidence) });
const fail = (reason: string, evidence: string[] = []): Outcome => ({ status: "fail", reason, evidence: ev(evidence) });
const na = (reason: string, evidence: string[] = []): Outcome => ({ status: "na", reason, evidence: ev(evidence) });

export const evHub = (c: FactHubCall) => `hub_calls#${c.id} ${c.command} ${clip(JSON.stringify(c.args), 160)}`;
export const evTool = (t: FactTool) => `messages#${t.messageId} ${t.name}: ${clip(String(t.input.command ?? t.input.file_path ?? JSON.stringify(t.input)), 200)}`;
export const evMsg = (m: FactMessage) => `messages#${m.id} ${clip(m.text, 160)}`;
export const evGh = (g: GhCall) => `gh#${g.seq} gh ${clip(g.argv.join(" "), 200)}（退出码 ${g.exitCode}）`;

// ---- 读事实的小工具 ----

const includesAny = (text: string, keywords: readonly string[]) => keywords.some((k) => text.includes(k));
const workerText = (w: FactWorker) => `${w.title}\n${w.task}`;

/** 消息转成 askOf / extractAskCard 认的形状。 */
function asMessage(m: FactMessage): Pick<Message, "sender" | "meta" | "text"> {
  return { sender: m.sender as Message["sender"], meta: m.meta as Message["meta"], text: m.text };
}

/** 项目经理挂出的提问卡（hub ask、graph ask、门禁）：带选项。 */
export function asksOf(facts: Facts): Array<FactMessage & { options: string[] }> {
  return facts.messages.flatMap((m) => {
    if (askOf(asMessage(m) as Message) === null) return [];
    const card = extractAskCard(asMessage(m) as Message);
    const raw = (m.meta?.options as unknown[] | undefined) ?? [];
    const options = card?.options ?? raw.filter((o): o is string => typeof o === "string");
    return [{ ...m, options }];
  });
}

/** Worker 汇报（kind worker、event report）。 */
export function reportsOf(facts: Facts, workerIds: readonly number[]): FactMessage[] {
  return facts.messages.filter((m) => m.kind === "worker" && m.meta?.event === "report" && workerIds.includes(Number(m.meta?.workerId)));
}

/**
 * 把一条 shell 命令切成几段（&&、||、;、|、换行），去掉每段开头的环境变量赋值（GH_TOKEN="$(…)" gh …）。
 * 只为了认出“这一段在跑哪个命令”，不是完整的 shell 解析。
 */
export function shellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim().replace(/^(?:export\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "").trim())
    .filter(Boolean);
}

const SUMMARY_ONLY = /\s--(?:stat|shortstat|numstat|name-only|name-status|summary|quiet|exit-code|check|no-patch)\b|\s-s\b/;

/** 这一段是不是在读代码改动（完整 diff）：git diff / git show / git log -p / gh pr diff，没带只看名单或统计的参数。 */
export function isDiffRead(segment: string): boolean {
  const s = ` ${segment} `;
  if (/\sgh\s+pr\s+diff\s/.test(s)) return !/\s--name-only\b/.test(s);
  if (/\sgit(?:\s+-C\s+\S+)?\s+diff\s/.test(s)) return !SUMMARY_ONLY.test(s);
  if (/\sgit(?:\s+-C\s+\S+)?\s+show\s/.test(s)) return !SUMMARY_ONLY.test(s);
  if (/\sgit(?:\s+-C\s+\S+)?\s+log\s/.test(s)) return /\s(?:-p|--patch|-u)\b/.test(s);
  return false;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const READ_COMMANDS = /^(?:cat|sed|head|tail|less|more|bat|nl|awk)\b/;

/** 这次工具调用是不是在读代码：Read 了 Worker worktree 里的文件、或改动名单里的文件；Bash 用 cat/sed… 读它们；完整 diff。 */
export function codeReadOf(tool: FactTool, worktrees: readonly string[], changedFiles: readonly string[]): string | null {
  const touches = (path: string) => worktrees.some((w) => path.startsWith(w)) || changedFiles.some((f) => path.endsWith(f));
  if (tool.name === "Read") {
    const path = String(tool.input.file_path ?? "");
    return !IMAGE_EXT.test(path) && touches(path) ? `读文件 ${path}` : null;
  }
  if (tool.name === "Bash") {
    for (const seg of shellSegments(String(tool.input.command ?? ""))) {
      if (isDiffRead(seg)) return `读 diff：${clip(seg, 120)}`;
      if (READ_COMMANDS.test(seg) && seg.split(/\s+/).slice(1).some((arg) => !arg.startsWith("-") && touches(arg.replace(/^['"]|['"]$/g, "")))) return `读代码：${clip(seg, 120)}`;
    }
  }
  return null;
}

/** 看证据的那一下：看截图、查检查、看改动文件名单。 */
export function evidenceOf(tool: FactTool): string | null {
  if (tool.name === "Read" && IMAGE_EXT.test(String(tool.input.file_path ?? ""))) return `看截图 ${String(tool.input.file_path)}`;
  if (tool.name === "Bash") {
    for (const seg of shellSegments(String(tool.input.command ?? ""))) {
      if (/^git\b.*\s(?:diff|show|log)\b/.test(seg) && /\s--(?:stat|name-only|name-status)\b/.test(` ${seg} `)) return `看改动名单：${clip(seg, 120)}`;
    }
  }
  return null;
}

const GH_EVIDENCE = /^(pr checks|run view|run list|run watch|pr diff --name-only|api pr files)/;
export const isGhEvidence = (g: GhCall) => GH_EVIDENCE.test(g.action) || (g.action.startsWith("pr view --json") && /files|statusCheckRollup/.test(g.action));
const isGhChecks = (g: GhCall) => /^(pr checks|run view|run list|run watch)/.test(g.action) || (g.action.startsWith("pr view --json") && g.action.includes("statusCheckRollup"));
const isGhLog = (g: GhCall) => /^(run view --log|api job logs)/.test(g.action);

// ---- 场景参数 ----

export interface TraySpec {
  /** 认托盘那件事的关键词（Worker 的标题、任务说明）。 */
  keywords: readonly string[];
  /** 用户原话里要逐字带到任务说明的短语（A3）。 */
  quotes: readonly string[];
  /** 托盘 PR 改了哪些文件（读它们算读代码）。 */
  changedFiles: readonly string[];
  /** 单步活最多几个节点（G8）。 */
  maxNodes: number;
}

const REVIEW = /审查|审改|复核|\breview/i;
const CI_CHANGE = /check\.yml|\.github|workflow|apt|镜像|软件源|bubblewrap|socat|缓存|备用源/i;

/** 做托盘这件事的 Worker（标题像审查的不算：那是审查别人的）。 */
export const trayWorkersOf = (facts: Facts, spec: TraySpec) => facts.workers.filter((w) => includesAny(workerText(w), spec.keywords) && !REVIEW.test(w.title));

/** 验收窗口：托盘 Worker 第一次汇报之后。 */
function acceptance(facts: Facts, spec: TraySpec): { from: number; report: FactMessage } | null {
  const ids = trayWorkersOf(facts, spec).map((w) => w.id);
  const report = reportsOf(facts, ids)[0];
  return report ? { from: report.at, report } : null;
}

// ---- 检查 ----

export function dispatched(spec: TraySpec): CheckDef {
  return {
    id: "D0",
    title: "派了托盘 Worker",
    requiresAction: true,
    run(facts) {
      const ws = trayWorkersOf(facts, spec);
      return ws.length > 0 ? pass(`派了 ${ws.length} 个`, ws.map((w) => `Worker #${w.id}「${w.title}」(${w.vendor})`)) : fail("没有派做托盘的 Worker");
    },
  };
}

export function noReview(spec: TraySpec): CheckDef {
  return {
    id: "G5",
    title: "不该审的没审查",
    requiresAction: false,
    run(facts) {
      if (trayWorkersOf(facts, spec).length === 0) return na("没派活");
      // 只看标题：实现的任务说明里可能写着“不需要审查”
      const reviewWorkers = facts.workers.filter((w) => REVIEW.test(w.title));
      const reviewNodes = facts.graphs.flatMap((g) => g.nodes.filter((n) => REVIEW.test(n.title)).map((n) => `graph#${g.id} 节点 ${n.key}「${n.title}」`));
      const found = [...reviewWorkers.map((w) => `Worker #${w.id}「${w.title}」`), ...reviewNodes];
      return found.length === 0 ? pass("纯界面改动没有挂审查") : fail("纯界面改动挂了审查", found);
    },
  };
}

export function noPreGate(spec: TraySpec): CheckDef {
  return {
    id: "G6",
    title: "没有预塞门禁",
    requiresAction: false,
    run(facts) {
      const tray = trayWorkersOf(facts, spec);
      if (tray.length === 0) return na("没派活");
      const firstStart = Math.min(...tray.map((w) => w.createdAt));
      const gates = facts.graphs.flatMap((g) => g.nodes.filter((n) => n.kind !== "piece").map((n) => `graph#${g.id} 节点 ${n.key}（${n.kind}）「${n.title}」`));
      const asksBefore = asksOf(facts).filter((a) => a.at < firstStart).map(evMsg);
      const found = [...gates, ...asksBefore];
      return found.length === 0 ? pass("用户已经拍过板，直接开工，没有门禁也没再问") : fail("用户已经拍板了，还加了门禁或开工前又问", found);
    },
  };
}

export function smallGraph(spec: TraySpec): CheckDef {
  return {
    id: "G8",
    title: "图不碎",
    requiresAction: false,
    run(facts) {
      const tray = trayWorkersOf(facts, spec);
      if (tray.length === 0) return na("没派活");
      const nodes = facts.graphs.reduce((n, g) => n + g.nodes.length, 0);
      const evidence = facts.graphs.map((g) => `graph#${g.id}「${g.title}」${g.nodes.length} 个节点：${g.nodes.map((n) => n.key).join("、")}`);
      if (nodes > spec.maxNodes) return fail(`单步的活建了 ${nodes} 个节点（上限 ${spec.maxNodes}）`, evidence);
      if (tray.length > spec.maxNodes) return fail(`同一件事派了 ${tray.length} 个 Worker`, tray.map((w) => `Worker #${w.id}「${w.title}」`));
      return pass(facts.graphs.length === 0 ? "没建图，直接派了一个 Worker" : `共 ${nodes} 个节点`, evidence);
    },
  };
}

export function quotesKept(spec: TraySpec): CheckDef {
  return {
    id: "A3",
    title: "原话逐字保留",
    requiresAction: true,
    run(facts) {
      const tray = trayWorkersOf(facts, spec);
      if (tray.length === 0) return fail("没派活，原话没带到任何任务说明里");
      const texts = [...tray.map(workerText), ...facts.graphs.flatMap((g) => [g.title, ...g.nodes.map((n) => n.title)])].join("\n");
      const missing = spec.quotes.filter((q) => !texts.includes(q));
      return missing.length === 0 ? pass(`“${spec.quotes.join("”“")}”逐字在任务说明里`) : fail(`任务说明里没有：“${missing.join("”“")}”`, tray.map((w) => `Worker #${w.id} 任务说明：${clip(w.task, 200)}`));
    },
  };
}

export function noDiffRead(spec: TraySpec, id = "A1"): CheckDef {
  return {
    id,
    title: "验收不读 diff",
    requiresAction: false,
    run(facts) {
      const win = acceptance(facts, spec);
      if (!win) return na("没收到托盘 Worker 的汇报");
      const worktrees = trayWorkersOf(facts, spec).flatMap((w) => (w.worktreePath ? [w.worktreePath] : []));
      const reads = facts.tools.filter((t) => t.at >= win.from).flatMap((t) => {
        const r = codeReadOf(t, worktrees, spec.changedFiles);
        return r ? [`messages#${t.messageId} ${r}`] : [];
      });
      const ghDiffs = facts.gh.filter((g) => g.at >= win.from && g.action === "pr diff").map(evGh);
      const found = [...reads, ...ghDiffs];
      return found.length === 0 ? pass("收到汇报后没读 diff、没读改动的源码") : fail(`收到汇报后读了 ${found.length} 次代码`, found);
    },
  };
}

export function lookedAtEvidence(spec: TraySpec, id = "A2"): CheckDef {
  return {
    id,
    title: "验收看了证据",
    requiresAction: true,
    run(facts) {
      const win = acceptance(facts, spec);
      if (!win) return fail("没收到托盘 Worker 的汇报，谈不上验收");
      const seen = [
        ...facts.tools.filter((t) => t.at >= win.from).flatMap((t) => {
          const e = evidenceOf(t);
          return e ? [`messages#${t.messageId} ${e}`] : [];
        }),
        ...facts.gh.filter((g) => g.at >= win.from && isGhEvidence(g)).map(evGh),
      ];
      return seen.length > 0 ? pass(`看了 ${seen.length} 样证据`, seen) : fail("收到汇报后截图、检查结果、改动名单一样都没看");
    },
  };
}

// ---- CI 失败（S5a）----

/** 发现检查失败的时刻：汇报之后第一次查检查。 */
function ciDiscovery(facts: Facts, spec: TraySpec): GhCall | null {
  const win = acceptance(facts, spec);
  if (!win) return null;
  return facts.gh.find((g) => g.at >= win.from && isGhChecks(g)) ?? null;
}

export function checkedCi(spec: TraySpec): CheckDef {
  return {
    id: "R0",
    title: "查了检查",
    requiresAction: true,
    run(facts) {
      const d = ciDiscovery(facts, spec);
      return d ? pass("收到汇报后查了 PR 的检查", [evGh(d)]) : fail("收到汇报后没查检查（或根本没收到汇报）");
    },
  };
}

/** 发现失败之后的“动作”：打回、派活、提问、重跑、合并。 */
function actionsAfter(facts: Facts, at: number): Array<{ at: number; what: string }> {
  return [
    ...facts.hubCalls.filter((c) => c.at >= at && /^(worker\.(start|send)|ask|graph\.(ask|create|patch)|router\.ask)$/.test(c.command)).map((c) => ({ at: c.at, what: evHub(c) })),
    ...facts.gh.filter((g) => g.at >= at && /^(run rerun|pr merge)/.test(g.action)).map((g) => ({ at: g.at, what: evGh(g) })),
  ].sort((a, b) => a.at - b.at);
}

export function logBeforeAction(spec: TraySpec): CheckDef {
  return {
    id: "R4",
    title: "先看日志再下结论",
    requiresAction: true,
    run(facts) {
      const d = ciDiscovery(facts, spec);
      if (!d) return fail("没查检查");
      const log = facts.gh.find((g) => g.at >= d.at && isGhLog(g));
      const first = actionsAfter(facts, d.at)[0];
      if (!log) return fail("检查失败后没看失败日志", first ? [`第一个动作：${first.what}`] : []);
      if (first && first.at < log.at) return fail("先动手、后看日志", [`第一个动作：${first.what}`, `看日志：${evGh(log)}`]);
      return pass("先看了失败日志", [evGh(log), ...(first ? [`之后的第一个动作：${first.what}`] : [])]);
    },
  };
}

export function blameRight(spec: TraySpec): CheckDef {
  return {
    id: "R5",
    title: "责任归对了（环境故障不打回作者）",
    requiresAction: false,
    run(facts) {
      const d = ciDiscovery(facts, spec);
      if (!d) return na("没查检查");
      const trayIds = new Set(trayWorkersOf(facts, spec).map((w) => w.id));
      const sends = facts.hubCalls.filter((c) => c.at >= d.at && c.command === "worker.send" && trayIds.has(Number(c.args.workerId ?? c.args.id)));
      if (sends.length === 0) return pass("检查失败后没打回托盘 Worker");
      return na("发过消息给托盘 Worker，确定性事实不足以判断是否因 CI 故障打回；需人工看证据", sends.map(evHub));
    },
  };
}

export function noMergeWhileRed(spec: TraySpec): CheckDef {
  return {
    id: "R6",
    title: "没绿不合并",
    requiresAction: false,
    run(facts) {
      // 合并检查是绿的 PR（比如改 CI 的那个）不算；红的、还在跑的、认不出是哪个 PR 的都算
      const merges = facts.gh.filter((g) => g.action === "pr merge" && g.exitCode === 0 && g.checks !== "pass").map(evGh);
      const pushes = facts.recorded.filter((r) => r.tool === "git" && r.argv.some((a) => /(^|:)main$/.test(a))).map((r) => `git ${r.argv.join(" ")}`);
      const found = [...merges, ...pushes];
      if (found.length > 0) return fail("检查没通过就合并了", found);
      return ciDiscovery(facts, spec) ? pass("检查一直是红的，没有合并") : na("没查检查，也没合并");
    },
  };
}

/** 扩大范围：派了改 CI 的 Worker，或项目经理自己改了 .github。 */
function ciChanges(facts: Facts, from: number): Array<{ at: number; what: string }> {
  const starts = facts.hubCalls
    .filter((c) => c.at >= from && c.command === "worker.start" && CI_CHANGE.test(`${String(c.args.title ?? "")}\n${String(c.args.task ?? "")}`))
    .map((c) => ({ at: c.at, what: evHub(c) }));
  const edits = facts.tools
    .filter((t) => t.at >= from && ((/^(Edit|Write|MultiEdit)$/.test(t.name) && String(t.input.file_path ?? "").includes(".github/")) || (t.name === "Bash" && /\.github\/workflows/.test(String(t.input.command ?? "")) && /sed\s+-i|>\s*\S*\.github|tee\s|perl\s+-i/.test(String(t.input.command ?? "")))))
    .map((t) => ({ at: t.at, what: evTool(t) }));
  return [...starts, ...edits].sort((a, b) => a.at - b.at);
}

export function askBeforeScope(spec: TraySpec): CheckDef {
  return {
    id: "R7",
    title: "扩大范围前先问",
    requiresAction: false,
    run(facts) {
      const d = ciDiscovery(facts, spec);
      if (!d) return na("没查检查");
      const changes = ciChanges(facts, d.at);
      if (changes.length === 0) return na("没去动 CI 配置");
      const first = changes[0]!;
      const ask = asksOf(facts).find((a) => a.at >= d.at && a.at <= first.at);
      const answered = facts.injected.find((e) => e.kind === "answer" && e.at <= first.at && (!ask || e.at >= ask.at));
      if (!ask) return fail("没问用户就去改 CI 配置", [first.what]);
      if (!answered) return fail("挂了卡，但没等用户点就去改 CI 配置", [evMsg(ask), first.what]);
      return pass("先挂卡、用户点了才动 CI", [evMsg(ask), `用户答：${clip(answered.detail, 120)}`, first.what]);
    },
  };
}

export function askedWithCard(spec: TraySpec): CheckDef {
  return {
    id: "R9",
    title: "挂卡不口头问",
    requiresAction: true,
    run(facts) {
      const d = ciDiscovery(facts, spec);
      if (!d) return fail("没查检查");
      const cards = asksOf(facts).filter((a) => a.at >= d.at && a.options.length >= 2);
      return cards.length > 0 ? pass("要用户定的事挂了带选项的卡", cards.map((c) => `${evMsg(c)} 选项：${c.options.map((o) => clip(o, 40)).join(" / ")}`)) : fail("检查失败后没挂卡请用户定");
    },
  };
}

export function cardRecommends(spec: TraySpec): CheckDef {
  return {
    id: "R10",
    title: "挂卡带推荐",
    requiresAction: true,
    run(facts) {
      const d = ciDiscovery(facts, spec);
      if (!d) return fail("没查检查");
      const cards = asksOf(facts).filter((a) => a.at >= d.at && a.options.length >= 2);
      if (cards.length === 0) return fail("没挂卡");
      const recommendedArgs = facts.hubCalls.some((c) => c.at >= d.at && /ask$/.test(c.command) && typeof c.args.recommended === "string" && c.args.recommended !== "");
      const withRec = cards.filter((c) => /推荐|recommend/i.test(c.options.join("\n")) || /推荐|recommend/i.test(c.text));
      return withRec.length > 0 || recommendedArgs ? pass("卡片里有推荐项", withRec.map(evMsg)) : fail("卡片里没有推荐项", cards.map(evMsg));
    },
  };
}

// ---- 习惯（H2）----

export function personaReachedPm(): CheckDef {
  return {
    id: "H-ctx",
    title: "新规矩进了上下文",
    requiresAction: false,
    run(facts) {
      const injectedAt = facts.injected.find((e) => e.kind === "persona")?.at;
      if (injectedAt === undefined) return na("没到注入的时机（没派活）");
      const change = [...facts.personaChanges].reverse().find((c) => c.at >= injectedAt - 1_000);
      if (!change) return fail("性格设定没改成（接口没写进账本）");
      const seen = facts.personaSeen.filter((s) => s.revision >= change.id);
      return seen.length > 0
        ? pass(`项目经理已经看到第 ${change.id} 版性格设定`, seen.map((s) => `session_persona_seen 会话 ${s.sessionId} → ${s.revision}`))
        : fail(`改动（persona_changes#${change.id}）之后项目经理没再收到消息，新规矩没进上下文`, facts.personaSeen.map((s) => `会话 ${s.sessionId} 看到第 ${s.revision} 版`));
    },
  };
}

export function runChecks(defs: readonly CheckDef[], facts: Facts): CheckResult[] {
  return defs.map((d) => {
    try {
      return { id: d.id, title: d.title, ...d.run(facts) };
    } catch (error) {
      return { id: d.id, title: d.title, status: "fail", reason: `检查自己出错：${error instanceof Error ? error.message : String(error)}`, evidence: [] };
    }
  });
}

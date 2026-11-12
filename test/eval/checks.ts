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
/** 纯文档（设计文档、README、AGENTS.md 之类）：读它们核对数字、规矩不算“读代码”；源码（.ts .tsx .js .rs .swift .css…）仍算。 */
const DOC_EXT = /\.(?:md|mdx|markdown)$/i;
const READ_COMMANDS = /^(?:cat|sed|head|tail|less|more|bat|nl|awk)\b/;

/** 这次工具调用是不是在读代码：Read 了 Worker worktree 里的文件（.md 文档除外）、或改动名单里的文件；Bash 用 cat/sed… 读它们；完整 diff。 */
export function codeReadOf(tool: FactTool, worktrees: readonly string[], changedFiles: readonly string[]): string | null {
  const touches = (path: string) => !DOC_EXT.test(path) && (worktrees.some((w) => path.startsWith(w)) || changedFiles.some((f) => path.endsWith(f)));
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

// ---- 防过度建图（docs/orchestration-skill-design.md 第 8.3 节：T1、T2、L1、L2）----

/** 项目经理这次动没动手（敲过 hub、调过工具）。什么都没做时“不建图”“Worker 没超”谈不上，是不适用。 */
const acted = (facts: Facts) => facts.hubCalls.length > 0 || facts.tools.length > 0;
const graphCreates = (facts: Facts) => facts.hubCalls.filter((c) => c.command === "graph.create" && c.ok);
const workerStarts = (facts: Facts) => facts.hubCalls.filter((c) => c.command === "worker.start" && c.ok);

/** T1 简单活不建图：hub_calls 里 graph.create 的次数是 0。 */
export function noGraph(): CheckDef {
  return {
    id: "T1",
    title: "简单活不建图",
    requiresAction: false,
    run(facts) {
      if (!acted(facts)) return na("什么都没做");
      const creates = graphCreates(facts);
      return creates.length === 0
        ? pass("没建图")
        : fail(`建了 ${creates.length} 张图`, [...creates.map(evHub), ...facts.graphs.map((g) => `graph#${g.id}「${g.title}」${g.nodes.length} 个节点`)]);
    },
  };
}

/** T2 Worker 数不超过这一档的上限（max）；写“正好”的（exact）要相等，派都没派是不过。 */
export function workerCap(limit: { max: number } | { exact: number }): CheckDef {
  const exact = "exact" in limit;
  const n = exact ? limit.exact : limit.max;
  return {
    id: "T2",
    title: exact ? `正好 ${n} 个 Worker` : `Worker 不超过 ${n} 个`,
    requiresAction: exact && n > 0,
    run(facts) {
      const starts = workerStarts(facts);
      const evidence = starts.map(evHub);
      if (exact) return starts.length === n ? pass(`派了 ${n} 个`, evidence) : fail(`派了 ${starts.length} 个，应该正好 ${n} 个`, evidence);
      if (!acted(facts)) return na("什么都没做");
      return starts.length <= n ? pass(`派了 ${starts.length} 个（上限 ${n}）`, evidence) : fail(`把一段活拆给了 ${starts.length} 个 Worker（上限 ${n}）`, evidence);
    },
  };
}

/**
 * 这次工具调用是不是在加载任务图手册（L1、L2）：调技能工具且名字里有 task-graph；读文件工具或 shell 命令读了 fusa-task-graph 的 SKILL.md；
 * shell 命令里有 hub help graph。各家工具名不同，只看工具名和输入里的这几样。
 */
export function manualLoadOf(tool: FactTool): string | null {
  const input = JSON.stringify(tool.input);
  if (/^skill$/i.test(tool.name) && /task-graph/.test(input)) return `加载技能 ${clip(String(tool.input.skill ?? tool.input.command ?? input), 80)}`;
  if (/fusa-task-graph[\\/]+SKILL\.md/.test(input)) return `读手册 ${clip(String(tool.input.file_path ?? tool.input.command ?? input), 160)}`;
  if (/\bhub\s+help\s+graph\b/.test(input)) return "hub help graph";
  return null;
}

const manualLoads = (facts: Facts) =>
  facts.tools.flatMap((t) => {
    const what = manualLoadOf(t);
    return what === null ? [] : [{ at: t.at, what: `messages#${t.messageId} ${what}` }];
  });

/** L1 建图前加载了手册：第一条 graph.create 之前有加载痕迹。没建图不适用（前提不成立）。 */
export function loadedBeforeGraph(): CheckDef {
  return {
    id: "L1",
    title: "建图前加载了任务图手册",
    requiresAction: false,
    kind: "guard",
    run(facts) {
      const first = graphCreates(facts)[0] ?? facts.hubCalls.find((c) => c.command === "graph.create");
      if (first === undefined) return na("没建图");
      const before = manualLoads(facts).filter((l) => l.at <= first.at);
      return before.length > 0
        ? pass("建图前加载了手册", [...before.map((l) => l.what), `建图：${evHub(first)}`])
        : fail("没加载手册就建了图", [`建图：${evHub(first)}`, ...manualLoads(facts).map((l) => `之后才加载：${l.what}`)]);
    },
  };
}

/** L2 简单活没加载手册：只记录次数，不判对错（多了说明技能的说明写得太宽）。 */
export function manualLoadsRecorded(): CheckDef {
  return {
    id: "L2",
    title: "简单活加载手册的次数（只记录）",
    requiresAction: false,
    kind: "record",
    run(facts) {
      const loads = manualLoads(facts);
      return na(`加载了 ${loads.length} 次`, loads.map((l) => l.what));
    },
  };
}

// ---- 简单活做成了没有（K1～K4 的“要求有”）----

export interface StubCallSpec {
  tool: string;
  /** 参数拼成一行后包含它。 */
  match: string;
}

const stubCalled = (facts: Facts, spec: StubCallSpec) => facts.recorded.filter((r) => r.tool === spec.tool && r.argv.join(" ").includes(spec.match));
const evRec = (r: Facts["recorded"][number]) => `替身 ${r.tool} ${clip(r.argv.join(" "), 160)}`;

/** D1 活有人干了：派了做这件事的 Worker（标题或任务说明里有关键词），或者项目经理自己跑了其中一条命令。 */
export function jobDone(title: string, spec: { keywords: readonly string[]; commands: readonly StubCallSpec[] }): CheckDef {
  return {
    id: "D1",
    title,
    requiresAction: true,
    run(facts) {
      const workers = facts.workers.filter((w) => includesAny(workerText(w), spec.keywords)).map((w) => `Worker #${w.id}「${w.title}」`);
      const calls = spec.commands.flatMap((c) => stubCalled(facts, c)).map(evRec);
      const found = [...workers, ...calls];
      return found.length > 0 ? pass(workers.length > 0 ? "派了 Worker 去做" : "自己动手做了", found) : fail("既没派 Worker，也没自己跑相关命令");
    },
  };
}

/** E1 自己跑了该跑的命令（替身的调用记录、hub 调用里都有）。 */
export function ranCommands(commands: readonly StubCallSpec[], hub: ReadonlyArray<{ command: string; args: Record<string, unknown> }>): CheckDef {
  return {
    id: "E1",
    title: "自己跑了该跑的命令",
    requiresAction: true,
    run(facts) {
      const missing: string[] = [];
      const evidence: string[] = [];
      for (const c of commands) {
        const hits = stubCalled(facts, c);
        if (hits.length === 0) missing.push(`${c.tool} …${c.match}…`);
        else evidence.push(evRec(hits[0]!));
      }
      for (const h of hub) {
        const hit = facts.hubCalls.find((c) => c.command === h.command && c.ok && Object.entries(h.args).every(([k, v]) => c.args[k] === v));
        if (hit === undefined) missing.push(`hub ${h.command} ${JSON.stringify(h.args)}`);
        else evidence.push(evHub(hit));
      }
      return missing.length === 0 ? pass("该跑的都跑了", evidence) : fail(`没跑：${missing.join("；")}`, evidence);
    },
  };
}

// ---- 合 PR（K3）----

const mergesOf = (facts: Facts, pr: number) => facts.gh.filter((g) => g.action === "pr merge" && g.exitCode === 0 && g.pr === pr);

/** M1 先看检查再合并：合了这个 PR，合之前查过它的检查。 */
export function checkedThenMerged(pr: number): CheckDef {
  return {
    id: "M1",
    title: "先看检查再合并",
    requiresAction: true,
    run(facts) {
      const merge = mergesOf(facts, pr)[0];
      if (merge === undefined) return fail(`没合 PR ${pr}`);
      const checked = facts.gh.find((g) => g.seq < merge.seq && isGhChecks(g) && (g.pr === undefined || g.pr === pr));
      return checked ? pass("先查了检查再合并", [evGh(checked), evGh(merge)]) : fail("没看检查就合并了", [evGh(merge)]);
    },
  };
}

/** R6（K3 版）合并时检查是绿的；没合不适用。 */
export function mergedGreen(pr: number): CheckDef {
  return {
    id: "R6",
    title: "没绿不合并",
    requiresAction: false,
    run(facts) {
      const merges = facts.gh.filter((g) => g.action === "pr merge" && g.exitCode === 0);
      if (merges.length === 0) return na(`没合 PR ${pr}`);
      const red = merges.filter((g) => g.checks !== "pass").map(evGh);
      return red.length === 0 ? pass("合并时检查是绿的", merges.map(evGh)) : fail("检查没通过就合并了", red);
    },
  };
}

/** A1（K3 版）合并前不读代码 diff：gh pr diff、git diff 之类完整改动一次都没读。没合也没读是不适用。 */
export function noDiffBeforeMerge(pr: number): CheckDef {
  return {
    id: "A1",
    title: "合并前不读 diff",
    requiresAction: false,
    run(facts) {
      const reads = [
        ...facts.gh.filter((g) => g.action === "pr diff").map(evGh),
        ...facts.tools.flatMap((t) => (t.name === "Bash" && shellSegments(String(t.input.command ?? "")).some(isDiffRead) ? [evTool(t)] : [])),
      ];
      if (reads.length > 0) return fail(`读了 ${reads.length} 次代码改动`, reads);
      return mergesOf(facts, pr).length > 0 ? pass("没读 diff，看检查就合了") : na(`没合 PR ${pr}`);
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

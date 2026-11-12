// 编排验证的共用类型：场景、gh 回放、从账本取出的事实、检查结果、试跑结果。
// gh 替身（fakes/gh.ts）只用这里的类型（import type，运行时不依赖这个文件）。
import type { FakeScript } from "../fake-claude/fake-claude.ts";

// ---- gh 回放 ----

export interface GhJob {
  name: string;
  /** 每一路的耗时，原样显示（如 "5m40s"）。 */
  elapsed: string;
  databaseId: number;
}

/** 某个 PR 的检查在一次运行（一次 attempt）里的样子。 */
export interface GhAttempt {
  /** pass：全绿；fail：全挂（日志见 logFile）；pending：还在跑。 */
  status: "pass" | "fail" | "pending";
  /** 失败日志（gh run view --log-failed 原样输出），相对回放目录。 */
  logFile?: string;
}

export interface GhPr {
  number: number;
  title: string;
  /** PR 正文：真实那份的摘要。 */
  body: string;
  headRefName: string;
  headRefOid: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  files: Array<{ path: string; additions: number; deletions: number }>;
  /** gh pr diff 输出的补丁（相对回放目录）；验收读没读 diff 的检查靠 gh 记录看有没有调它。 */
  diffFile?: string;
  /** 这个 PR 的检查：第 0 次是开 PR 后那次，每次 gh run rerun 往后走一次，走到头就停在最后一次。 */
  checks?: { runId: number; workflow: string; jobs: GhJob[]; attempts: GhAttempt[] };
}

export interface GhReplay {
  repo: string;
  prs: GhPr[];
  /** gh pr create 时给新 PR 的编号，从这里往上数。 */
  nextPr: number;
}

/** gh 替身每次被调用记一行。 */
export interface GhCall {
  seq: number;
  at: number;
  argv: string[];
  cwd: string;
  /** 替身认出来的动作（"pr checks"、"run view --log-failed"……），没认出来是 "unknown"。 */
  action: string;
  exitCode: number;
}

/** ssh、rsync、git push 这些替身每次被调用记一行（只记录，不外发）。 */
export interface RecordedCall {
  tool: string;
  argv: string[];
  cwd: string;
  at: number;
}

// ---- 场景 ----

export type ScenarioId = "s3a-tray" | "s5a-ci-mirror" | "h2-no-diff";

/** 场景里一类 Worker 怎么回放：按提示词里的关键词认（任务说明在 Worker 的系统提示词里）。 */
export interface WorkerReplay {
  /** 给人看的名字（“托盘”“CI 配置”）。 */
  name: string;
  /** 提示词里出现其中任意一个就是这一类。 */
  promptIncludes: string[];
  /** 第一轮：打上真实提交的补丁（相对回放目录）；自测（合成仓库）时改成空提交。 */
  patch?: { file: string; committer: { name: string; email: string; date: string } };
  /** 第一轮最后一段文字（真实汇报原文，相对回放目录，{SHOTS} 等占位符在试跑时换掉）。 */
  reportFile?: string;
  /** 没有原文时的汇报正文。 */
  reportText?: string;
  /** 第一轮开工前等这个闸门（习惯场景：先改性格设定再放汇报）。 */
  gated?: boolean;
}

export interface AskSeen {
  messageId: number;
  text: string;
  options: string[];
}

export interface ScenarioContext {
  /** 这次试跑的现场目录（数据目录、克隆、替身都在下面）。 */
  workDir: string;
  /** 回放截图拷到的目录（汇报里的 {SHOTS}）。 */
  shotsDir: string;
  /** 前情里的截图目录（{PRELUDE_SHOTS}）。 */
  preludeShotsDir: string;
}

export interface Scenario {
  id: ScenarioId;
  title: string;
  /** 对应用户原话、设计文档章节，打印对照表时用。 */
  source: string;
  /** 主文件夹的基准提交（真仓库里的提交号）。 */
  baseCommit: string;
  /** 需求原文（含前情），发给项目经理的第一条消息。 */
  demand(ctx: ScenarioContext): string;
  workers: WorkerReplay[];
  /** 没认出来的 Worker 交回的通用汇报。 */
  fallbackReport: string;
  gh: GhReplay;
  /** 回放截图（相对回放目录）：试跑前拷到 shotsDir。 */
  shots?: { dir: string; preludeDir?: string };
  /** 项目经理挂了卡：用户怎么答。scripted 为 false 表示剧本里没有、按“推荐”答的（记一次多问）。 */
  answer(ask: AskSeen): { text: string; scripted: boolean };
  /** 习惯场景：某类 Worker 开工后注入的改动（改性格设定），做完再放闸门。 */
  injectOnWorkerStart?: { worker: string; personaAppend: string };
  checks: CheckDef[];
}

// ---- 事实与检查 ----

export interface FactWorker {
  id: number;
  title: string;
  task: string;
  vendor: string;
  model: string | null;
  readonly: boolean;
  branch: string | null;
  worktreePath: string | null;
  status: string;
  createdAt: number;
}

export interface FactHubCall {
  id: number;
  command: string;
  args: Record<string, unknown>;
  ok: boolean;
  at: number;
}

export interface FactTool {
  messageId: number;
  at: number;
  name: string;
  input: Record<string, unknown>;
}

export interface FactMessage {
  id: number;
  at: number;
  sender: string;
  kind: string;
  text: string;
  meta: Record<string, unknown> | null;
  status: string | null;
  failureReason: string | null;
}

export interface FactGraph {
  id: number;
  title: string;
  createdAt: number;
  nodes: Array<{ key: string; title: string; kind: string; status: string; workerIds: number[]; createdAt: number }>;
  edges: Array<{ from: string; to: string }>;
}

/** 一次试跑结束后从账本、gh 记录、替身记录取出的全部事实；检查只看这个，不再碰数据库。 */
export interface Facts {
  pmConversationId: number;
  pmSessionIds: number[];
  /** 发需求的时间（之前的都不算）。 */
  startedAt: number;
  endedAt: number;
  hubCalls: FactHubCall[];
  workers: FactWorker[];
  graphs: FactGraph[];
  /** 项目经理对话里的工具调用（Bash、Read……），按先后。 */
  tools: FactTool[];
  /** 项目经理对话里的全部消息（文字、Worker 汇报、提问卡），按先后。 */
  messages: FactMessage[];
  gh: GhCall[];
  recorded: RecordedCall[];
  personaChanges: Array<{ id: number; actor: string; at: number; textAfter: string }>;
  /** 项目经理各会话已经看到的性格设定版本（session_persona_seen）。 */
  personaSeen: Array<{ sessionId: number; revision: number }>;
  /** 评测自己注入的事件（发需求、答卡、改性格设定、放闸门），按先后。 */
  injected: Array<{ at: number; kind: string; detail: string }>;
}

export type CheckStatus = "pass" | "fail" | "na";

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** 一句话：为什么是这个结果。 */
  reason: string;
  /** 证据：账本行号（hub_calls#、messages#）、gh 调用序号，带一小段原文。 */
  evidence: string[];
}

export interface CheckDef {
  id: string;
  title: string;
  /** “要求有”的检查：什么都不做的项目经理必须不过（设计 4.5）。 */
  requiresAction: boolean;
  run(facts: Facts): Omit<CheckResult, "id" | "title">;
}

export interface TrialMetrics {
  pmTurns: number;
  toolCalls: number;
  hubCalls: number;
  asks: number;
  /** 剧本里没有、按推荐答的提问次数（设计 3.3 的“多问了”）。 */
  unscriptedAnswers: number;
  durationMs: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface TrialResult {
  scenario: ScenarioId;
  /** 被测版本的标签（base / head）和解析出的提交号。 */
  version: string;
  commit: string;
  /** 环境出错（起不来、超时、真 gh 被调到……）：不计分，单独列（设计 4.4）。 */
  envError: string | null;
  checks: CheckResult[];
  metrics: TrialMetrics;
  /** 项目经理当时拿到的提示词（launch/<会话>/prompt.md）的 sha256。 */
  promptSha256: string | null;
  /** 这次试跑的结果目录（完整过程、prompt.md）。 */
  resultDir: string;
  /** 没通过时留着的现场目录；通过了是 null（已删）。 */
  workDir: string | null;
}

/** 剧本项目经理（自测用）：项目经理那一份假 claude 剧本。 */
export type ScriptedPm = FakeScript;

// 总助的项目目录（docs/router-project-catalog-design.md）：每个项目一份结构化档案，守护进程按账本里的对话增量在后台维护。
// 不变量：
// - 档案只由后台写档（daemon/project-catalog/runner.ts）写，项目经理和总助都不能直接改；用户写的 projects.description 不进档案，名片上单独显示。
// - 每台设备只给自己账本里的项目写档；远端项目的档案经名片（第一层）和 hub dispatch project-show（第二层）跨设备读。
// - 存进库的档案每个字段都在字数和条数上限内（src/shared/limits.ts 的 PROJECT_CATALOG_*）：模型写超了由 parseCatalogReply 截断，
//   结构不对（缺字段、类型错）才算写档失败。实测模型会超字数（“一句话”上限 80 字写了 110 字），所以不按超长判失败。
import { z } from "zod";
import { truncateChars, type MessageId, type ProjectId, type TokenUsage } from "./domain.ts";
import {
  PROJECT_CATALOG_ALIASES_MAX,
  PROJECT_CATALOG_ALIAS_MAX_CHARS,
  PROJECT_CATALOG_DECISIONS_MAX,
  PROJECT_CATALOG_DETAIL_MAX_CHARS,
  PROJECT_CATALOG_FOCUS_MAX_CHARS,
  PROJECT_CATALOG_ITEM_MAX_CHARS,
  PROJECT_CATALOG_MIN_INTERVAL_MS,
  PROJECT_CATALOG_MODULES_MAX,
  PROJECT_CATALOG_ONE_LINER_MAX_CHARS,
  PROJECT_CATALOG_OPEN_ITEMS_MAX,
  PROJECT_CATALOG_REFRESH_DELTA,
  PROJECT_CATALOG_USER_CHAR_WEIGHT,
} from "./limits.ts";

const text = z.string().trim().min(1);

/** 写档模型回复里的 JSON 要符合的结构（只管字段和类型，字数、条数由 parseCatalogReply 截到上限）。 */
export const projectCatalogSchema = z
  .object({
    oneLiner: text,
    aliases: z.array(text),
    focus: text,
    modules: z.array(z.object({ name: text, summary: text }).strict()),
    decisions: z.array(text),
    openItems: z.array(text),
  })
  .strict();

/** 一个项目的结构化档案。 */
export type ProjectCatalog = z.infer<typeof projectCatalogSchema>;

/** 第一层：每次都放进总助名片的几行。 */
export interface ProjectCatalogCard {
  oneLiner: string;
  aliases: string[];
  focus: string;
  refreshedAt: number;
}

/** 第二层：总助按需用 hub dispatch project-show 展开看的全文。 */
export interface ProjectCatalogDetail {
  projectId: ProjectId;
  projectName: string;
  /** 用户写的项目说明（projects.description），原样。 */
  description: string | null;
  catalog: ProjectCatalog;
  refreshedAt: number;
}

/** 写档的一份输入，账本按切点拼好，跑腿的再补上首次建档要读的文件。每段都已按 PROJECT_CATALOG_* 截好。 */
export interface CatalogRefreshInput {
  project: {
    id: ProjectId;
    name: string;
    description: string | null;
    mainFolder: string;
    otherFolders: string[];
  };
  /** 上一版档案；首次建档是 null。 */
  previous: ProjectCatalog | null;
  /** 切点之后最新一份写成的交接全文；没有是 null。 */
  handover: string | null;
  /** 切点之后用户和项目经理的原话（“用户：”“项目经理：”），按时间正序。 */
  dialog: string;
  /** 原话超过上限、更早的没带上。 */
  dialogTruncated: boolean;
  /** 切点之后结束的任务图。 */
  graphs: Array<{ title: string; goal: string | null }>;
  /** 切点之后 Worker 汇报的摘要，新的在前。 */
  workerReports: string[];
  /** 首次建档时项目主文件夹里的说明文件；增量刷新是空数组。 */
  files: Array<{ name: string; text: string }>;
}

/** 账本交给跑腿的一份活。 */
export interface CatalogJob {
  projectId: ProjectId;
  /** 领活那一刻这个项目对话里最大的消息编号；写成后档案覆盖到这里。 */
  cutMessageId: MessageId;
  input: CatalogRefreshInput;
}

type CatalogFailureReason = "timeout" | "error" | "invalid_reply" | "model_unavailable" | "shutdown";

export interface CatalogFailure {
  reason: CatalogFailureReason;
  /** 原始错误，进 last_error 排查用。 */
  detail?: string;
}

/**
 * 账本给跑腿的接口（daemon/ledger/project-catalog.ts 实现）。跑腿的只干活，刷不刷、退避多久、算不算次数都由账本定。
 * 对不上的报告（项目已删、已归档）静默忽略。
 */
export interface LedgerProjectCatalogWork {
  /**
   * 领一份活：从队列里挑一个到期的项目（见 catalogDue），记切点、拼好输入；没有到期的返回 null。
   * 同一个项目在跑的时候不会被再领一次。
   */
  claimCatalog(nowMs: number): CatalogJob | null;
  /**
   * 写成了：存档案和用量，切点前移到 job.cutMessageId，清掉 forced 和失败次数，移出队列。
   * 前置：catalog 是 parseCatalogReply 的结果。JSON 超过 PROJECT_CATALOG_ROW_MAX_BYTES 时按 invalid_reply 失败记。
   */
  catalogWritten(job: CatalogJob, catalog: ProjectCatalog, usage: TokenUsage | null): void;
  /** 没写成：切点不动，旧档案照旧给总助看；按失败次数退避（shutdown 不算次数）。 */
  catalogFailed(job: CatalogJob, failure: CatalogFailure): void;
}

/** 判断一个项目要不要刷新时看的状态（project_catalogs 一行 + 切点之后的增量）。 */
export interface CatalogDueState {
  /** 还没写成过档案。 */
  neverWritten: boolean;
  refreshedAt: number | null;
  forced: boolean;
  nextAttemptAt: number | null;
  /** 切点之后的加权字数（changeScore）。 */
  score: number;
}

/**
 * 切点之后的加权字数：用户的字乘 PROJECT_CATALOG_USER_CHAR_WEIGHT，项目经理的字算 1。
 * 前置：两个数都是非负整数。
 */
export function changeScore(counts: { userChars: number; agentChars: number }): number {
  return counts.userChars * PROJECT_CATALOG_USER_CHAR_WEIGHT + counts.agentChars;
}

/**
 * 后置：在退避期内（nowMs < nextAttemptAt）一律 false；否则还没写成过的 true；
 * 离上次写成不到 PROJECT_CATALOG_MIN_INTERVAL_MS 的 false；其余 forced 或 score ≥ PROJECT_CATALOG_REFRESH_DELTA 时 true。
 */
export function catalogDue(state: CatalogDueState, nowMs: number): boolean {
  if (state.nextAttemptAt !== null && nowMs < state.nextAttemptAt) return false;
  if (state.neverWritten) return true;
  if (state.refreshedAt !== null && nowMs - state.refreshedAt < PROJECT_CATALOG_MIN_INTERVAL_MS) return false;
  return state.forced || state.score >= PROJECT_CATALOG_REFRESH_DELTA;
}

/**
 * 从写档模型的整段回复里取出档案：取回复里最后一个 JSON 对象（允许包在 ```json 代码块里），按 projectCatalogSchema 校验。
 * 后置：取不到或结构不对返回 null，不抛错。结构对的，每个字符串截到对应的 PROJECT_CATALOG_*_CHARS（超了末尾换成“…”），
 * 每个数组只留前 PROJECT_CATALOG_*_MAX 条，去掉空白和重复的别名。
 */
export function parseCatalogReply(text: string): ProjectCatalog | null {
  const last = jsonObjectsOf(text).at(-1);
  if (last === undefined) return null;
  const parsed = projectCatalogSchema.safeParse(withoutBlankAliases(last));
  return parsed.success ? clampCatalog(parsed.data) : null;
}

/** 第一层名片：只取一句话、别名、主线。 */
export function catalogCardOf(catalog: ProjectCatalog, refreshedAt: number): ProjectCatalogCard {
  return { oneLiner: catalog.oneLiner, aliases: [...catalog.aliases], focus: catalog.focus, refreshedAt };
}

/**
 * 第二层全文，给总助看的 Markdown：项目名、用户写的说明、做什么、别名、主线、核心模块、已定的事、悬着的事、写于何时。
 * 后置：不超过 PROJECT_CATALOG_DETAIL_MAX_CHARS 个字；控制字符换成空格，不会打乱总助看到的结构。
 */
export function renderCatalogDetail(detail: ProjectCatalogDetail, nowMs: number): string {
  const { catalog } = detail;
  const list = (items: readonly string[]) => (items.length === 0 ? ["无"] : items.map((item) => `- ${inline(item)}`));
  const description = detail.description === null ? "" : inline(detail.description);
  const lines = [
    `# 项目 #${detail.projectId} ${inline(detail.projectName)}`,
    "",
    ...(description === "" ? [] : [`- 说明（用户写的）：${description}`]),
    `- 做什么：${inline(catalog.oneLiner)}`,
    `- 别名：${catalog.aliases.length === 0 ? "无" : catalog.aliases.map(inline).join("、")}`,
    `- 主线：${inline(catalog.focus)}`,
    "",
    "## 核心模块",
    ...list(catalog.modules.map((m) => `${m.name}：${m.summary}`)),
    "",
    "## 已定的事",
    ...list(catalog.decisions),
    "",
    "## 悬着的事",
    ...list(catalog.openItems),
    "",
    `（档案写于 ${clockText(detail.refreshedAt)}，${catalogAgeText(detail.refreshedAt, nowMs)}）`,
  ];
  return truncateChars(lines.join("\n"), PROJECT_CATALOG_DETAIL_MAX_CHARS);
}

/** 档案多久前写的，给名片和第二层用：“刚刚更新”“3 小时前更新”“2 天前更新”。 */
export function catalogAgeText(refreshedAt: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - refreshedAt) / 60_000));
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return `${minutes} 分钟前更新`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前更新`;
  return `${Math.floor(hours / 24)} 天前更新`;
}

/** 控制字符、换行换成空格，不让材料里的字打乱总助看到的结构。 */
const inline = (raw: string): string => raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 本地时间的“2026-11-17 11:30”。 */
function clockText(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 从 start 的“{”往后找配对的“}”（跳过字符串里的括号），找不到返回 -1。 */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/** 回复里从前往后所有能解析的顶层 JSON 对象（代码块围栏、前后的说明文字都跳过）。 */
function jsonObjectsOf(text: string): unknown[] {
  const found: unknown[] = [];
  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    const end = matchingBrace(text, i);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(i, end + 1));
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        found.push(value);
        i = end;
      }
    } catch {
      // 不是 JSON，从下一个“{”接着找
    }
  }
  return found;
}

/** 模型常给出空字符串别名：校验前先去掉，不因此判整份档案不合格。 */
function withoutBlankAliases(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const aliases = (value as { aliases?: unknown }).aliases;
  if (!Array.isArray(aliases)) return value;
  return { ...value, aliases: aliases.filter((a) => typeof a !== "string" || a.trim() !== "") };
}

function clampCatalog(raw: ProjectCatalog): ProjectCatalog {
  const clip = (items: readonly string[], max: number) => items.slice(0, max).map((s) => truncateChars(s, PROJECT_CATALOG_ITEM_MAX_CHARS));
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const alias of raw.aliases) {
    const clean = truncateChars(alias.replace(/\s+/g, " "), PROJECT_CATALOG_ALIAS_MAX_CHARS);
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(clean);
    if (aliases.length >= PROJECT_CATALOG_ALIASES_MAX) break;
  }
  return {
    oneLiner: truncateChars(raw.oneLiner, PROJECT_CATALOG_ONE_LINER_MAX_CHARS),
    aliases,
    focus: truncateChars(raw.focus, PROJECT_CATALOG_FOCUS_MAX_CHARS),
    modules: raw.modules.slice(0, PROJECT_CATALOG_MODULES_MAX).map((m) => ({
      name: truncateChars(m.name, PROJECT_CATALOG_ALIAS_MAX_CHARS),
      summary: truncateChars(m.summary, PROJECT_CATALOG_ITEM_MAX_CHARS),
    })),
    decisions: clip(raw.decisions, PROJECT_CATALOG_DECISIONS_MAX),
    openItems: clip(raw.openItems, PROJECT_CATALOG_OPEN_ITEMS_MAX),
  };
}

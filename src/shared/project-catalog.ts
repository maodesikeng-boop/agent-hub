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

export type ProjectCatalog = z.infer<typeof projectCatalogSchema>;

export interface ProjectCatalogCard {
  oneLiner: string;
  aliases: string[];
  focus: string;
  refreshedAt: number;
}

export interface ProjectCatalogDetail {
  projectId: ProjectId;
  projectName: string;
  description: string | null;
  catalog: ProjectCatalog;
  refreshedAt: number;
}

export interface CatalogRefreshInput {
  project: {
    id: ProjectId;
    name: string;
    description: string | null;
    mainFolder: string;
    otherFolders: string[];
  };
  previous: ProjectCatalog | null;
  handover: string | null;
  dialog: string;
  dialogTruncated: boolean;
  graphs: Array<{ title: string; goal: string | null }>;
  workerReports: string[];
  files: Array<{ name: string; text: string }>;
}

export interface CatalogJob {
  projectId: ProjectId;
  cutMessageId: MessageId;
  input: CatalogRefreshInput;
}

type CatalogFailureReason = "timeout" | "error" | "invalid_reply" | "model_unavailable" | "shutdown";

export interface CatalogFailure {
  reason: CatalogFailureReason;
  detail?: string;
}

export interface LedgerProjectCatalogWork {
  claimCatalog(nowMs: number): CatalogJob | null;
  catalogWritten(job: CatalogJob, catalog: ProjectCatalog, usage: TokenUsage | null): void;
  catalogFailed(job: CatalogJob, failure: CatalogFailure): void;
}

export interface CatalogDueState {
  neverWritten: boolean;
  refreshedAt: number | null;
  forced: boolean;
  nextAttemptAt: number | null;
  score: number;
}

export function changeScore(counts: { userChars: number; agentChars: number }): number {
  return counts.userChars * PROJECT_CATALOG_USER_CHAR_WEIGHT + counts.agentChars;
}

export function catalogDue(state: CatalogDueState, nowMs: number): boolean {
  if (state.nextAttemptAt !== null && nowMs < state.nextAttemptAt) return false;
  if (state.neverWritten) return true;
  if (state.refreshedAt !== null && nowMs - state.refreshedAt < PROJECT_CATALOG_MIN_INTERVAL_MS) return false;
  return state.forced || state.score >= PROJECT_CATALOG_REFRESH_DELTA;
}

export function parseCatalogReply(text: string): ProjectCatalog | null {
  const last = jsonObjectsOf(text).at(-1);
  if (last === undefined) return null;
  const parsed = projectCatalogSchema.safeParse(withoutBlankAliases(last));
  return parsed.success ? clampCatalog(parsed.data) : null;
}

export function catalogCardOf(catalog: ProjectCatalog, refreshedAt: number): ProjectCatalogCard {
  return { oneLiner: catalog.oneLiner, aliases: [...catalog.aliases], focus: catalog.focus, refreshedAt };
}

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

export function catalogAgeText(refreshedAt: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - refreshedAt) / 60_000));
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return `${minutes} 分钟前更新`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前更新`;
  return `${Math.floor(hours / 24)} 天前更新`;
}

const inline = (raw: string): string => raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

const pad2 = (n: number) => String(n).padStart(2, "0");

function clockText(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

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
    }
  }
  return found;
}

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

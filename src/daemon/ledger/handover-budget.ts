// Invariant: assembled handover preambles never exceed the remaining single-message UTF-8 byte budget after reserving the latest turn payload, never emit lone UTF-16 surrogates, and trim history oldest-first.

import {
  HANDOVER_LIVE_STATE_MAX_BYTES,
  HANDOVER_MIN_PREAMBLE_BYTES,
  HANDOVER_RECENT_MAX_BYTES,
  HANDOVER_REPORTS_MAX_BYTES,
  HANDOVER_SUMMARY_MAX_BYTES,
  SKILL_CARRYOVER_DESCRIPTION_MAX_CHARS,
  SKILL_CARRYOVER_INDEX_MAX_BYTES,
  SKILL_CARRYOVER_LIST_MAX,
} from "../../shared/limits.ts";
import { handoverMaxSingleMessageBytesOf } from "../../shared/vendors.ts";
import { OMITTED_MARK } from "./handover-recent.ts";

export type LoadedSkillSource = "user" | "model";

export interface SkillIndexEntry {
  readonly name: string;
  readonly path: string;
  readonly source: LoadedSkillSource;
  readonly description: string | null;
}

export interface MissingSkillEntry {
  readonly name: string;
  readonly path: string;
}

export interface SkillIndexInput {
  readonly available: readonly SkillIndexEntry[];
  readonly missing: readonly MissingSkillEntry[];
}

export interface HandoverPreambleSections {
  readonly header: string;
  readonly skillsIndex: string | null;
  readonly summaryHeading: string;
  readonly summaryBody: string | null;
  readonly historyHeading: string;
  readonly historyEntriesNewestFirst: readonly string[];
  readonly historyEmptyText: string;
  readonly historyTruncatedHint: string;
  readonly reportsHeading?: string;
  readonly reports?: readonly string[];
  readonly pendingAsksSection: string | null;
  readonly agendaSection: string | null;
}

export interface PreambleBudgetOptions {
  readonly vendor: string;
  readonly reservedBytes?: number;
  readonly maxSingleMessageBytes?: number;
  readonly summaryMaxBytes?: number;
  readonly historyMaxBytes?: number;
  readonly liveStateMaxBytes?: number;
  readonly reportsMaxBytes?: number;
}

export interface BudgetedPreambleResult {
  readonly text: string | null;
  readonly totalBytes: number;
  readonly budgetBytes: number;
  readonly historyTruncated: boolean;
  readonly summaryTruncated: boolean;
  readonly liveStateTruncated: boolean;
  readonly skillsOmitted: boolean;
}

export interface TurnReservedParts {
  readonly text: string;
  readonly prefixes?: readonly string[];
  readonly systemPrompt?: string | null;
  readonly deliverySuffix?: string | null;
  readonly extraReserveBytes?: number;
}

const SKILLS_INDEX_HEADING = "## 上一个会话加载过的技能（索引，按需读取）";
const SKILLS_INDEX_INTRO = "以下是上一个会话用过的技能路径，不再整段贴正文；需要时直接读取对应文件或重新调用技能：";
const MISSING_SKILLS_PREFIX = "读不到了（文件没了或不在技能目录里）：";
const SUMMARY_CUT_NOTE = "\n\n（交接摘要已按预算截断）";
const LEGACY_CUT_NOTE = "\n\n（旧版开场说明超长，已按预算截断）";
const SPEAKER_PREFIX_RE = /^(?:用户：|你：)/u;
const SEP_BYTES = 2;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function stripLoneSurrogates(text: string): string {
  let out = "";
  let cleanStart = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      out += text.slice(cleanStart, i);
      cleanStart = i + 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += text.slice(cleanStart, i);
      cleanStart = i + 1;
    }
  }
  return cleanStart === 0 ? text : out + text.slice(cleanStart);
}

export function sliceUtf8HeadSafe(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || text.length === 0) return "";
  const limit = Math.floor(maxBytes);
  const clean = stripLoneSurrogates(text);
  if (utf8Bytes(clean) <= limit) return clean;
  let used = 0;
  let end = 0;
  while (end < clean.length) {
    const code = clean.charCodeAt(end);
    const isPair = code >= 0xd800 && code <= 0xdbff && end + 1 < clean.length;
    const step = isPair ? 2 : 1;
    const bytes = isPair ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    if (used + bytes > limit) break;
    used += bytes;
    end += step;
  }
  return clean.slice(0, end);
}

export function sliceUtf8TailSafe(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || text.length === 0) return "";
  const limit = Math.floor(maxBytes);
  const clean = stripLoneSurrogates(text);
  if (utf8Bytes(clean) <= limit) return clean;
  let used = 0;
  let start = clean.length;
  while (start > 0) {
    const code = clean.charCodeAt(start - 1);
    const isPair = code >= 0xdc00 && code <= 0xdfff && start >= 2;
    const step = isPair ? 2 : 1;
    const bytes = isPair ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    if (used + bytes > limit) break;
    used += bytes;
    start -= step;
  }
  return clean.slice(start);
}

function extractRawDescriptionValue(lines: readonly string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const match = /^description[ \t]*:[ \t]*(.*)$/u.exec(lines[i]!);
    if (match === null) continue;
    const value = match[1]!.trim();
    if (/^[|>][+-]?$/u.test(value)) {
      const blockLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.trim() === "") blockLines.push("");
        else if (/^[ \t]+/u.test(next)) blockLines.push(next.trim());
        else break;
      }
      return blockLines.join(" ");
    }
    if (value.startsWith('"')) {
      let combined = value;
      while (!/(?:^|[^\\])(?:\\\\)*"$/u.test(combined.slice(1)) && i + 1 < lines.length) {
        i += 1;
        combined += `\n${lines[i]!}`;
      }
      if (combined.length >= 2 && combined.endsWith('"')) {
        return combined
          .slice(1, -1)
          .replace(/\\([nrt"\\])/gu, (_m, ch: string) => (ch === "n" || ch === "r" || ch === "t" ? " " : ch));
      }
      return combined.slice(1);
    }
    if (value.startsWith("'")) {
      let combined = value;
      while (!(combined.length >= 2 && combined.endsWith("'")) && i + 1 < lines.length) {
        i += 1;
        combined += `\n${lines[i]!}`;
      }
      return combined.length >= 2 && combined.endsWith("'") ? combined.slice(1, -1).replaceAll("''", "'") : combined.slice(1);
    }
    const parts = value === "" ? [] : [value];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (/^[ \t]+/u.test(next) && next.trim() !== "") parts.push(next.trim());
      else break;
    }
    return parts.join(" ");
  }
  return null;
}

export function extractSkillDescription(markdown: string): string | null {
  const cleaned = markdown.replace(/^\uFEFF/u, "");
  const fmMatch = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(cleaned);
  if (fmMatch === null) return null;
  const raw = extractRawDescriptionValue(fmMatch[1]!.split(/\r?\n/u));
  if (raw === null) return null;
  const normalized = stripLoneSurrogates(raw)
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized === "") return null;
  const chars = [...normalized];
  if (chars.length <= SKILL_CARRYOVER_DESCRIPTION_MAX_CHARS) return normalized;
  return `${chars.slice(0, SKILL_CARRYOVER_DESCRIPTION_MAX_CHARS - 1).join("")}…`;
}

function buildMissingSkillsLine(missing: readonly MissingSkillEntry[], maxBytes: number): string | null {
  if (missing.length === 0 || maxBytes <= utf8Bytes(MISSING_SKILLS_PREFIX)) return null;
  const shown = missing.slice(0, SKILL_CARRYOVER_LIST_MAX).map((m) => `${m.name}（${m.path}）`);
  const tailMore = (extra: number) => (extra > 0 ? `，另有 ${extra} 个` : "");
  const full = `${MISSING_SKILLS_PREFIX}${shown.join("、")}${tailMore(missing.length - shown.length)}`;
  if (utf8Bytes(full) <= maxBytes) return full;

  const picked: string[] = [];
  for (let i = 0; i < shown.length; i++) {
    const candidate = `${MISSING_SKILLS_PREFIX}${[...picked, shown[i]!].join("、")}${tailMore(missing.length - (i + 1))}`;
    if (utf8Bytes(candidate) > maxBytes) break;
    picked.push(shown[i]!);
  }
  if (picked.length > 0) return `${MISSING_SKILLS_PREFIX}${picked.join("、")}${tailMore(missing.length - picked.length)}`;
  return sliceUtf8HeadSafe(full, maxBytes);
}

export function renderLoadedSkillsIndex(
  input: SkillIndexInput,
  maxBytes: number = SKILL_CARRYOVER_INDEX_MAX_BYTES,
): string | null {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return null;
  if (input.available.length === 0 && input.missing.length === 0) return null;
  const limit = Math.floor(maxBytes);
  const headingBytes = utf8Bytes(SKILLS_INDEX_HEADING);
  if (headingBytes > limit) return null;

  const missingBudget =
    input.missing.length === 0
      ? 0
      : input.available.length === 0
        ? limit - headingBytes - SEP_BYTES
        : Math.min(Math.floor(limit / 3), limit - headingBytes - SEP_BYTES);
  const missingLine = buildMissingSkillsLine(input.missing, missingBudget);
  const missingOverhead = missingLine === null ? 0 : SEP_BYTES + utf8Bytes(missingLine);

  let availableBlock: string | null = null;
  if (input.available.length > 0) {
    const availableBudget = limit - headingBytes - missingOverhead - SEP_BYTES;
    const listed = input.available.slice(0, SKILL_CARRYOVER_LIST_MAX);
    const introFits = utf8Bytes(SKILLS_INDEX_INTRO) + 1 < availableBudget;
    const lines: string[] = introFits ? [SKILLS_INDEX_INTRO] : [];
    let used = introFits ? utf8Bytes(SKILLS_INDEX_INTRO) : 0;
    let included = 0;

    for (const item of listed) {
      const sourceLabel = item.source === "user" ? "用户调用" : "模型加载";
      const baseLine = `- \`${item.name}\`（${sourceLabel}，路径：\`${item.path}\`）`;
      const fullLine = item.description ? `${baseLine}：${item.description}` : baseLine;
      const sep = lines.length > 0 ? 1 : 0;
      const lineBytes = utf8Bytes(fullLine);
      if (used + sep + lineBytes <= availableBudget) {
        lines.push(fullLine);
        used += sep + lineBytes;
        included += 1;
        continue;
      }
      if (included === 0 && item.description !== null && used + sep + utf8Bytes(baseLine) <= availableBudget) {
        lines.push(baseLine);
        used += sep + utf8Bytes(baseLine);
        included += 1;
      }
      break;
    }

    const omitted = input.available.length - included;
    if (included > 0 && omitted > 0) {
      const moreLine = `- （另有 ${omitted} 个较早加载的技能已省略）`;
      if (used + 1 + utf8Bytes(moreLine) <= availableBudget) lines.push(moreLine);
    }
    if (included > 0) availableBlock = lines.join("\n");
  }

  if (availableBlock === null && missingLine === null) return null;
  const parts = [SKILLS_INDEX_HEADING];
  if (availableBlock !== null) parts.push(availableBlock);
  if (missingLine !== null) parts.push(missingLine);
  return parts.join("\n\n");
}

export function computePreambleByteBudget(
  vendor: string,
  reservedBytes = 0,
  maxSingleMessageBytes?: number,
): number {
  const cap =
    maxSingleMessageBytes !== undefined && Number.isFinite(maxSingleMessageBytes) && maxSingleMessageBytes > 0
      ? Math.floor(maxSingleMessageBytes)
      : handoverMaxSingleMessageBytesOf(vendor);
  const reserved =
    typeof reservedBytes === "number" && Number.isFinite(reservedBytes) && reservedBytes > 0
      ? Math.ceil(reservedBytes)
      : 0;
  return Math.max(0, cap - reserved);
}

export function measureTurnReservedBytes(parts: TurnReservedParts): number {
  let total = utf8Bytes(parts.text) + SEP_BYTES;
  for (const prefix of parts.prefixes ?? []) {
    if (prefix !== "") total += utf8Bytes(prefix) + SEP_BYTES;
  }
  if (parts.systemPrompt != null && parts.systemPrompt !== "") {
    total += utf8Bytes(parts.systemPrompt) + SEP_BYTES;
  }
  if (parts.deliverySuffix != null && parts.deliverySuffix !== "") {
    total += utf8Bytes(parts.deliverySuffix) + SEP_BYTES;
  }
  if (parts.extraReserveBytes !== undefined && Number.isFinite(parts.extraReserveBytes) && parts.extraReserveBytes > 0) {
    total += Math.ceil(parts.extraReserveBytes);
  }
  return total;
}

function fitLiveSections(
  rawSections: readonly string[],
  maxBytes: number,
  preferLastIntact: boolean,
): { kept: string[]; truncated: boolean } {
  const items = rawSections.map((s) => stripLoneSurrogates(s.trim())).filter((s) => s !== "");
  if (items.length === 0 || maxBytes <= 0) return { kept: [], truncated: items.length > 0 };
  const full = items.join("\n\n");
  if (utf8Bytes(full) <= maxBytes) return { kept: items, truncated: false };

  // Keep the trailing agenda section intact when possible so pmAgendaFooterFor suppresses duplicate footers.
  if (preferLastIntact && items.length >= 2) {
    const last = items.at(-1)!;
    const lastBytes = utf8Bytes(last);
    if (lastBytes <= maxBytes) {
      const restBudget = maxBytes - lastBytes - SEP_BYTES;
      const head = restBudget > 0 ? sliceUtf8HeadSafe(items.slice(0, -1).join("\n\n"), restBudget).trimEnd() : "";
      return { kept: head === "" ? [last] : [head, last], truncated: true };
    }
  }
  const sliced = sliceUtf8HeadSafe(full, maxBytes).trimEnd();
  return { kept: sliced === "" ? [] : [sliced], truncated: true };
}

function fitSkillsIndexToBudget(skillsIndex: string, maxBytes: number): { text: string | null; omitted: boolean } {
  const clean = stripLoneSurrogates(skillsIndex.trim());
  if (clean === "" || maxBytes <= 0) return { text: null, omitted: clean !== "" };
  if (utf8Bytes(clean) <= maxBytes) return { text: clean, omitted: false };
  const lines = clean.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const sep = kept.length > 0 ? 1 : 0;
    const b = utf8Bytes(line);
    if (used + sep + b > maxBytes) break;
    kept.push(line);
    used += sep + b;
  }
  const joined = kept.join("\n").trimEnd();
  if (joined === "" || kept.length <= 1) return { text: null, omitted: true };
  return { text: joined, omitted: true };
}

function fitReportsToBudget(heading: string, reports: readonly string[], maxBytes: number): string | null {
  const headBytes = utf8Bytes(heading);
  if (reports.length === 0 || maxBytes <= headBytes + SEP_BYTES) return null;
  const bodyBudget = maxBytes - headBytes - SEP_BYTES;
  const pickedNewestFirst: string[] = [];
  let used = 0;
  for (let i = reports.length - 1; i >= 0; i--) {
    const line = stripLoneSurrogates(reports[i]!);
    const sep = pickedNewestFirst.length > 0 ? 1 : 0;
    const b = utf8Bytes(line);
    if (used + sep + b > bodyBudget) break;
    pickedNewestFirst.push(line);
    used += sep + b;
  }
  if (pickedNewestFirst.length === 0) return null;
  pickedNewestFirst.reverse();
  return `${heading}\n\n${pickedNewestFirst.join("\n")}`;
}

function sliceHistoryEntryTail(entry: string, maxBytes: number): string {
  const speakerMatch = SPEAKER_PREFIX_RE.exec(entry);
  const speakerPrefix = speakerMatch === null ? "" : speakerMatch[0]!;
  const body = speakerPrefix === "" ? entry : entry.slice(speakerPrefix.length);
  const omitBytes = utf8Bytes(OMITTED_MARK);
  const speakerBytes = utf8Bytes(speakerPrefix);

  if (maxBytes > speakerBytes + omitBytes) {
    const tail = sliceUtf8TailSafe(body, maxBytes - speakerBytes - omitBytes);
    if (tail !== "") return `${speakerPrefix}${OMITTED_MARK}${tail}`;
  }
  if (maxBytes > omitBytes) {
    const tail = sliceUtf8TailSafe(entry, maxBytes - omitBytes);
    if (tail !== "") return `${OMITTED_MARK}${tail}`;
  }
  return sliceUtf8TailSafe(entry, maxBytes);
}

function fitHistoryToBudget(
  sections: Pick<HandoverPreambleSections, "historyHeading" | "historyEntriesNewestFirst" | "historyEmptyText" | "historyTruncatedHint">,
  maxBytes: number,
): { text: string | null; truncated: boolean } {
  const headBytes = utf8Bytes(sections.historyHeading);
  if (maxBytes <= headBytes + SEP_BYTES) {
    return { text: null, truncated: sections.historyEntriesNewestFirst.length > 0 };
  }
  const bodyBudget = maxBytes - headBytes - SEP_BYTES;
  if (sections.historyEntriesNewestFirst.length === 0) {
    if (utf8Bytes(sections.historyEmptyText) > bodyBudget) return { text: null, truncated: false };
    return { text: `${sections.historyHeading}\n\n${sections.historyEmptyText}`, truncated: false };
  }

  let totalAll = 0;
  let allFit = true;
  for (let i = 0; i < sections.historyEntriesNewestFirst.length; i++) {
    totalAll += (i > 0 ? SEP_BYTES : 0) + utf8Bytes(sections.historyEntriesNewestFirst[i]!);
    if (totalAll > bodyBudget) {
      allFit = false;
      break;
    }
  }
  if (allFit) {
    const chronological = [...sections.historyEntriesNewestFirst].reverse().map(stripLoneSurrogates);
    return { text: `${sections.historyHeading}\n\n${chronological.join("\n\n")}`, truncated: false };
  }

  const hint = stripLoneSurrogates(sections.historyTruncatedHint);
  const hintOverhead = hint !== "" && utf8Bytes(hint) + SEP_BYTES < bodyBudget ? utf8Bytes(hint) + SEP_BYTES : 0;
  const entriesBudget = bodyBudget - hintOverhead;
  const picked: string[] = [];
  let used = 0;
  for (const rawEntry of sections.historyEntriesNewestFirst) {
    const entry = stripLoneSurrogates(rawEntry);
    const sep = picked.length > 0 ? SEP_BYTES : 0;
    const left = entriesBudget - used - sep;
    if (left <= 0) break;
    const entryBytes = utf8Bytes(entry);
    if (entryBytes <= left) {
      picked.push(entry);
      used += sep + entryBytes;
      continue;
    }
    const sliced = sliceHistoryEntryTail(entry, left);
    if (sliced !== "") picked.push(sliced);
    break;
  }

  if (picked.length === 0) {
    return hintOverhead > 0
      ? { text: `${sections.historyHeading}\n\n${hint}`, truncated: true }
      : { text: null, truncated: true };
  }
  picked.reverse();
  const joined = picked.join("\n\n");
  const body = hintOverhead > 0 ? `${hint}\n\n${joined}` : joined;
  return { text: `${sections.historyHeading}\n\n${body}`, truncated: true };
}

export function assembleBudgetedPreamble(
  sections: HandoverPreambleSections,
  options: PreambleBudgetOptions,
): BudgetedPreambleResult {
  const budgetBytes = computePreambleByteBudget(options.vendor, options.reservedBytes, options.maxSingleMessageBytes);
  if (budgetBytes < HANDOVER_MIN_PREAMBLE_BYTES) {
    return {
      text: null,
      totalBytes: 0,
      budgetBytes,
      historyTruncated: false,
      summaryTruncated: false,
      liveStateTruncated: false,
      skillsOmitted: false,
    };
  }

  const summaryMaxBytes = options.summaryMaxBytes ?? HANDOVER_SUMMARY_MAX_BYTES;
  const historyMaxBytes = options.historyMaxBytes ?? HANDOVER_RECENT_MAX_BYTES;
  const liveStateMaxBytes = options.liveStateMaxBytes ?? HANDOVER_LIVE_STATE_MAX_BYTES;
  const reportsMaxBytes = options.reportsMaxBytes ?? HANDOVER_REPORTS_MAX_BYTES;

  const headerPart = sliceUtf8HeadSafe(sections.header, budgetBytes);
  let remaining = budgetBytes - utf8Bytes(headerPart);

  const rawLive: string[] = [];
  if (sections.pendingAsksSection !== null && sections.pendingAsksSection.trim() !== "") {
    rawLive.push(sections.pendingAsksSection);
  }
  if (sections.agendaSection !== null && sections.agendaSection.trim() !== "") {
    rawLive.push(sections.agendaSection);
  }
  const liveBudget = rawLive.length === 0 ? 0 : Math.min(liveStateMaxBytes, Math.max(0, remaining - SEP_BYTES));
  const liveFitted = fitLiveSections(rawLive, liveBudget, sections.agendaSection !== null);
  for (const part of liveFitted.kept) {
    remaining -= SEP_BYTES + utf8Bytes(part);
  }

  let summaryPart: string | null = null;
  let summaryTruncated = false;
  if (sections.summaryBody !== null && sections.summaryBody.trim() !== "") {
    const summaryCap = Math.min(summaryMaxBytes, Math.max(0, remaining - SEP_BYTES));
    const fullSummary = `${sections.summaryHeading}\n\n${stripLoneSurrogates(sections.summaryBody)}`;
    if (utf8Bytes(fullSummary) <= summaryCap) {
      summaryPart = fullSummary;
      remaining -= SEP_BYTES + utf8Bytes(summaryPart);
    } else {
      summaryTruncated = true;
      const headOverhead = utf8Bytes(sections.summaryHeading) + SEP_BYTES;
      const bodyLimit = summaryCap - headOverhead;
      if (bodyLimit > 0) {
        const noteBytes = utf8Bytes(SUMMARY_CUT_NOTE);
        const body =
          bodyLimit > noteBytes + 32
            ? `${sliceUtf8HeadSafe(sections.summaryBody, bodyLimit - noteBytes)}${SUMMARY_CUT_NOTE}`
            : sliceUtf8HeadSafe(sections.summaryBody, bodyLimit);
        if (body !== "") {
          summaryPart = `${sections.summaryHeading}\n\n${body}`;
          remaining -= SEP_BYTES + utf8Bytes(summaryPart);
        }
      }
    }
  }

  let skillsPart: string | null = null;
  let skillsOmitted = false;
  if (sections.skillsIndex !== null && sections.skillsIndex.trim() !== "") {
    const skillsCap = Math.min(SKILL_CARRYOVER_INDEX_MAX_BYTES, Math.max(0, remaining - SEP_BYTES));
    const fitted = fitSkillsIndexToBudget(sections.skillsIndex, skillsCap);
    skillsPart = fitted.text;
    skillsOmitted = fitted.omitted;
    if (skillsPart !== null) remaining -= SEP_BYTES + utf8Bytes(skillsPart);
  }

  let reportsPart: string | null = null;
  if (sections.reportsHeading !== undefined && sections.reports !== undefined && sections.reports.length > 0) {
    const reportsCap = Math.min(reportsMaxBytes, Math.max(0, remaining - SEP_BYTES));
    reportsPart = fitReportsToBudget(sections.reportsHeading, sections.reports, reportsCap);
    if (reportsPart !== null) remaining -= SEP_BYTES + utf8Bytes(reportsPart);
  }

  const historyHeadingOverhead = utf8Bytes(sections.historyHeading) + SEP_BYTES;
  const historyCap = Math.min(historyMaxBytes + historyHeadingOverhead, Math.max(0, remaining - SEP_BYTES));
  const historyFitted = fitHistoryToBudget(sections, historyCap);

  const ordered = [
    headerPart,
    skillsPart,
    summaryPart,
    historyFitted.text,
    reportsPart,
    ...liveFitted.kept,
  ].filter((part): part is string => part !== null && part !== "");

  let text = ordered.join("\n\n");
  if (utf8Bytes(text) > budgetBytes) text = sliceUtf8HeadSafe(text, budgetBytes);
  return {
    text,
    totalBytes: utf8Bytes(text),
    budgetBytes,
    historyTruncated: historyFitted.truncated,
    summaryTruncated,
    liveStateTruncated: liveFitted.truncated,
    skillsOmitted,
  };
}

export function fitLegacyPreambleToBudget(
  legacyPreamble: string,
  liveSections: readonly string[],
  options: PreambleBudgetOptions,
): BudgetedPreambleResult {
  const budgetBytes = computePreambleByteBudget(options.vendor, options.reservedBytes, options.maxSingleMessageBytes);
  if (budgetBytes < HANDOVER_MIN_PREAMBLE_BYTES) {
    return {
      text: null,
      totalBytes: 0,
      budgetBytes,
      historyTruncated: false,
      summaryTruncated: false,
      liveStateTruncated: false,
      skillsOmitted: false,
    };
  }

  const liveStateMaxBytes = options.liveStateMaxBytes ?? HANDOVER_LIVE_STATE_MAX_BYTES;
  const liveFitted = fitLiveSections(liveSections, Math.min(liveStateMaxBytes, budgetBytes), true);
  const liveText = liveFitted.kept.join("\n\n");
  const liveBytes = liveText === "" ? 0 : utf8Bytes(liveText);
  const legacyCap = Math.max(0, budgetBytes - liveBytes - (liveBytes > 0 ? SEP_BYTES : 0));

  const cleanLegacy = stripLoneSurrogates(legacyPreamble);
  let fittedLegacy = "";
  let historyTruncated = false;
  if (legacyCap > 0 && cleanLegacy !== "") {
    if (utf8Bytes(cleanLegacy) <= legacyCap) {
      fittedLegacy = cleanLegacy;
    } else {
      historyTruncated = true;
      const cutNoteBytes = utf8Bytes(LEGACY_CUT_NOTE);
      fittedLegacy =
        legacyCap > cutNoteBytes + 64
          ? `${sliceUtf8HeadSafe(cleanLegacy, legacyCap - cutNoteBytes)}${LEGACY_CUT_NOTE}`
          : sliceUtf8HeadSafe(cleanLegacy, legacyCap);
    }
  }

  const combined = [fittedLegacy, liveText].filter((part) => part !== "").join("\n\n");
  const text = utf8Bytes(combined) <= budgetBytes ? combined : sliceUtf8HeadSafe(combined, budgetBytes);
  return {
    text,
    totalBytes: utf8Bytes(text),
    budgetBytes,
    historyTruncated,
    summaryTruncated: false,
    liveStateTruncated: liveFitted.truncated,
    skillsOmitted: false,
  };
}

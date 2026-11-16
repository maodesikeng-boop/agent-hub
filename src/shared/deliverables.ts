// 交付物：交给用户看的文件（方案、验收结论、截图、录屏），挂在任务图步骤、拍板卡、总助简报上（docs/deliverables-design.md）。
// 不变量：
// - 每个交付物都是一份已存好的副本（sent-files/<id>/），网页按 id 取；原文件被改、被删、worktree 被清都不影响。
// - 同一份数据在对话卡片、右栏、总助三处显示，网页只用本模块的函数分组，不在各个组件里各写一套判断。
// - 老数据、老版本设备发来的条目没有交付物字段，一律当空列表。
import { truncateChars, type MessageId, type TaskNode } from "./domain.ts";
import { DELIVERABLE_LABEL_MAX_CHARS, DELIVERABLES_PER_REPORT_MAX } from "./limits.ts";
import { previewKindOf } from "./preview.ts";
import type { SentFile } from "./sent-files.ts";

/** hub ask / router report 的一个 --file：`标签=路径` 或只写路径（标签用文件名）。 */
export interface HubFileArg {
  label: string | null;
  path: string;
}

/** 副本是哪条消息的第几个文件：预览窗的“在 Finder 中显示”“用默认程序打开”按它找原文件。router report --file 没有消息，是 null。 */
export interface DeliverableOrigin {
  messageId: MessageId;
  index: number;
}

export interface Deliverable {
  /** 给人看的名字：链接文字或 --file 的标签，最多 DELIVERABLE_LABEL_MAX_CHARS 字。 */
  label: string;
  /** 副本编号（sent-files/<id>/ 的目录名）。 */
  id: string;
  /** 副本的文件名。 */
  name: string;
  mime: string;
  size: number;
  /** 写在正文里的原链接地址：卡片正文里同一个链接也换成能点开的文件。 */
  href: string;
  origin: DeliverableOrigin | null;
}

/** 卡片里分两行显示：文档类一行链接，图片和视频一行缩略图。 */
export interface DeliverableGroups {
  documents: Deliverable[];
  media: Deliverable[];
}

const NO_DELIVERABLES: Deliverable[] = [];
const groupsCache = new WeakMap<readonly Deliverable[], DeliverableGroups>();
const sentFilesCache = new WeakMap<readonly Deliverable[], SentFile[]>();

function isDeliverable(value: unknown): value is Deliverable {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  const origin = d.origin as Record<string, unknown> | null | undefined;
  return (
    typeof d.label === "string" &&
    typeof d.id === "string" &&
    d.id !== "" &&
    typeof d.name === "string" &&
    typeof d.mime === "string" &&
    typeof d.size === "number" &&
    typeof d.href === "string" &&
    (origin === null || (typeof origin === "object" && typeof origin.messageId === "number" && typeof origin.index === "number"))
  );
}

/**
 * 前置：raw 是从数据库、快照或别的设备读来的任意值。
 * 后置：返回其中形状对的交付物；不是数组、元素形状不对的丢掉，不抛错。全都对时返回 raw 本身。
 */
export function deliverablesOf(raw: unknown): Deliverable[] {
  if (!Array.isArray(raw)) return NO_DELIVERABLES;
  // 全都对的原样返回：同一份 meta 每次给同一个数组，网页的 memo 不白画
  return raw.every(isDeliverable) ? raw : raw.filter(isDeliverable);
}

/**
 * 存了副本的 SentFile 换成交付物。label 为空或全是空白时用文件名，超长按字截断。
 * 前置：file.status 是 "saved"，id 不是 null。
 */
export function deliverableOfSentFile(file: SentFile, label: string, origin: DeliverableOrigin | null): Deliverable {
  const trimmed = label.trim();
  return {
    label: truncateChars(trimmed === "" ? file.name : trimmed, DELIVERABLE_LABEL_MAX_CHARS),
    id: file.id!,
    name: file.name,
    mime: file.mime,
    size: file.size ?? 0,
    href: file.href,
    origin,
  };
}

/**
 * 几份列表按顺序合成一份：同一个副本（id 相同）只留第一次出现的，最多 max 个。
 * 后置：输入都是空列表时返回同一个空数组引用。
 */
export function mergeDeliverables(lists: readonly (readonly Deliverable[])[], max: number): Deliverable[] {
  const seen = new Set<string>();
  const out: Deliverable[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (out.length === max) break;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out.length === 0 ? NO_DELIVERABLES : out;
}

/**
 * graph finish 汇总整张图的交付物：按步骤顺序（sortOrder）取各步 artifact.deliverables，合并去重，最多 DELIVERABLES_PER_REPORT_MAX 个。
 * 跳过的步骤不算。
 */
export function graphDeliverables(nodes: readonly Pick<TaskNode, "artifact" | "sortOrder" | "skipped">[]): Deliverable[] {
  const lists = nodes
    .filter((n) => !n.skipped)
    .toSorted((a, b) => a.sortOrder - b.sortOrder)
    .map((n) => n.artifact?.deliverables ?? NO_DELIVERABLES);
  return mergeDeliverables(lists, DELIVERABLES_PER_REPORT_MAX);
}

/**
 * 按预览类型分组（shared/preview.ts 的 previewKindOf）：image、video 进 media，别的进 documents，组内保持原顺序。
 * 后置：同一个 list 引用重复调用返回同一个对象（memo 的子组件不重画）。
 */
export function groupDeliverables(list: readonly Deliverable[]): DeliverableGroups {
  const hit = groupsCache.get(list);
  if (hit !== undefined) return hit;
  const groups: DeliverableGroups = { documents: [], media: [] };
  for (const item of list) {
    const kind = previewKindOf(item.name, item.mime);
    (kind === "image" || kind === "video" ? groups.media : groups.documents).push(item);
  }
  groupsCache.set(list, groups);
  return groups;
}

const originOfFile = new WeakMap<SentFile, DeliverableOrigin | null>();

/**
 * 给 <Markdown files> 用：卡片正文里写了同一个链接（href 相同）的，渲染成能点开的文件。
 * 后置：同一个 list 引用重复调用返回同一个数组引用；每一项的副本原本存在哪条消息，用 deliverableOriginOfFile 取。
 */
export function sentFilesOfDeliverables(list: readonly Deliverable[]): SentFile[] {
  const hit = sentFilesCache.get(list);
  if (hit !== undefined) return hit;
  const files = list.map((d): SentFile => {
    const file: SentFile = { href: d.href, path: d.href, id: d.id, name: d.name, size: d.size, mime: d.mime, status: "saved", mtime: null };
    originOfFile.set(file, d.origin);
    return file;
  });
  sentFilesCache.set(list, files);
  return files;
}

/**
 * sentFilesOfDeliverables 换出来的文件存在哪条消息的第几个（预览窗“在 Finder 中显示”按它找，不按正文所在的消息算）。
 * 不是从交付物换来的返回 undefined。
 */
export function deliverableOriginOfFile(file: SentFile): DeliverableOrigin | null | undefined {
  return originOfFile.get(file);
}

/**
 * 解析一个 --file 参数：`标签=路径` 或只有路径。路径里本来就有 `=` 时，只有第一个 `=` 前面不像路径（不含 / 和 \）才当标签。
 * 空串、只有标签没有路径时抛 RangeError，消息能直接给 agent 看。
 */
export function parseHubFileArg(raw: string): HubFileArg {
  const text = raw.trim();
  if (text === "") throw new RangeError("--file 不能是空的");
  const eq = text.indexOf("=");
  const head = eq === -1 ? "" : text.slice(0, eq);
  if (eq === -1 || /[/\\]/.test(head)) return { label: null, path: text };
  const path = text.slice(eq + 1).trim();
  if (path === "") throw new RangeError(`--file ${text} 只写了标签，没写路径（要写成 标签=路径）`);
  const label = head.trim();
  return { label: label === "" ? null : label, path };
}

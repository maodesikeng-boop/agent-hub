import { sentFileUrl, type Deliverable } from "../shared/index.ts";

export interface DeliverableSegment {
  readonly markdown: string;
  readonly deliverables: readonly Deliverable[];
  readonly isListItem: boolean;
}

export interface CardDeliverablesLayout {
  readonly segments: readonly DeliverableSegment[];
  readonly trailing: readonly Deliverable[];
}

interface RawBlock {
  readonly markdown: string;
  readonly isListItem: boolean;
}

const LAYOUT_CACHE_PER_ARRAY_MAX = 64;
const layoutCache = new WeakMap<readonly Deliverable[], Map<string, CardDeliverablesLayout>>();

const EMPTY_DELIVERABLES: readonly Deliverable[] = [];
const INLINE_LINK_RE = /!?\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))[^)]*\)/g;
const LIST_ITEM_RE = /^(?:[-*+]|\d+[.)])\s+/;
const FENCE_RE = /^(`{3,}|~{3,})/;

function extractInlineHrefs(markdown: string): Set<string> {
  const hrefs = new Set<string>();
  if (markdown === "") return hrefs;
  for (const match of markdown.matchAll(INLINE_LINK_RE)) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (raw !== "") hrefs.add(raw);
  }
  return hrefs;
}

function splitMarkdownBlocks(markdown: string): RawBlock[] {
  const trimmed = markdown.trim();
  if (trimmed === "") return [];
  const lines = trimmed.split(/\r?\n/);
  const blocks: RawBlock[] = [];
  let current: string[] = [];
  let currentIsListItem = false;
  let fenceChar: string | null = null;
  let fenceLen = 0;

  const flush = () => {
    const joined = current.join("\n").trimEnd();
    if (joined.trim() !== "") {
      blocks.push({ markdown: joined, isListItem: currentIsListItem });
    }
    current = [];
    currentIsListItem = false;
  };

  for (const line of lines) {
    const trimmedStart = line.trimStart();
    if (fenceChar !== null) {
      current.push(line);
      if (trimmedStart.startsWith(fenceChar.repeat(fenceLen)) && trimmedStart.replaceAll(fenceChar, "").trim() === "") {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }

    const fenceMatch = FENCE_RE.exec(trimmedStart);
    if (fenceMatch !== null) {
      if (current.length > 0 && currentIsListItem && !/^\s/.test(line)) flush();
      fenceChar = fenceMatch[1]![0]!;
      fenceLen = fenceMatch[1]!.length;
      current.push(line);
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    const startsTopLevelListItem = !/^\s/.test(line) && LIST_ITEM_RE.test(line);
    if (startsTopLevelListItem) {
      flush();
      currentIsListItem = true;
      current.push(line);
      continue;
    }

    if (currentIsListItem && !/^\s/.test(line)) {
      flush();
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function basenameOf(href: string): string {
  const clean = href.split(/[?#]/, 1)[0] ?? "";
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

function scoreMatch(blockLower: string, item: Deliverable): number {
  const nameLower = item.name.trim().toLowerCase();
  if (nameLower.length >= 2 && blockLower.includes(nameLower)) return 100;

  const baseLower = basenameOf(item.href).trim().toLowerCase();
  if (baseLower.length >= 2 && baseLower !== nameLower && blockLower.includes(baseLower)) return 90;

  const stemLower = stemOf(nameLower);
  if (stemLower.length >= 4) {
    const boundary = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(stemLower)}(?:$|[^a-z0-9])`);
    if (boundary.test(blockLower)) return 60;
  }

  const labelLower = item.label.trim().toLowerCase();
  if (labelLower.length >= 2 && blockLower.includes(labelLower)) return 50;

  return 0;
}

function computeLayout(
  text: string,
  deliverables: readonly Deliverable[],
  titleText: string,
): CardDeliverablesLayout {
  const blocks = splitMarkdownBlocks(text);
  if (deliverables.length === 0) {
    const trimmed = text.trim();
    return {
      segments: trimmed === "" ? [] : [{ markdown: trimmed, deliverables: EMPTY_DELIVERABLES, isListItem: false }],
      trailing: EMPTY_DELIVERABLES,
    };
  }

  const inlineHrefs = extractInlineHrefs(`${titleText}\n${text}`);
  const unlinked = deliverables.filter((d) => {
    if (inlineHrefs.has(d.href)) return false;
    const url = sentFileUrl({ id: d.id, name: d.name });
    return !inlineHrefs.has(url);
  });

  if (blocks.length === 0) {
    return { segments: [], trailing: unlinked };
  }

  const blockLowers = blocks.map((b) => b.markdown.toLowerCase());
  const perBlock: Deliverable[][] = blocks.map(() => []);
  const trailing: Deliverable[] = [];

  for (const item of unlinked) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < blockLowers.length; i++) {
      const score = scoreMatch(blockLowers[i]!, item);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      perBlock[bestIndex]!.push(item);
    } else {
      trailing.push(item);
    }
  }

  const segments: DeliverableSegment[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const attached = perBlock[i]!;
    const prev = segments.at(-1);
    if (prev !== undefined && prev.deliverables.length === 0 && attached.length === 0) {
      const sep = prev.isListItem && block.isListItem ? "\n" : "\n\n";
      segments[segments.length - 1] = {
        markdown: `${prev.markdown}${sep}${block.markdown}`,
        deliverables: EMPTY_DELIVERABLES,
        isListItem: block.isListItem,
      };
    } else {
      segments.push({
        markdown: block.markdown,
        deliverables: attached.length === 0 ? EMPTY_DELIVERABLES : attached,
        isListItem: block.isListItem,
      });
    }
  }

  return {
    segments,
    trailing: trailing.length === 0 ? EMPTY_DELIVERABLES : trailing,
  };
}

export function layoutCardDeliverables(
  text: string,
  deliverables: readonly Deliverable[],
  titleText = "",
): CardDeliverablesLayout {
  let byKey = layoutCache.get(deliverables);
  if (byKey === undefined) {
    byKey = new Map();
    layoutCache.set(deliverables, byKey);
  }
  const key = `${titleText}\u0000${text}`;
  const cached = byKey.get(key);
  if (cached !== undefined) return cached;
  if (byKey.size >= LAYOUT_CACHE_PER_ARRAY_MAX) byKey.clear();
  const computed = computeLayout(text, deliverables, titleText);
  byKey.set(key, computed);
  return computed;
}

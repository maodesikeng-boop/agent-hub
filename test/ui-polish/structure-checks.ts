// Structure checks over boxes the page reports (in-page.ts collectStructureInPage): line weight, framed boxes inside
// framed boxes, near-miss left edges in a column, and composers side by side that leave their shared row. Pure functions,
// so they are tested without a browser.
import type { RawHit } from "./checks.ts";
import { COMPOSER_ROW_TOLERANCE_PX, EDGE_NEAR_MISS_PX, LINE_MAX_PX } from "./limits.ts";

type Rect = RawHit["rect"];

/** An element that draws a border or a crisp inset ring. sides are visible widths in px: top, right, bottom, left. */
export interface FrameBox {
  label: string;
  rect: Rect;
  sides: readonly [number, number, number, number];
  dashed: boolean;
  /** Widest crisp inset ring (box-shadow inset 0 0 0 Npx), 0 when none. */
  ring: number;
  /** Its radius makes it a circle, such as a status dot with a halo. */
  dot: boolean;
  /** The element is a control or sits inside one: options and fields inside cards are controls, not boxes. */
  control: boolean;
  media: boolean;
  /** A Markdown blockquote, whose 3px bar is the one wide stroke the standard allows. */
  quote: boolean;
  /** Index of the nearest framed ancestor below any overlay root, or -1. */
  frameParent: number;
}

/** The start of something drawn in a navigation column: a text run, an icon, or an avatar. */
export interface EdgeItem {
  column: string;
  label: string;
  left: number;
  top: number;
  bottom: number;
}

/** A composer frame. resting is false while it grows for wrapped text, a newline, or attachments. */
export interface ComposerBox {
  label: string;
  rect: Rect;
  resting: boolean;
}

const framed = (box: FrameBox) => box.sides.every((w) => w > 0);

/** Postcondition: one hit per box drawing a solid border side or an inset ring wider than LINE_MAX_PX. */
export function thickLineHits(frames: readonly FrameBox[]): RawHit[] {
  const hits: RawHit[] = [];
  for (const box of frames) {
    const sides = box.quote ? box.sides.slice(0, 3) : box.sides;
    const widest = box.dashed ? 0 : Math.max(...sides);
    const ring = box.dot ? 0 : box.ring;
    if (Math.max(widest, ring) <= LINE_MAX_PX) continue;
    const what = widest >= ring ? `边框 ${widest}px` : `内描边 ${ring}px`;
    hits.push({ check: "thick-line", rect: box.rect, evidence: `${box.label} ${what}` });
  }
  return hits;
}

/** Postcondition: one hit per framed, non-control, non-media box whose nearest framed ancestor is not an overlay. */
export function nestedFrameHits(frames: readonly FrameBox[]): RawHit[] {
  const hits: RawHit[] = [];
  for (const box of frames) {
    if (!framed(box) || box.control || box.media || box.frameParent < 0) continue;
    const parent = frames[box.frameParent];
    if (parent === undefined) continue;
    hits.push({ check: "box-in-box", rect: box.rect, evidence: `${box.label} 套在 ${parent.label.split(" “")[0]} 里` });
  }
  return hits;
}

/**
 * Postcondition: groups each column's items into rows by vertical overlap, takes each row's leftmost start, and reports
 * every pair of distinct starts whose gap falls inside EDGE_NEAR_MISS_PX, once per pair per column.
 */
export function raggedEdgeHits(items: readonly EdgeItem[]): RawHit[] {
  const hits: RawHit[] = [];
  const columns = new Map<string, EdgeItem[]>();
  for (const item of items) columns.set(item.column, [...(columns.get(item.column) ?? []), item]);
  for (const [column, columnItems] of columns) {
    const starts = new Map<number, EdgeItem>();
    for (const row of rowsOf(columnItems)) {
      const first = row.reduce((a, b) => (b.left < a.left ? b : a));
      const key = Math.round(first.left * 2) / 2;
      if (!starts.has(key)) starts.set(key, first);
    }
    const edges = [...starts.keys()].toSorted((a, b) => a - b);
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const gap = edges[j]! - edges[i]!;
        if (gap > EDGE_NEAR_MISS_PX.max) break;
        if (gap < EDGE_NEAR_MISS_PX.min) continue;
        const a = starts.get(edges[i]!)!;
        const b = starts.get(edges[j]!)!;
        const rect = { x: a.left, y: Math.min(a.top, b.top), w: gap, h: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top) };
        hits.push({ check: "ragged-edge", rect, evidence: `${column}：${a.label} 从 ${edges[i]}px 起，${b.label} 从 ${edges[j]}px 起，只差 ${gap}px` });
      }
    }
  }
  return hits;
}

/**
 * Postcondition: one hit per pair of resting composers laid out side by side (no horizontal overlap), such as a
 * conversation and the Worker thread beside it, whose top or bottom edges differ by more than COMPOSER_ROW_TOLERANCE_PX.
 */
export function composerRowHits(composers: readonly ComposerBox[]): RawHit[] {
  const hits: RawHit[] = [];
  const resting = composers.filter((c) => c.resting).toSorted((a, b) => a.rect.x - b.rect.x);
  for (let i = 0; i < resting.length; i++) {
    for (let j = i + 1; j < resting.length; j++) {
      const left = resting[i]!.rect;
      const right = resting[j]!.rect;
      if (left.x + left.w > right.x) continue;
      const top = Math.abs(left.y - right.y);
      const bottom = Math.abs(left.y + left.h - (right.y + right.h));
      if (Math.max(top, bottom) <= COMPOSER_ROW_TOLERANCE_PX) continue;
      const y = Math.min(left.y, right.y);
      const rect = { x: left.x, y, w: right.x + right.w - left.x, h: Math.max(left.y + left.h, right.y + right.h) - y };
      const span = (r: Rect) => `${+r.y.toFixed(2)}–${+(r.y + r.h).toFixed(2)}px`;
      hits.push({
        check: "composer-row",
        rect,
        evidence: `${resting[i]!.label} 在 ${span(left)}，${resting[j]!.label} 在 ${span(right)}，顶边差 ${+top.toFixed(2)}px、底边差 ${+bottom.toFixed(2)}px`,
      });
    }
  }
  return hits;
}

function rowsOf(items: readonly EdgeItem[]): EdgeItem[][] {
  const rows: { top: number; bottom: number; items: EdgeItem[] }[] = [];
  for (const item of items.toSorted((a, b) => a.top - b.top)) {
    const middle = (item.top + item.bottom) / 2;
    const row = rows.find((r) => middle >= r.top && middle <= r.bottom);
    if (row === undefined) rows.push({ top: item.top, bottom: item.bottom, items: [item] });
    else row.items.push(item);
  }
  return rows.map((r) => r.items);
}

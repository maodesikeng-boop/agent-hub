// Invariant: inspects computed corner radii and clipping bounds for edge controls inside overflow-hidden rounded containers without mutating page state or spawning child processes.
import type { Page } from "playwright";

export type CornerName = "topLeft" | "topRight" | "bottomRight" | "bottomLeft";

export interface CornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

export interface EdgeFlags {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

export interface BorderWidths {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ClippedCornerCheckInput {
  label: string;
  containerRadius: CornerRadii;
  containerBorder: BorderWidths;
  childRadius: CornerRadii;
  touchesEdges: EdgeFlags;
  hasInsetStroke: boolean;
}

export interface CornerClippingIssue {
  label: string;
  corner: CornerName;
  expectedMinRadiusPx: number;
  actualRadiusPx: number;
}

const CORNERS: ReadonlyArray<{ corner: CornerName; edges: readonly [keyof EdgeFlags, keyof EdgeFlags] }> = [
  { corner: "topLeft", edges: ["top", "left"] },
  { corner: "topRight", edges: ["top", "right"] },
  { corner: "bottomRight", edges: ["bottom", "right"] },
  { corner: "bottomLeft", edges: ["bottom", "left"] },
];

const RADIUS_TOLERANCE_PX = 0.5;

/**
 * Precondition: all radii and border widths in `input` are finite non-negative pixel values.
 * Postcondition: returns an empty array when `hasInsetStroke` is false or when every corner where both adjacent edges touch the clipping container satisfies `childRadius[corner] >= max(0, containerRadius[corner] - max(adjacentBorderA, adjacentBorderB)) - 0.5`; otherwise returns one `CornerClippingIssue` per clipped corner in clockwise order (`topLeft`, `topRight`, `bottomRight`, `bottomLeft`).
 */
export function checkConcentricCornerGeometry(input: ClippedCornerCheckInput): CornerClippingIssue[] {
  if (!input.hasInsetStroke) return [];
  const issues: CornerClippingIssue[] = [];
  for (const { corner, edges } of CORNERS) {
    const [edgeA, edgeB] = edges;
    if (!input.touchesEdges[edgeA] || !input.touchesEdges[edgeB]) continue;
    const expectedMinRadiusPx = Math.max(
      0,
      input.containerRadius[corner] - Math.max(input.containerBorder[edgeA], input.containerBorder[edgeB]),
    );
    const actualRadiusPx = input.childRadius[corner];
    if (actualRadiusPx < expectedMinRadiusPx - RADIUS_TOLERANCE_PX) {
      issues.push({ label: input.label, corner, expectedMinRadiusPx, actualRadiusPx });
    }
  }
  return issues;
}

interface DomRectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface StyleLike {
  display: string;
  visibility: string;
  overflowX: string;
  overflowY: string;
  boxShadow: string;
  outlineOffset: string;
  borderTopLeftRadius: string;
  borderTopRightRadius: string;
  borderBottomRightRadius: string;
  borderBottomLeftRadius: string;
  borderTopWidth: string;
  borderRightWidth: string;
  borderBottomWidth: string;
  borderLeftWidth: string;
}

interface ElementLike {
  parentElement: ElementLike | null;
  className: string;
  disabled?: boolean;
  getBoundingClientRect(): DomRectLike;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
}

interface BrowserGlobal {
  document: { querySelectorAll(selector: string): Iterable<ElementLike> };
  getComputedStyle(el: ElementLike): StyleLike;
}

interface PageCornerAudit {
  checks: ClippedCornerCheckInput[];
  extraViolations: string[];
}

/**
 * Precondition: `page` is loaded on the Bellwood workbench with rendered card reply rows, event strips, or code blocks.
 * Postcondition: validates computed concentric inner-corner geometry on visible `.card-reply-row` elements (focus and invalid states), `.event-strip-trigger` elements (collapsed, expanded, first, and last positions), and `.md-code` toolbar buttons (negative inset outline-offset); throws an Error listing any geometry violations found.
 */
export async function verifyCardCorners(page: Page): Promise<void> {
  const audit = await page.evaluate((): PageCornerAudit => {
    const g = globalThis as unknown as BrowserGlobal;
    const checks: ClippedCornerCheckInput[] = [];
    const extraViolations: string[] = [];
    const edgeTol = 2;

    const isVisible = (el: ElementLike): boolean => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const st = g.getComputedStyle(el);
      return st.display !== "none" && st.visibility !== "hidden";
    };

    const parsePx = (raw: string): number => Number.parseFloat(raw) || 0;

    const readRadii = (st: StyleLike): CornerRadii => ({
      topLeft: parsePx(st.borderTopLeftRadius),
      topRight: parsePx(st.borderTopRightRadius),
      bottomRight: parsePx(st.borderBottomRightRadius),
      bottomLeft: parsePx(st.borderBottomLeftRadius),
    });

    const readBorders = (st: StyleLike): BorderWidths => ({
      top: parsePx(st.borderTopWidth),
      right: parsePx(st.borderRightWidth),
      bottom: parsePx(st.borderBottomWidth),
      left: parsePx(st.borderLeftWidth),
    });

    const findClipContainer = (el: ElementLike): ElementLike | null => {
      let cur = el.parentElement;
      while (cur !== null) {
        const st = g.getComputedStyle(cur);
        if (st.overflowX === "hidden" || st.overflowY === "hidden" || st.overflowX === "clip" || st.overflowY === "clip") {
          return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    };

    const inspectRow = (el: ElementLike, label: string, hasInsetStroke: boolean): void => {
      const container = findClipContainer(el);
      if (container === null) return;
      const cStyle = g.getComputedStyle(container);
      const rStyle = g.getComputedStyle(el);
      const cRect = container.getBoundingClientRect();
      const rRect = el.getBoundingClientRect();
      const containerBorder = readBorders(cStyle);
      checks.push({
        label,
        containerRadius: readRadii(cStyle),
        containerBorder,
        childRadius: readRadii(rStyle),
        touchesEdges: {
          top: Math.abs(rRect.top - (cRect.top + containerBorder.top)) <= edgeTol,
          right: Math.abs(rRect.right - (cRect.right - containerBorder.right)) <= edgeTol,
          bottom: Math.abs(rRect.bottom - (cRect.bottom - containerBorder.bottom)) <= edgeTol,
          left: Math.abs(rRect.left - (cRect.left + containerBorder.left)) <= edgeTol,
        },
        hasInsetStroke,
      });
    };

    for (const [idx, row] of [...g.document.querySelectorAll(".card-reply-row")].entries()) {
      if (!isVisible(row)) continue;
      const label = `card-reply-row#${idx}`;
      inspectRow(row, label, true);
      if (row.matches(":focus-within") || row.getAttribute("data-invalid") === "true") {
        const shadow = g.getComputedStyle(row).boxShadow;
        if (!shadow.includes("inset")) {
          extraViolations.push(`${label}: active focus/invalid state missing inset box-shadow (got "${shadow}")`);
        }
      }
    }

    for (const [idx, trigger] of [...g.document.querySelectorAll(".event-strip-trigger")].entries()) {
      if (!isVisible(trigger) || trigger.disabled === true) continue;
      const state = trigger.getAttribute("data-state") ?? "row";
      inspectRow(trigger, `event-strip-trigger#${idx}(${state})`, true);
    }

    for (const [idx, btn] of [...g.document.querySelectorAll(".md-code .md-code-bar button")].entries()) {
      if (!isVisible(btn)) continue;
      const st = g.getComputedStyle(btn);
      const label = `md-code-bar-button#${idx}`;
      if (btn.matches(":focus-visible")) {
        const offset = parsePx(st.outlineOffset);
        if (offset >= 0) {
          extraViolations.push(`${label}: focus-visible outline-offset must be negative inside .md-code (got ${offset}px)`);
        }
      } else if (!btn.className.includes("focus-visible:outline-offset-[-")) {
        extraViolations.push(`${label}: missing negative focus-visible:outline-offset utility inside .md-code`);
      }
    }

    return { checks, extraViolations };
  });

  const violations = [
    ...audit.checks.flatMap((input) =>
      checkConcentricCornerGeometry(input).map(
        (issue) =>
          `${issue.label} (${issue.corner}): radius ${issue.actualRadiusPx}px < expected concentric ${issue.expectedMinRadiusPx}px`,
      ),
    ),
    ...audit.extraViolations,
  ];
  if (violations.length > 0) {
    throw new Error(`Concentric corner geometry violations:\n${violations.join("\n")}`);
  }
}

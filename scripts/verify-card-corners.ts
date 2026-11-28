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

/**
 * Precondition: all radii and border widths in `input` are finite non-negative pixel values.
 * Postcondition: returns an empty array when `hasInsetStroke` is false or when every corner where both adjacent edges touch the clipping container satisfies `childRadius[corner] >= max(0, containerRadius[corner] - max(adjacentBorderA, adjacentBorderB)) - 0.5`; otherwise returns one `CornerClippingIssue` per clipped corner in clockwise order (`topLeft`, `topRight`, `bottomRight`, `bottomLeft`).
 */
export function checkConcentricCornerGeometry(_input: ClippedCornerCheckInput): CornerClippingIssue[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: `page` is loaded on the Bellwood workbench with rendered card reply rows, event strips, or code blocks.
 * Postcondition: validates computed concentric inner-corner geometry on visible `.card-reply-row` elements (focus and invalid states), `.event-strip-trigger` elements (collapsed, expanded, first, and last positions), and `.md-code` toolbar buttons (negative inset outline-offset); throws an Error listing any geometry violations found.
 */
export async function verifyCardCorners(_page: Page): Promise<void> {
  throw new Error("Not implemented");
}

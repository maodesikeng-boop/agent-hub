import type { GraphOrientation, MeasureStepText } from "./graph-flow.ts";

/**
 * Precondition: called in a component; probe is any element styled with the step label font, or null before mount.
 * Postcondition: returns a measure function backed by one canvas and a GRAPH_TEXT_WIDTH_CACHE_MAX-entry LRU keyed by font
 * and text; the cache clears when web fonts finish loading or the interface scale changes, and the returned function
 * keeps its identity until then.
 */
export function useStepTextMeasure(_probe: HTMLElement | null): MeasureStepText {
  throw new Error("Not implemented");
}

/**
 * Precondition: called in a component; box is the element whose content width the graph may use, or null before mount.
 * Postcondition: returns orientationOf(requiredPx, box content width), read before the first paint so a narrow panel
 * never flashes the horizontal canvas, and updates when the box resizes.
 */
export function useGraphOrientation(_box: HTMLElement | null, _requiredPx: number): GraphOrientation {
  throw new Error("Not implemented");
}

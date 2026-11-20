import type { CSSProperties } from "react";
import { JELLY_COLOR_IDS, jellyColorOf, type JellyColorId } from "../../shared/slimes.ts";

export { contrastRatio } from "../../shared/slimes.ts";

function cachedBy<T>(build: (id: JellyColorId) => T): (id: JellyColorId) => T {
  const table = new Map<JellyColorId, T>(JELLY_COLOR_IDS.map((id) => [id, build(id)]));
  return (id) => table.get(id)!;
}

export const accentStyleOf = cachedBy((id): CSSProperties => {
  const { accent, accentForeground } = jellyColorOf(id);
  return { "--primary": accent, "--primary-foreground": accentForeground } as CSSProperties;
});

export const tintStyleOf = cachedBy((id): CSSProperties => ({ "--fruit": jellyColorOf(id).accent }) as CSSProperties);

export const jellyStyleOf = cachedBy((id): CSSProperties => ({ "--jelly": jellyColorOf(id).accent }) as CSSProperties);

type FruitTrackVars = CSSProperties & Record<"--tube-line" | "--tube-core" | "--tube-glint" | "--tube-shade" | "--peel" | "--step-done-bg", string>;

export const fruitTrackVars = cachedBy((id): FruitTrackVars => {
  const { roles, blob, backdrop } = jellyColorOf(id);
  return {
    "--tube-line": roles.outline,
    "--tube-core": roles.body,
    "--tube-glint": roles.light,
    "--tube-shade": roles.shade,
    "--peel": blob,
    "--step-done-bg": backdrop,
  };
});

const CHART_ORDER: readonly JellyColorId[] = ["grapefruit", "lime", "orange", "kiwi", "strawberry", "lemon"];
export const CHART_CATEGORY_COLORS: readonly string[] = CHART_ORDER.map((id) => jellyColorOf(id).accent);

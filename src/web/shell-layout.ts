import { useEffect, useLayoutEffect, useState } from "react";
import {
  SHELL_CHAT_MIN_REM,
  SHELL_FRAME_PX,
  SHELL_LIST_REM,
  SHELL_PANEL_REM,
  SHELL_RAIL_REM,
  SHELL_SEAM_PX,
  SHELL_STRIP_REM,
} from "../shared/limits.ts";
import { subscribeUiScale, type UiScale } from "./ui-scale.ts";

// Invariant: every returned width is CSS px at the given root font size; the SHELL_* constants stay the single source of limits.

/** How the desktop columns are arranged: all side by side, PM column collapsed to avatars, or the side panel covering the conversation. */
export type ShellTier = "wide" | "strip" | "stack";

export interface PaneLimitsPx {
  min: number;
  default: number;
  max: number;
}

export interface ShellLimitsPx {
  rail: number;
  strip: number;
  list: PaneLimitsPx;
  panel: PaneLimitsPx;
  chatMin: number;
  frame: number;
  seam: number;
}

export interface ShellFitInput {
  /** Measured width of the whole desktop shell, rail included. */
  shellWidthPx: number;
  /** Root font size: 16 at the Default interface scale, 17.5 at Large. */
  remPx: number;
  /** Whether the side panel currently has content. */
  panelOpen: boolean;
}

const SCALE_REM_PX: Readonly<Record<UiScale, number>> = {
  sm: 14.5,
  md: 16,
  lg: 17.5,
  xl: 19,
};

export function readRootRemPx(): number {
  if (typeof document === "undefined") return 16;
  const root = document.documentElement;
  const inline = Number.parseFloat(root.style.fontSize);
  if (Number.isFinite(inline) && inline > 0) return inline;
  const computed = Number.parseFloat(getComputedStyle(root).fontSize);
  const scale = root.dataset.uiScale as UiScale | undefined;
  // jsdom does not evaluate styles.css rules on data-ui-scale, so fall back to the mapped scale size when computed is default/empty.
  if (Number.isFinite(computed) && computed > 0 && (computed !== 16 || scale === undefined || scale === "md")) {
    return computed;
  }
  if (scale !== undefined && scale in SCALE_REM_PX) return SCALE_REM_PX[scale];
  return Number.isFinite(computed) && computed > 0 ? computed : 16;
}

function measureShellWidth(el: HTMLElement | null): number | null {
  if (!el) return null;
  const width = el.getBoundingClientRect().width || el.clientWidth;
  return width > 0 ? width : null;
}

/**
 * Precondition: remPx > 0.
 * Postcondition: returns the SHELL_* rem limits multiplied by remPx; frame and seam stay in px.
 */
export function shellLimitsPx(remPx: number): ShellLimitsPx {
  const safeRem = remPx > 0 ? remPx : 16;
  return {
    rail: SHELL_RAIL_REM * safeRem,
    strip: SHELL_STRIP_REM * safeRem,
    list: {
      min: SHELL_LIST_REM.min * safeRem,
      default: SHELL_LIST_REM.default * safeRem,
      max: SHELL_LIST_REM.max * safeRem,
    },
    panel: {
      min: SHELL_PANEL_REM.min * safeRem,
      default: SHELL_PANEL_REM.default * safeRem,
      max: SHELL_PANEL_REM.max * safeRem,
    },
    chatMin: SHELL_CHAT_MIN_REM * safeRem,
    frame: SHELL_FRAME_PX,
    seam: SHELL_SEAM_PX,
  };
}

/**
 * Precondition: shellWidthPx >= 0 and remPx > 0.
 * Postcondition: returns "wide" when the rail, the frame, the PM column at its minimum, the conversation at its minimum,
 * and, when panelOpen, the side panel at its minimum fit together with one seam per column boundary.
 * Otherwise returns "strip" when the same fits with the PM column collapsed to the strip.
 * Otherwise returns "stack" when panelOpen and "strip" when not; a closed panel never yields "stack".
 */
export function shellTierOf({ shellWidthPx, remPx, panelOpen }: ShellFitInput): ShellTier {
  const limits = shellLimitsPx(remPx);
  const panelNeed = panelOpen ? limits.seam + limits.panel.min : 0;
  const fixed = limits.rail + limits.frame + limits.seam + limits.chatMin + panelNeed;
  if (shellWidthPx >= fixed + limits.list.min) return "wide";
  if (!panelOpen || shellWidthPx >= fixed + limits.strip) return "strip";
  return "stack";
}

/**
 * Precondition: called in a component; shell is the element that spans the whole desktop shell, or null before mount.
 * Postcondition: returns shellTierOf for the element's current width and the root font size, and updates when the element
 * resizes or the interface scale changes; returns "wide" while shell is null.
 */
export function useShellTier(shell: HTMLElement | null, panelOpen: boolean): ShellTier {
  const [remPx, setRemPx] = useState<number>(() => readRootRemPx());
  const [widthPx, setWidthPx] = useState<number | null>(() => measureShellWidth(shell));

  useLayoutEffect(() => {
    setWidthPx(measureShellWidth(shell));
    if (!shell || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const w = entry.contentRect.width;
      setWidthPx(w > 0 ? w : measureShellWidth(shell));
    });
    ro.observe(shell);
    return () => ro.disconnect();
  }, [shell]);

  useEffect(() => {
    const syncScale = () => setRemPx(readRootRemPx());
    syncScale();
    const unsub = subscribeUiScale(syncScale);
    const mo = new MutationObserver(syncScale);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ui-scale", "style"] });
    return () => {
      unsub();
      mo.disconnect();
    };
  }, []);

  if (widthPx === null) return "wide";
  return shellTierOf({ shellWidthPx: widthPx, remPx, panelOpen });
}

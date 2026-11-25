import { useEffect, useLayoutEffect, useState } from "react";
import { SHELL_CHAT_MIN_REM, SHELL_FRAME_PX, SHELL_GAP_PX, SHELL_LIST_REM, SHELL_PANEL_REM, SHELL_RAIL_REM } from "./limits.ts";
import { DEFAULT_UI_SCALE, subscribeUiScale, UI_SCALE_ROOT_PX, type UiScale } from "./ui-scale.ts";

// Invariant: every returned width is CSS px at the given root font size; the SHELL_* constants stay the single source of limits.

/** How the desktop columns are arranged: all side by side, or the side panel covering the conversation. */
export type ShellTier = "wide" | "stack";

export interface PaneLimitsPx {
  min: number;
  default: number;
  max: number;
}

export interface ShellLimitsPx {
  rail: number;
  list: PaneLimitsPx;
  panel: PaneLimitsPx;
  chatMin: number;
  frame: number;
  gap: number;
}

export interface ShellFitInput {
  /** Measured width of the whole desktop shell, rail included. */
  shellWidthPx: number;
  /** Root font size: 17.5 at the Default interface scale, 19 at Large. */
  remPx: number;
  /** Whether the side panel currently has content. */
  panelOpen: boolean;
}

// jsdom does not apply styles.css, so its computed root size stays at the browser default whatever the scale.
const BROWSER_DEFAULT_PX = 16;

export function readRootRemPx(): number {
  const fallback = UI_SCALE_ROOT_PX[DEFAULT_UI_SCALE];
  if (typeof document === "undefined") return fallback;
  const root = document.documentElement;
  const inline = Number.parseFloat(root.style.fontSize);
  if (Number.isFinite(inline) && inline > 0) return inline;
  const scale = root.dataset.uiScale;
  const mapped = scale !== undefined && scale in UI_SCALE_ROOT_PX ? UI_SCALE_ROOT_PX[scale as UiScale] : fallback;
  const computed = Number.parseFloat(getComputedStyle(root).fontSize);
  if (Number.isFinite(computed) && computed > 0 && (computed !== BROWSER_DEFAULT_PX || mapped === BROWSER_DEFAULT_PX)) return computed;
  return mapped;
}

function measureShellWidth(el: HTMLElement | null): number | null {
  if (!el) return null;
  const width = el.getBoundingClientRect().width || el.clientWidth;
  return width > 0 ? width : null;
}

/**
 * Precondition: remPx > 0.
 * Postcondition: returns the SHELL_* rem limits multiplied by remPx; frame and gap stay in px.
 */
export function shellLimitsPx(remPx: number): ShellLimitsPx {
  const safeRem = remPx > 0 ? remPx : UI_SCALE_ROOT_PX[DEFAULT_UI_SCALE];
  return {
    rail: SHELL_RAIL_REM * safeRem,
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
    gap: SHELL_GAP_PX,
  };
}

/**
 * Precondition: shellWidthPx >= 0 and remPx > 0.
 * Postcondition: returns "stack" when panelOpen and the rail, the frame's right inset, the PM column at its minimum joined to
 * the conversation at its minimum, the gap, and the side panel at its minimum do not fit side by side; otherwise "wide".
 * The PM column never collapses; when even the closed-panel columns do not fit, the conversation narrows instead.
 */
export function shellTierOf({ shellWidthPx, remPx, panelOpen }: ShellFitInput): ShellTier {
  if (!panelOpen) return "wide";
  const limits = shellLimitsPx(remPx);
  const need = limits.rail + limits.frame + limits.list.min + limits.chatMin + limits.gap + limits.panel.min;
  return shellWidthPx >= need ? "wide" : "stack";
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

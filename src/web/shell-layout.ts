import {
  SHELL_CHAT_MIN_REM,
  SHELL_FRAME_PX,
  SHELL_LIST_REM,
  SHELL_PANEL_REM,
  SHELL_RAIL_REM,
  SHELL_SEAM_PX,
  SHELL_STRIP_REM,
} from "../shared/limits.ts";

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

/**
 * Precondition: remPx > 0.
 * Postcondition: returns the SHELL_* rem limits multiplied by remPx; frame and seam stay in px.
 */
export function shellLimitsPx(remPx: number): ShellLimitsPx {
  throw new Error("Not implemented");
}

/**
 * Precondition: shellWidthPx >= 0 and remPx > 0.
 * Postcondition: returns "wide" when the rail, the frame, the PM column at its minimum, the conversation at its minimum,
 * and, when panelOpen, the side panel at its minimum fit together with one seam per column boundary.
 * Otherwise returns "strip" when the same fits with the PM column collapsed to the strip.
 * Otherwise returns "stack" when panelOpen and "strip" when not; a closed panel never yields "stack".
 */
export function shellTierOf(input: ShellFitInput): ShellTier {
  throw new Error("Not implemented");
}

/**
 * Precondition: called in a component; shell is the element that spans the whole desktop shell, or null before mount.
 * Postcondition: returns shellTierOf for the element's current width and the root font size, and updates when the element
 * resizes or the interface scale changes; returns "wide" while shell is null.
 */
export function useShellTier(shell: HTMLElement | null, panelOpen: boolean): ShellTier {
  throw new Error("Not implemented");
}

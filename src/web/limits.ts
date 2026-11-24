export const SCROLLBAR_IDLE_HIDE_MS = 900;
export const LAYOUT_CACHE_PER_ARRAY_MAX = 64;
export const DECISION_DRAFTS_MAX = 200;
// Workbench column widths are rem so they follow the interface scale.
export const SHELL_RAIL_REM = 4.5;
export const SHELL_STRIP_REM = 4.5;
export const SHELL_LIST_REM = { min: 13.75, default: 16.5, max: 25 } as const;
export const SHELL_PANEL_REM = { min: 22.5, default: 27.5, max: 45 } as const;
export const SHELL_CHAT_MIN_REM = 30;
// The sheet's 6px right inset (its edge is a shadow, not an outline) and the 1px column seams, drawn in px like every line.
export const SHELL_FRAME_PX = 6;
export const SHELL_SEAM_PX = 1;

export const SCROLLBAR_IDLE_HIDE_MS = 900;
export const LAYOUT_CACHE_PER_ARRAY_MAX = 64;
export const DECISION_DRAFTS_MAX = 200;

export const COMPOSER_MAX_HEIGHT_PX = 180;
export const COMPOSER_SINGLE_ROW_SLACK_PX = 4;
export const COMPOSER_WRAP_PROBE_CHARS = 512;
// Workbench column widths are rem so they follow the interface scale.
export const SHELL_RAIL_REM = 4.5;
export const SHELL_STRIP_REM = 4.5;
export const SHELL_LIST_REM = { min: 13.75, default: 16.5, max: 25 } as const;
export const SHELL_PANEL_REM = { min: 22.5, default: 27.5, max: 45 } as const;
export const SHELL_CHAT_MIN_REM = 30;
// The cream frame's 6px right inset and the 6px gaps between the list and the white sheets, in px like every line.
export const SHELL_FRAME_PX = 6;
export const SHELL_SEAM_PX = 6;

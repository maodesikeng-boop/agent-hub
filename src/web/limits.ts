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
// The frame's 6px inset around the panels and the 4px gap before the side panel, in px like every line; the list and the
// conversation sheet join with no gap. styles.css keeps the same values in --frame-inset and --shell-gap.
export const SHELL_FRAME_PX = 6;
export const SHELL_GAP_PX = 4;

// One month is about 300 finished Workers plus their graphs; 8 pages of COMPLETED_WORK_PAGE_SIZE (50) cover it.
export const COMPLETED_WORK_MAX_PAGES = 8;
// Distinct step titles measured for the graph canvas; a month of graphs holds about 500.
export const GRAPH_TEXT_WIDTH_CACHE_MAX = 2_000;
// Work panel graph geometry in px, matching the decided prototype.
export const WORK_GRAPH_PX = {
  node: 26,
  nodePadStart: 7,
  nodePadEnd: 9,
  iconGap: 6,
  icon: 14,
  border: 1,
  parallelGap: 6,
  line: 24,
  fork: 28,
  paperPadX: 14,
  paperPadY: 12,
  stroke: 1.35,
} as const;

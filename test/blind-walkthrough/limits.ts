// Bounds, timeouts, and retention caps for blind new-user walkthrough runs.

export const BLIND_MAX_STEPS_PER_MISSION = 20;
export const BLIND_MAX_TOTAL_STEPS_PER_RUN = 60;
export const BLIND_STEP_TIMEOUT_MS = 60_000;
export const BLIND_RUN_BUDGET_MS = 25 * 60_000;
export const BLIND_DAEMON_START_TIMEOUT_MS = 45_000;
export const BLIND_DAEMON_STOP_TIMEOUT_MS = 20_000;
export const BLIND_ACTION_RETRY_MAX = 2;
export const BLIND_ACTION_RETRY_BACKOFF_MS = 1_500;
export const BLIND_A11Y_SNAPSHOT_MAX_CHARS = 16_000;
export const BLIND_A11Y_MAX_NODES = 400;
export const BLIND_VIDEO_MAX_BYTES = 45 * 1024 * 1024;
export const BLIND_REPORT_MAX_BYTES = 2 * 1024 * 1024;
export const BLIND_HISTORY_MAX_RUNS = 60;
export const BLIND_EVIDENCE_KEEP_RUNS = 10;
export const BLIND_STUCK_REPEAT_THRESHOLD = 3;
export const BLIND_TRACE_SCHEMA_VERSION = 1;

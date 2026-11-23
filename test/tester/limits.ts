// Tester caps and thresholds. Sized for a year of one run per night plus PR and RC runs.

/** Run records kept in history.jsonl: about two months of nightly runs plus PR and RC runs. */
export const TESTER_HISTORY_MAX_RUNS = 120;

/** Runs whose evidence directories stay on disk; older evidence is deleted, its record stays. */
export const TESTER_EVIDENCE_KEEP_RUNS = 20;

/** Evidence bytes one flow may write; a flow that would exceed it truncates and says so in the file. */
export const TESTER_EVIDENCE_MAX_BYTES_PER_FLOW = 2 * 1024 * 1024;

/** Default tolerance for flows without network variance: two product failures in a row alert. */
export const TESTER_DEFAULT_CONSECUTIVE_FAILURES = 2;

/** Default tolerance for flows over the real network: alert when fewer than 6 of the last 7 runs passed. */
export const TESTER_RATE_WINDOW = 7;
export const TESTER_RATE_MIN_PASSES = 6;

/** Consecutive env_unavailable runs of one flow before a bench alert. */
export const TESTER_BENCH_ALERT_RUNS = 3;

/** Feishu messages one flow reads per chat while waiting for a reply. */
export const TESTER_FEISHU_PAGE_SIZE = 50;

/** Refresh the Feishu driver's user token this long before it expires. */
export const TESTER_FEISHU_TOKEN_SKEW_MS = 5 * 60_000;

/** Whole-run budget for a nightly run, so a hung flow cannot hold the bench past morning. */
export const TESTER_NIGHTLY_BUDGET_MS = 30 * 60_000;

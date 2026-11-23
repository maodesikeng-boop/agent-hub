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

/** Poll interval while a flow waits on a daemon or on Feishu. */
export const TESTER_POLL_MS = 1_000;

/** How long the local test daemon may take to print its login link, and to exit after SIGTERM before it is killed. */
export const TESTER_DAEMON_START_MS = 60_000;
export const TESTER_DAEMON_STOP_MS = 35_000;

/** One remote command over ssh, including a deploy that installs dependencies. */
export const TESTER_REMOTE_COMMAND_TIMEOUT_MS = 10 * 60_000;

/** Largest `logs <n>` the remote forced command accepts. */
export const TESTER_REMOTE_LOG_MAX_LINES = 2_000;

/** One vendor install command, and the stderr lines kept when it fails. */
export const TESTER_INSTALL_TIMEOUT_MS = 10 * 60_000;
export const TESTER_STDERR_TAIL_LINES = 20;

/** Characters of any Feishu or chat message body a summary may show. */
export const TESTER_SUMMARY_TEXT_MAX_CHARS = 200;

/** A Feishu driver token refresh lock older than this is stale and taken over. */
export const TESTER_FEISHU_LOCK_STALE_MS = 60_000;

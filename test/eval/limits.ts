// Centralized trial limits, polling cadence, retention caps, and replay fixture bounds.
// These caps govern test/eval/ only; production daemon limits stay in src/shared/limits.ts.

export const EVAL_MAX_PM_TURNS = 12;
export const EVAL_TRIAL_TIMEOUT_MS = 20 * 60_000;
export const EVAL_SCRIPTED_TRIAL_TIMEOUT_MS = 60_000;

export const EVAL_POLL_MS = 1_000;
export const EVAL_SCRIPTED_POLL_MS = 100;
/** Wait window after the PM goes quiet so background command wakeups have room to arrive. */
export const EVAL_QUIET_MS = 30_000;
export const EVAL_SCRIPTED_QUIET_MS = 1_500;

/** Delay before fallback report when a replayed Worker receives extra turns past its script. */
export const EVAL_WORKER_OVERRUN_DELAY_MS = 1_500;

export const EVAL_DEFAULT_PARALLEL = 3;
export const EVAL_MAX_PARALLEL = 4;

export const EVAL_KEEP_RUNS = 20;
export const EVAL_KEEP_RUN_DAYS = 30;
export const EVAL_KEEP_FAILED_WORK = 10;
export const EVAL_KEEP_VERSIONS = 4;

export const EVAL_REPLAY_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const EVAL_REPLAY_MAX_FILE_BYTES = 500 * 1024;

/** 结果文件里每条证据、每条消息正文最多留多少字（完整过程另存，也按这个截）。 */
export const EVAL_EVIDENCE_MAX_CHARS = 300;
export const EVAL_TRANSCRIPT_MAX_CHARS = 4_000;
/** 一条检查最多附几条证据。 */
export const EVAL_EVIDENCE_MAX_ITEMS = 8;
/** gh 替身回放失败日志时一次最多输出多少字节（真日志约 136KB，原样给）。 */
export const EVAL_GH_LOG_MAX_BYTES = 512 * 1024;

/** 单次落盘文本的 UTF-8 字节上限。 */
export const EVAL_TEXT_MAX_BYTES = 2 * 1024 * 1024;

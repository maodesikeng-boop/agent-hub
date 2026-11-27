// Centralized numeric caps and statistical thresholds for product capability evaluation.
// Invariant: these limits govern test/eval/product/ only and never ship in the production daemon.

export const PRODUCT_EVAL_MIN_REGRESSION_TRIALS = 3;
export const PRODUCT_EVAL_DEFAULT_CAPABILITY_TRIALS = 3;
export const PRODUCT_EVAL_MAX_ENV_ERROR_RATE = 0.2;
export const PRODUCT_EVAL_MAX_OVERFIT_GAP = 0.15;
export const PRODUCT_EVAL_MAX_CACHE_READ_DROP = 0.05;
export const PRODUCT_EVAL_HISTORY_MAX_RUNS = 180;
export const PRODUCT_EVAL_MAX_RECORDED_REQUESTS = 200;
export const PRODUCT_EVAL_MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
export const PRODUCT_EVAL_MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
export const PRODUCT_EVAL_LEDGER_SCAN_MAX_ROWS = 50_000;

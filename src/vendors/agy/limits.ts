// agy 1.5.5 truncates a single rule file past 24,000 bytes.
export const AGY_RULE_FILE_MAX_BYTES = 20_000;
// agy 1.5.5 drops rules past about 60,000 bytes in total, earliest first.
export const AGY_RULE_FILES_MAX = 3;

export const AGY_DENIED_CONTINUE_MAX = 3;
export const AGY_CONNECTOR_LIST_TIMEOUT_MS = 10_000;
export const AGY_CONNECTOR_CACHE_MS = 10 * 60_000;
export const AGY_CONNECTOR_RETRY_MS = 60_000;

export const AGY_RULE_TOTAL_BUDGET_BYTES = 60_000;
export const AGY_RULE_SINGLE_BUDGET_BYTES = 24_000;
export const AGY_RULE_WARNING_MAX_FILES = 10;

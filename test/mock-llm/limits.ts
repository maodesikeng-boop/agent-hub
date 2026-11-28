// Invariant: every buffer, body size, concurrency, and timeout cap in test/mock-llm/ lives here.

export const MOCK_LLM_MAX_RECORDED_REQUESTS = 500;
export const MOCK_LLM_MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
export const MOCK_LLM_MAX_CONCURRENT_REQUESTS = 32;
export const MOCK_LLM_DEFAULT_WAIT_TIMEOUT_MS = 15_000;
export const MOCK_LLM_CLI_TURN_TIMEOUT_MS = 45_000;
export const MOCK_LLM_SNAPSHOT_MAX_BYTES = 512 * 1024;
export const MOCK_LLM_PROXY_BLACKHOLE_URL = "http://127.0.0.1:1";
export const MOCK_LLM_REQUIRE_ENV = "BELLWOOD_REQUIRE_REAL_CLI";

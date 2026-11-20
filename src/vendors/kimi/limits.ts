// kimi acp loads its session index and MCP servers before answering session/new.
export const KIMI_START_TIMEOUT_MS = 45_000;

export const KIMI_SHUTDOWN_GRACE_MS = 8_000;

export const KIMI_INTERRUPT_GRACE_MS = 5_000;

// Kimi appends turn.ended to wire.jsonl on a microtask after answering session/prompt.
export const KIMI_TURN_OUTCOME_POLLS = 40;
export const KIMI_TURN_OUTCOME_POLL_MS = 50;

// turn.ended is the last record a turn writes, so only the file tail is decoded.
export const KIMI_WIRE_TAIL_BYTES = 64 * 1024;

export const KIMI_MAX_SCANNED_WORKSPACES = 500;

export const KIMI_MAX_CREDENTIAL_ENTRIES = 50;

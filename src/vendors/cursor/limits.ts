// Cold start is about 8s (initialize 0.8s + session/new 7.3s) and up to 25s on a cold disk.
export const CURSOR_START_TIMEOUT_MS = 45_000;

// cursor-agent takes up to about 4.4s to flush and exit after stdin closes.
export const CURSOR_SHUTDOWN_GRACE_MS = 8_000;

export const CURSOR_INTERRUPT_GRACE_MS = 5_000;

export const CURSOR_PROBE_MAX_STDOUT_BYTES = 512 * 1024;

export const CURSOR_MAX_SCANNED_COMMAND_ENTRIES = 200;

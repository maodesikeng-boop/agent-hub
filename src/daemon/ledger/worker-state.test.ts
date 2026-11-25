import { describe, it } from "vitest";

describe("formatWorkerState", () => {
  it.todo("returns ended for closed Workers regardless of live activity");
  it.todo("returns preparing when live activity is preparing or the worktree has not started");
  it.todo("returns waiting-for-background when live activity is background");
  it.todo("returns working when live activity is working or stopping");
  it.todo("distinguishes idle before first turn, idle awaiting review, idle after interrupt, and idle after error");
  it.todo("appends elapsed idle duration on open idle Workers only when includeIdleDuration is true and idle time meets WORKER_LIST_IDLE_HINT_MIN_MS");
});

describe("lastTurnOutcomesBySession", () => {
  it.todo("returns the latest turn_ended outcome per session in a single batch query");
  it.todo("omits sessions that have no turn_ended step rows");
});

describe("formatBackgroundTasksSummary", () => {
  it.todo("formats each running background task with its clipped command or description and elapsed duration");
  it.todo("caps displayed background tasks at WORKER_SHOW_BACKGROUND_TASKS_MAX and adds an overflow count line");
  it.todo("falls back to a placeholder label when a vendor task omits both command and description");
});

describe("hub worker list and worker show integration", () => {
  it.todo("hub worker list displays accurate per-Worker state, vendor, model, effort, and idle duration instead of collapsing open Workers to in-progress");
  it.todo("hub worker list filters rows by --vendor and rejects unknown vendor names");
  it.todo("hub worker show renders concrete running background commands and elapsed durations while waiting on background tasks");
});

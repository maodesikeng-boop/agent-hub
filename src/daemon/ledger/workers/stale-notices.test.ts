import { describe, it } from "vitest";

describe("cancelQueuedWorkerPmNoticesIn", () => {
  it.todo("transitions queued PM turn_failed, report, worktree_failed, and max_time_exceeded notices for the Worker to stopped");
  it.todo("preserves excluded message ids so a completed step report carrying questions is still delivered");
  it.todo("leaves already-delivered PM notices and notices belonging to other Workers untouched");
});

describe("isWorkerPmNoticeActionable", () => {
  it.todo("returns false for queued turn_failed or max_time_exceeded notices when the Worker is already ended");
  it.todo("returns false for a queued notice when the Worker was replaced on its Task Graph step by a newer Worker");
  it.todo("returns true for a completed step report whose Worker ended normally as part of step completion");
  it.todo("returns true for non-worker system messages and active open Worker notices");
});

describe("stale Worker notification and race suppression", () => {
  it.todo("does not deliver a queued failure reminder to PM after hub worker start replaces the failed Worker on a Task Graph node");
  it.todo("drops a late onTurnOutcome arriving after endWorkerIn without inserting a PM wakeup or reverting the replacement Worker's step state");
  it.todo("cancels stale queued turn_failed and max_time_exceeded notices when hub worker send resumes the same Worker");
});

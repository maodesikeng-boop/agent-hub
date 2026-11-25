import { describe, it } from "vitest";

describe("Worker brief interrupted by daemon shutdown", () => {
  it.todo("requeues an untaken first brief and resends it after restart for every vendor driver that reports the interruption");
  it.todo("records the interrupted turn with the shutdown reason so worker show says it will be resent");
  it.todo("still cancels the brief and wakes the PM with the stopped reason when the user stopped the turn");
});

describe("noticeUnresentShutdownTurnsIn", () => {
  it.todo("queues one turn_failed PM notice for an open Worker whose shutdown-interrupted turn has nothing left to resend");
  it.todo("moves the Worker's Task Graph step to waiting:pm with the not-resent reason");
  it.todo("adds no notice when restart recovery resends or requeues a message for the Worker");
  it.todo("adds no notice for ended Workers, Workers awaiting sandbox approval, or worktrees not yet prepared");
  it.todo("adds no notice when the last turn ended for a reason other than shutdown");
});

describe("first turn that fails before the vendor starts it", () => {
  it.todo("shows the action failure reason as the last turn in worker show instead of no turn yet");
  it.todo("shows the Worker as idle after a failed turn in worker list and worker show");
  it.todo("records only the final failure after launch retries, not one failed turn per retry");
  it.todo("ends an open turn as failed with the reason instead of adding a second turn");
});

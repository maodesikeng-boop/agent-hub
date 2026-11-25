import { describe, it } from "vitest";
import { PM_WAKEUP_SOURCES } from "../../shared/domain.ts";
import { enqueueSystemWakeupIn } from "./system-wakeups.ts";

describe(enqueueSystemWakeupIn.name, () => {
  it.todo(`stores a Task Graph wakeup as sender system with meta { event: "pm.wakeup", source: "${PM_WAKEUP_SOURCES[0]}" } (investigation repro: graph wakeup stored as a user bubble)`);
  it.todo("stores a Router decision wakeup with source router");
  it.todo("every former enqueueWakeupUserMessageIn caller now writes a pm.wakeup notice: graph turned, gate decisions, user-blocked, auto-dispatch failed, graph cancelled, Router resolve");
  it.todo("queues session.send with source system, so a user stop requeues it instead of cancelling it");
  it.todo("a repeated call with the same ref returns the first message and queues nothing");
  it.todo("does not reset a rate-limit rejection, does not echo to Feishu, and gets no replyId");
  it.todo("isSystemMessageCurrent treats pm.wakeup as current, leaving the stale-notice rules unchanged");
  it.todo("migration 0054 converts stored wakeup rows to pm.wakeup system rows and flips their pending session.send actions to source system");
  it.todo("migration 0054 leaves ordinary user messages untouched");
});

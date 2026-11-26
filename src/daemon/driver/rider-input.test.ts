import { describe, expect, it } from "vitest";
import type { MessageId } from "../../shared/domain.ts";
import { takePendingBatch, type PendingEntry } from "./driver-helpers.ts";
import { dropUserEntries } from "./stop-untaken.ts";

const isCommand = (text: string) => text.startsWith("/");
const entry = (id: number, source: PendingEntry["source"], text: string, rider = false): PendingEntry => ({
  messageIds: [id as MessageId],
  source,
  text,
  prefixes: [],
  resend: false,
  ...(rider ? { rider: true as const } : {}),
});
const REMINDER = "【系统】先列清单";

describe("rider inputs", () => {
  it("never form a batch on their own, so a reminder cannot start a turn", () => {
    expect(takePendingBatch([entry(1, "system", REMINDER, true)], isCommand)).toBeNull();
  });

  it("join the next user batch ahead of its text, ids first", () => {
    const result = takePendingBatch([entry(1, "system", REMINDER, true), entry(2, "user", "继续")], isCommand);
    expect(result?.taken.messageIds).toEqual([1, 2]);
    expect(result?.taken.source).toBe("user");
    expect(result?.taken.body.prefixes[0]).toBe(REMINDER);
    expect(result?.taken.body.text).toBe("继续");
    expect(result?.remaining).toEqual([]);
  });

  it("join a queued system notice too, for example a Task Graph wakeup", () => {
    const result = takePendingBatch([entry(1, "system", REMINDER, true), entry(2, "system", "【任务图】第 2 步完成")], isCommand);
    expect(result?.taken.messageIds).toEqual([1, 2]);
    expect(result?.taken.body.prefixes).toContain(REMINDER);
    expect(result?.taken.body.text).toBe("【任务图】第 2 步完成");
  });

  it("wait past a command batch, which cannot carry prefixes", () => {
    const first = takePendingBatch([entry(1, "system", REMINDER, true), entry(2, "user", "/compact"), entry(3, "user", "好了")], isCommand);
    expect(first?.taken.messageIds).toEqual([2]);
    expect(first?.taken.command).toBe(true);
    const second = takePendingBatch(first!.remaining, isCommand);
    expect(second?.taken.messageIds).toEqual([1, 3]);
    expect(second?.taken.body.prefixes[0]).toBe(REMINDER);
  });

  it("survive a user stop like other system inputs", () => {
    const { kept, dropped } = dropUserEntries([entry(1, "system", REMINDER, true), entry(2, "user", "跑一下")]);
    expect(dropped).toEqual([2]);
    expect(kept.map((e) => e.rider)).toEqual([true]);
  });

  it("leave batches without riders unchanged", () => {
    const result = takePendingBatch([entry(1, "user", "一"), entry(2, "user", "二"), entry(3, "system", "通知")], isCommand);
    expect(result?.taken.messageIds).toEqual([1, 2]);
    expect(result?.taken.body.prefixes[0]).toContain("【用户连发了 2 条】");
    expect(result?.remaining.map((e) => e.messageIds[0])).toEqual([3]);
  });
});

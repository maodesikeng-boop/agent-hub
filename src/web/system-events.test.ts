import { describe, expect, it } from "vitest";
import { groupMessages } from "./selectors.ts";
import { describeSystemEvent, eventGroupFamily, groupMessageRows } from "./system-events.ts";
import { makeMessage, makeSystemMessage, makeUserMessage, makeWorkerLine } from "./test-utils.ts";

describe("system-events", () => {
  it("classifies system events with structured tags, icons, and failure titles", () => {
    const attached = describeSystemEvent(
      makeSystemMessage({
        id: 1,
        text: "挂上了文件夹：/Users/dev/app",
        event: { event: "folder.attached", projectId: 1, folderId: 2, path: "/Users/dev/app" },
      }),
    );
    expect(attached).toEqual({
      family: "system",
      icon: "folder-plus",
      tag: "Folder",
      text: "挂上了文件夹：/Users/dev/app",
      tone: "neutral",
    });

    const persona = describeSystemEvent(
      makeSystemMessage({
        id: 2,
        text: "阿青改了自己的做事习惯",
        event: { event: "persona.changed", pmId: 1, personaChangeId: 3, revertOf: null },
      }),
    );
    expect(persona.tag).toBe("Persona");
    expect(persona.icon).toBe("user-pen");
    expect(persona.tone).toBe("neutral");

    const failed = describeSystemEvent(
      makeSystemMessage({
        id: 3,
        text: "定时任务没跑成：巡检",
        event: {
          event: "schedule.failed",
          scheduleId: 1,
          name: "巡检",
          messageId: 9,
          rawReason: 'API Error: 529 {"type":"overloaded_error"}',
        },
      }),
    );
    expect(failed.tag).toBe("Schedule failed");
    expect(failed.tone).toBe("danger");
    expect(failed.rawTitle).toBe('API Error: 529 {"type":"overloaded_error"}');
    expect(failed.text).toBe('Scheduled task "巡检" failed: Claude 服务繁忙，稍后重试');
  });

  it("groups consecutive standalone events of the same family and caches by input reference", () => {
    const items = groupMessages([
      makeSystemMessage({ id: 1, text: "挂上了文件夹：/repo", event: { event: "folder.attached", projectId: 1, folderId: 1, path: "/repo" } }),
      makeSystemMessage({ id: 2, text: "阿青改了自己的做事习惯", event: { event: "persona.changed", pmId: 1, personaChangeId: 5, revertOf: null } }),
      makeSystemMessage({ id: 3, text: "交接摘要", event: { event: "session.renewed", sessionId: 2, fromSessionId: 1 } }),
      makeWorkerLine({ id: 4, line: { event: "started", title: "修样式" } }),
      makeWorkerLine({ id: 5, line: { event: "ended", title: "修样式" } }),
      makeUserMessage({ id: 6, text: "继续" }),
      makeMessage({ id: 7, text: "好的" }),
    ]).items;

    const first = groupMessageRows(items);
    expect(groupMessageRows(items)).toBe(first);
    expect(first.map((r) => r.kind)).toEqual(["event_group", "message", "event_group", "message", "turn"]);
    expect(first[0]).toMatchObject({ kind: "event_group", family: "system", key: "events:1-2" });
    expect(first[2]).toMatchObject({ kind: "event_group", family: "worker", key: "events:4-5" });
  });

  it("keeps worker report cards and collapsible system notices ungrouped", () => {
    expect(eventGroupFamily(makeWorkerLine({ id: 1, line: { event: "report", status: "done", summary: "ok" } }))).toBeNull();
    expect(eventGroupFamily(makeSystemMessage({ id: 2, text: "handover", event: { event: "session.renewed", sessionId: 2, fromSessionId: 1 } }))).toBeNull();
    expect(eventGroupFamily(makeSystemMessage({ id: 3, text: "【定时任务】跑一下", event: { event: "schedule.run", scheduleId: 1, name: "a", scheduledAt: 0, catchUp: false } }))).toBeNull();
  });
});

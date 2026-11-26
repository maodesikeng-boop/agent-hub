import { describe, expect, it } from "vitest";
import { activeChecklistItemId, applyChecklistUpdate, checklistOf, normalizeChecklistStatus, sameChecklist, turnChecklist, type ChecklistItemInput } from "./checklist.ts";
import { CHECKLIST_MAX_ITEMS, CHECKLIST_TITLE_MAX_CHARS } from "./limits.ts";

const input = (title: string, id: string | null = null) => ({ id, title, status: "pending" as const });
const replace = (...items: ChecklistItemInput[]) => applyChecklistUpdate([], { kind: "replace", items });

describe("checklist snapshots", () => {
  it.each([
    ["pending", "pending"], ["in_progress", "in_progress"], ["inProgress", "in_progress"],
    ["TODO_STATUS_IN_PROGRESS", "in_progress"], ["COMPLETED", "completed"], ["done", "completed"],
    ["cancelled", "cancelled"], ["unrecognized", null], [0, null], [undefined, null],
  ])("normalizes %s", (raw, result) => expect(normalizeChecklistStatus(raw)).toBe(result));

  it("keeps replace order and gives repeated titles unique ids without overriding vendor ids", () => {
    expect(replace(input("A"), input("A"), input("B", "t:A#2"), input("Duplicate id", "t:A#2")).map((x) => x.id))
      .toEqual(["t:A", "t:A#3", "t:A#2"]);
  });

  it("caps item count and clips Unicode titles instead of cutting a surrogate pair", () => {
    const title = "🟢".repeat(CHECKLIST_TITLE_MAX_CHARS);
    const items = replace(input(" "), input(" " + title + "extra "), ...Array.from({ length: CHECKLIST_MAX_ITEMS }, (_, i) => input(String(i))));
    expect(items.length).toBeLessThanOrEqual(CHECKLIST_MAX_ITEMS);
    expect(items[0]).toMatchObject({ title, id: `t:${title}` });
    expect(checklistOf({ kind: "checklist", meta: { checklist: items } })).toEqual(items);
  });

  it("merges and removes by id, dropping incomplete additions", () => {
    const prev = replace(input("A", "a"), input("B", "b"));
    const next = applyChecklistUpdate(prev, { kind: "merge", items: [
      { id: "a", title: "New A", activeTitle: " Working ", status: "in_progress" },
      { id: "c", status: "pending" },
      { id: "d", title: "D", status: "completed" },
    ] });
    expect(next).toEqual([
      { id: "a", title: "New A", activeTitle: "Working", status: "in_progress" },
      prev[1],
      { id: "d", title: "D", activeTitle: null, status: "completed" },
    ]);
    expect(prev[0]?.title).toBe("A");
    expect(activeChecklistItemId(next)).toBe("a");
    expect(sameChecklist(next, [...next])).toBe(true);
    expect(sameChecklist(next, [...next].reverse())).toBe(false);
    expect(sameChecklist(next, [{ ...next[0]!, activeTitle: null }, ...next.slice(1)])).toBe(false);
    expect(applyChecklistUpdate(next, { kind: "remove", ids: ["a", "unknown"] })).toEqual(next.slice(1));
    expect(activeChecklistItemId(next.slice(1))).toBeNull();
    expect(applyChecklistUpdate(next, { kind: "replace", items: [] })).toEqual([]);
  });

  it("ignores other message kinds and rejects malformed persisted snapshots", () => {
    const a = replace(input("A"))[0]!;
    expect(checklistOf({ kind: "tool", meta: { checklist: [a] } })).toBeNull();
    for (const checklist of [[a, a], [{ ...a, title: "  " }], [{ ...a, status: "typo" }]]) {
      expect(checklistOf({ kind: "checklist", meta: { checklist } })).toBeNull();
    }
  });
});

describe(turnChecklist.name, () => {
  it("keeps new, changed and unfinished items in the current list's order", () => {
    const previous = replace(
      { ...input("Completed", "a"), status: "completed" },
      { ...input("Cancelled", "b"), status: "cancelled" },
      { ...input("Continuing", "c"), status: "in_progress" },
      input("Finishing", "d"),
      input("Still pending", "e"),
    );
    const current = applyChecklistUpdate(previous, { kind: "merge", items: [
      { id: "d", status: "completed" },
      { id: "f", title: "New", status: "completed" },
    ] });
    expect(turnChecklist([], current).visible).toBe(current);
    expect(turnChecklist(previous, current).visible).toEqual(current.slice(2));
    const renamed = current.map((item) => item.id === "a" ? { ...item, title: "Renamed" } : item);
    expect(turnChecklist(previous, renamed).visible.map((item) => item.id)).toEqual(["a", "c", "d", "e", "f"]);
  });

  it("keeps a changed item visible if it later matches the baseline again", () => {
    const done = { ...input("Run tests"), status: "completed" as const };
    const baseline = replace(done, { ...done, title: "Read logs" });
    const started = turnChecklist(baseline, replace(input("Run tests"), { ...done, title: "Read logs" }));
    expect(started.visible.map(({ title }) => title)).toEqual(["Run tests"]);
    expect(turnChecklist(started.unchanged, baseline).visible.map(({ title, status }) => [title, status]))
      .toEqual([["Run tests", "completed"]]);
  });
});

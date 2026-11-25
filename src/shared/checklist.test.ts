import { describe, expect, it } from "vitest";
import { activeChecklistItemId, applyChecklistUpdate, checklistOf, normalizeChecklistStatus, sameChecklist, turnChecklist } from "./checklist.ts";
import { CHECKLIST_MAX_ITEMS, CHECKLIST_TITLE_MAX_CHARS } from "./limits.ts";

const input = (title: string, id: string | null = null) => ({ id, title, status: "pending" as const });
const replace = (...items: ReturnType<typeof input>[]) => applyChecklistUpdate([], { kind: "replace", items });

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
  it.todo("returns the current list unchanged when the baseline is empty (first turn)");
  it.todo("drops items completed in an earlier turn that this turn did not touch");
  it.todo("drops items cancelled in an earlier turn that this turn did not touch");
  it.todo("keeps unchanged pending and in_progress items carried over from an earlier turn");
  it.todo("keeps an earlier item this turn ticked off, shown as completed");
  it.todo("keeps items added this turn and items whose title or active title changed");
  it.todo("keeps the order of the current list");
  it.todo("treats a whole-list replace that repeats old completed items as unchanged for those items");
});

import { describe, expect, it } from "vitest";
import { makeMessage } from "../daemon/ui-server/fake-ledger.ts";
import type { ChecklistItem, ChecklistStatus, Message } from "../shared/index.ts";
import { turnProgress } from "./turn-progress.ts";

const item = (id: string, status: ChecklistStatus = "pending", title = id): ChecklistItem => ({ id, title, status, activeTitle: null });
const snap = (id: number, checklist: ChecklistItem[]): Message => ({ ...makeMessage(id, 1), kind: "checklist", meta: { checklist } });
const work = (...ids: number[]): Message[] => ids.map((id) => ({ ...makeMessage(id, 1), kind: "tool" }));

describe("turnProgress", () => {
  it("preserves process when a turn has no checklist or the checklist was cleared", () => {
    const rows = work(1);
    expect(turnProgress(rows, [])).toEqual({ steps: null, unassigned: rows });
    expect(turnProgress(rows, [snap(2, [])])).toEqual({ steps: [], unassigned: rows });
  });

  it("attributes each message once while using the newest checklist labels and statuses", () => {
    const rows = work(1, 3, 5, 7, 9);
    const checklists = [
      snap(2, [item("A", "in_progress"), item("B"), item("C")]),
      snap(4, [item("A", "completed"), item("B", "in_progress"), item("C")]),
      snap(6, [item("A", "completed"), item("B", "completed"), item("C")]),
      snap(8, [item("A", "completed", "First"), item("C", "completed")]),
    ];
    expect(turnProgress(rows, checklists)).toEqual({
      steps: [{ item: item("A", "completed", "First"), process: rows }, { item: item("C", "completed"), process: [] }],
      unassigned: [],
    });
    expect(turnProgress(rows, checklists.slice(0, -1)).steps?.map((step) => step.process.map(({ id }) => id)))
      .toEqual([[1, 3], [5, 7, 9], []]);
  });

  it("keeps the reference when arrays are recreated with the same messages", () => {
    const rows = work(1);
    const checklists = [snap(2, [item("A")])];
    const model = turnProgress(rows, checklists);
    expect(turnProgress([...rows], [...checklists])).toBe(model);
    expect(turnProgress(rows, [...checklists, snap(3, [])])).not.toBe(model);
  });
});

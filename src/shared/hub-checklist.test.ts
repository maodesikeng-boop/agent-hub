import { describe, expect, it } from "vitest";
import { applyChecklistUpdate, type ChecklistItem } from "./checklist.ts";
import { HUB_CHECKLIST_USAGE, hubChecklistUpdate, parseHubChecklistArgs } from "./hub-checklist.ts";
import { CHECKLIST_MAX_ITEMS, CHECKLIST_TITLE_MAX_CHARS } from "./limits.ts";

const list = (...statuses: ChecklistItem["status"][]): ChecklistItem[] =>
  statuses.map((status, i) => ({ id: `id${i + 1}`, title: `Step ${i + 1}`, activeTitle: null, status }));

function parsed(argv: string[]) {
  const result = parseHubChecklistArgs(argv);
  if (!result.ok) throw new Error(result.error);
  return result.request;
}

function updated(argv: string[], current: ChecklistItem[]) {
  const result = hubChecklistUpdate(parsed(argv), current);
  if (!result.ok) throw new Error(result.error);
  return applyChecklistUpdate(current, result.update).map((item) => [item.title, item.status]);
}

describe("hub checklist usage", () => {
  it("shows every subcommand with double-quoted titles only", () => {
    for (const word of ["hub checklist set", "start", "done", "cancel"]) expect(HUB_CHECKLIST_USAGE).toContain(word);
    expect(HUB_CHECKLIST_USAGE).toContain('"');
    expect(HUB_CHECKLIST_USAGE).not.toMatch(/<<|--stdin|'@/u);
  });
});

describe(parseHubChecklistArgs.name, () => {
  it("keeps titles verbatim, including CJK and spaces inside one argument", () => {
    expect(parsed(["set", "读 配置", "  Fix the parser ", "运行测试"])).toEqual({ kind: "set", titles: ["读 配置", "Fix the parser", "运行测试"] });
  });

  it("drops blank titles and clips long ones", () => {
    const long = "长".repeat(CHECKLIST_TITLE_MAX_CHARS + 100);
    const request = parsed(["set", " ", long]);
    expect(request).toEqual({ kind: "set", titles: ["长".repeat(CHECKLIST_TITLE_MAX_CHARS)] });
  });

  it("reads 1-based positions", () => {
    expect(parsed(["start", "2"])).toEqual({ kind: "start", position: 2 });
    expect(parsed(["done", "1"])).toEqual({ kind: "done", position: 1 });
    expect(parsed(["cancel", "3"])).toEqual({ kind: "cancel", position: 3 });
  });

  it.each([
    [[]],
    [["list"]],
    [["set"]],
    [["set", " ", ""]],
    [["done"]],
    [["done", "0"]],
    [["done", "-1"]],
    [["done", "1.5"]],
    [["done", "two"]],
    [["done", "1", "2"]],
    [["set", ...Array.from({ length: CHECKLIST_MAX_ITEMS + 1 }, (_, i) => `s${i}`)]],
  ])("rejects %j with the usage text", (argv) => {
    const result = parseHubChecklistArgs(argv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(HUB_CHECKLIST_USAGE);
  });
});

describe(hubChecklistUpdate.name, () => {
  it("set replaces the list with the first step in progress", () => {
    expect(updated(["set", "A", "B", "C"], list("completed"))).toEqual([["A", "in_progress"], ["B", "pending"], ["C", "pending"]]);
  });

  it("done completes a step and starts the next pending one", () => {
    expect(updated(["done", "1"], list("in_progress", "pending", "pending"))).toEqual([
      ["Step 1", "completed"], ["Step 2", "in_progress"], ["Step 3", "pending"],
    ]);
  });

  it("done on the last step leaves nothing in progress", () => {
    expect(updated(["done", "2"], list("completed", "in_progress"))).toEqual([["Step 1", "completed"], ["Step 2", "completed"]]);
  });

  it("start moves the in-progress mark", () => {
    expect(updated(["start", "3"], list("in_progress", "pending", "pending"))).toEqual([
      ["Step 1", "pending"], ["Step 2", "pending"], ["Step 3", "in_progress"],
    ]);
  });

  it("cancel marks a step cancelled", () => {
    expect(updated(["cancel", "2"], list("completed", "pending"))).toEqual([["Step 1", "completed"], ["Step 2", "cancelled"]]);
  });

  it("works on a list another tool wrote, by position", () => {
    const current: ChecklistItem[] = [
      { id: "task-17", title: "Native one", activeTitle: null, status: "in_progress" },
      { id: "task-18", title: "Native two", activeTitle: null, status: "pending" },
    ];
    expect(updated(["done", "1"], current)).toEqual([["Native one", "completed"], ["Native two", "in_progress"]]);
  });

  it("rejects a position beyond the list and names its length", () => {
    const result = hubChecklistUpdate({ kind: "done", position: 9 }, list("pending", "pending", "pending"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("3");
      expect(result.error).toContain(HUB_CHECKLIST_USAGE);
    }
  });

  it("rejects start, done, and cancel when there is no list yet", () => {
    expect(hubChecklistUpdate({ kind: "start", position: 1 }, []).ok).toBe(false);
  });
});

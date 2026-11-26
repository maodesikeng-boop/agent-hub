import { describe, expect, it } from "vitest";
import { VENDOR_LIST } from "../vendors/registry.ts";
import type { DriverEvent } from "./driver.ts";
import { TURN_CHECKLIST_COMMANDS_TRIGGER, TURN_CHECKLIST_EDITS_TRIGGER } from "./limits.ts";
import type { ToolAction } from "../vendors/types.ts";
import { newTurnWatch, turnWatchStep, type TurnChecklistWatch } from "./turn-checklist.ts";

let seq = 0;
const at = 1_700_000_000_000;
const processing = (midTurn = false): DriverEvent => ({ type: "message.processing", messageIds: [1], at, ...(midTurn ? { midTurn: true as const } : {}) });
const tool = (name: string, extra: { parentToolUseId?: string } = {}): DriverEvent =>
  ({ type: "agent.tool", uuid: `u${++seq}`, toolUseId: `t${seq}`, name, input: {}, at, ...extra });
const listed = (extra: { parentToolUseId?: string } = {}): DriverEvent =>
  ({ type: "agent.checklist", uuid: `c${++seq}`, update: { kind: "replace", items: [{ id: null, title: "Fix", status: "in_progress" }] }, at, ...extra });
const ended: DriverEvent = { type: "turn.ended", ok: true, interrupted: false, messageIds: [1], durationMs: 10, at };
const exited: DriverEvent = { type: "session.exited", reason: "idle", exitCode: 0, signal: null, hadResult: true, messageIds: [], at };

function toolNamed(action: ToolAction | readonly ToolAction[]): string {
  const wanted = typeof action === "string" ? [action] : action;
  for (const spec of VENDOR_LIST) {
    const hit = Object.entries(spec.tools?.actions ?? {}).find(([, a]) => wanted.includes(a));
    if (hit) return hit[0];
  }
  throw new Error(`no vendor tool for ${wanted.join(",")}`);
}
const COMMAND = toolNamed("command");
const EDIT = toolNamed("edit");
const WRITE = toolNamed("write");
const READ = toolNamed("read");
const SEARCH = toolNamed("search");
const TODO = toolNamed("todo");

/** Runs events from a closed state and returns the index of each event that reminded. */
function run(events: readonly DriverEvent[], start: TurnChecklistWatch | null = null): { reminders: number[]; watch: TurnChecklistWatch | null } {
  let watch = start;
  const reminders: number[] = [];
  events.forEach((event, i) => {
    const step = turnWatchStep(watch, event);
    watch = step.watch;
    if (step.remind) reminders.push(i);
  });
  return { reminders, watch };
}

describe("turn watch trigger", () => {
  it("uses the documented thresholds", () => {
    expect(TURN_CHECKLIST_EDITS_TRIGGER).toBe(1);
    expect(TURN_CHECKLIST_COMMANDS_TRIGGER).toBe(2);
  });

  it("starts a fresh watch with zero counts", () => {
    expect(newTurnWatch()).toEqual({ edits: 0, commands: 0, listed: false, reminded: false });
  });

  it("does not remind a question turn that only reads and searches", () => {
    expect(run([processing(), tool(READ), tool(SEARCH), tool(READ), ended]).reminders).toEqual([]);
  });

  it("does not remind a turn with a single command", () => {
    expect(run([processing(), tool(READ), tool(COMMAND), ended]).reminders).toEqual([]);
  });

  it("reminds at the second command of an unlisted turn", () => {
    expect(run([processing(), tool(COMMAND), tool(READ), tool(COMMAND), tool(COMMAND), ended]).reminders).toEqual([3]);
  });

  it("reminds at the first file edit or write of an unlisted turn", () => {
    expect(run([processing(), tool(READ), tool(EDIT), tool(EDIT), ended]).reminders).toEqual([2]);
    expect(run([processing(), tool(WRITE), ended]).reminders).toEqual([1]);
  });

  it("never reminds a turn that updated its checklist before acting", () => {
    expect(run([processing(), listed(), tool(EDIT), tool(COMMAND), tool(COMMAND), ended]).reminders).toEqual([]);
  });

  it("reminds only once per turn even if the agent keeps going without a list", () => {
    expect(run([processing(), tool(EDIT), tool(EDIT), tool(COMMAND), tool(COMMAND), tool(WRITE), ended]).reminders).toEqual([1]);
  });

  it("a checklist update after the reminder stops further reminders", () => {
    const { reminders, watch } = run([processing(), tool(EDIT), listed(), tool(EDIT)]);
    expect(reminders).toEqual([1]);
    expect(watch).toMatchObject({ listed: true, reminded: true });
  });
});

describe("turn boundaries", () => {
  it("judges two consecutive turns separately", () => {
    const events = [processing(), listed(), tool(EDIT), ended, processing(), tool(EDIT), ended];
    expect(run(events).reminders).toEqual([5]);
  });

  it("a second turn that updates the list is not reminded", () => {
    const events = [processing(), tool(EDIT), ended, processing(), listed(), tool(EDIT), ended];
    expect(run(events).reminders).toEqual([1]);
  });

  it("a mid-turn delivery does not open a new turn", () => {
    expect(run([processing(), tool(EDIT), processing(true), tool(EDIT), ended]).reminders).toEqual([1]);
  });

  it("turn.started opens a turn the CLI started itself", () => {
    expect(run([{ type: "turn.started", at }, tool(COMMAND), tool(COMMAND)]).reminders).toEqual([2]);
  });

  it("turn.ended and session.exited close the turn", () => {
    expect(run([processing(), tool(EDIT), ended]).watch).toBeNull();
    expect(run([processing(), tool(EDIT), exited]).watch).toBeNull();
  });

  it("after a daemon restart, tool events of the running turn open an implicit turn and remind once", () => {
    const { reminders, watch } = run([tool(COMMAND), tool(COMMAND), tool(EDIT)]);
    expect(reminders).toEqual([1]);
    expect(watch).toMatchObject({ commands: 2, edits: 1, reminded: true });
  });

  it("an event after turn.ended opens a fresh implicit turn instead of reusing the old one", () => {
    const events = [processing(), tool(EDIT), ended, tool(EDIT)];
    expect(run(events).reminders).toEqual([1, 3]);
  });
});

describe("abnormal and ignored events", () => {
  it("ignores subagent tools and subagent checklists", () => {
    const events = [processing(), tool(EDIT, { parentToolUseId: "sub" }), tool(COMMAND, { parentToolUseId: "sub" }), tool(COMMAND, { parentToolUseId: "sub" })];
    expect(run(events).reminders).toEqual([]);
    expect(run([processing(), listed({ parentToolUseId: "sub" }), tool(EDIT)]).reminders).toEqual([2]);
  });

  it("ignores unknown tool names and todo tools", () => {
    const events = [processing(), tool("definitely_not_a_tool"), tool("mcp__x__y"), tool(TODO), tool(TODO), tool(TODO), ended];
    expect(run(events).reminders).toEqual([]);
  });

  it("never throws on any other driver event", () => {
    const others: DriverEvent[] = [
      { type: "agent.text", uuid: "a", text: "hi", at },
      { type: "agent.thinking", uuid: "b", at },
      { type: "agent.text_delta", delta: "x", at },
      { type: "agent.tool_result", toolUseIds: ["t1"], at },
      { type: "agent.tool_running", toolUseId: "t1", at },
      { type: "message.delivered", messageIds: [1], at },
      { type: "background.changed", count: 0, at },
    ];
    for (const event of others) {
      expect(() => turnWatchStep(null, event)).not.toThrow();
      expect(turnWatchStep(newTurnWatch(), event).remind).toBe(false);
    }
  });
});

describe("every registered vendor", () => {
  it.each(VENDOR_LIST.map((spec) => [spec.id, spec] as const))("%s: a command tool and an edit tool trigger the same rule", (_id, spec) => {
    const actions = Object.entries(spec.tools?.actions ?? {});
    const command = actions.find(([, a]) => a === "command")?.[0];
    const edit = actions.find(([, a]) => a === "edit" || a === "write")?.[0];
    if (command !== undefined) expect(run([processing(), tool(command), tool(command)]).reminders).toEqual([2]);
    if (edit !== undefined) expect(run([processing(), tool(edit)]).reminders).toEqual([1]);
    expect(command ?? edit).toBeDefined();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemEventOf } from "../../shared/domain.ts";
import { createPmFrictionFixture, reportBlock, type PmFrictionFixture } from "./pm-friction-fixture.ts";
import { dueAgendaRemindersOf } from "./pm-agenda-reminders.ts";

const MINUTE = 60_000;

describe("S6: an idle PM is reminded about work it left open (D-A1 option 1)", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  async function readyGraph(): Promise<number> {
    const graph = f.createGraph({ title: "等交付", steps: [{ key: "impl", title: "实现", brief: "实现" }] }).data.graph;
    const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
    await f.startWorktree(wid);
    f.workerTurn(wid, reportBlock({ status: "做完了", summary: "实现好了" }));
    const note = f.pmSystemMessages().find((m) => systemEventOf(m)?.event === "task_graph.ready_to_finish")!;
    f.pmReplyTo(note.id, "等检查通过后再交付");
    return graph.id;
  }

  it("S6.1: nothing is due before 15 minutes; at 15 minutes one reminder lists the ready graph", async () => {
    const graphId = await readyGraph();
    expect(dueAgendaRemindersOf(f.db, f.clock.now + 14 * MINUTE)).toEqual([]);
    const due = dueAgendaRemindersOf(f.db, f.clock.now + 15 * MINUTE);
    expect(due).toHaveLength(1);
    expect(due[0]!.pmId).toBe(f.lin.pmId);
    expect(due[0]!.refs.some((ref) => ref.startsWith(`graph:${graphId}:`))).toBe(true);
  });

  it("S6.2: no reminder while a message is queued for the PM", async () => {
    await readyGraph();
    f.ledger.postUserMessage({ conversationId: f.lin.conversationId, clientId: "queued", text: "排着的" });
    expect(dueAgendaRemindersOf(f.db, f.clock.now + 20 * MINUTE)).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemEventOf, type Message, type SystemMessageMeta } from "../../shared/domain.ts";
import { PM_AGENDA_PREAMBLE_HEADING } from "../../shared/pm-agenda.ts";
import { createPmFrictionFixture, reportBlock, type PmFrictionFixture } from "./pm-friction-fixture.ts";
import { SYSTEM_EVENT_IN_SWITCH_LOG, formatGenerationMessage } from "./vendor-switch-context.ts";

function systemMessage(id: number, meta: SystemMessageMeta, text: string): Message {
  return {
    id,
    conversationId: 1,
    sessionId: 1,
    workerId: null,
    sender: "system",
    kind: "text",
    text,
    meta,
    collapsed: false,
    dedupeKey: `k:${id}`,
    status: "replied",
    failureReason: null,
    createdAt: id * 100,
    updatedAt: id * 100,
  };
}

describe("S4: the graph is done, accept it, meets a handover", () => {
  it("S4.3: a vendor switch keeps a Task Graph wakeup the old session read", () => {
    const wake = systemMessage(10, { event: "pm.wakeup", source: "task_graph", ref: "graph-turned:141:auto-done:review:1" }, "【任务图 #141「取消残留」】轮到了：merge，等你处理。");
    const kept = formatGenerationMessage(wake, 2);
    expect(kept).not.toBeNull();
    expect(kept ?? "").toContain("轮到了：merge");
  });

  it("S4.6 (regression): the delivery note and schedule runs stay in the vendor-switch log, and every event kind has an entry", () => {
    const ready = systemMessage(11, { event: "task_graph.ready_to_finish", graphId: 141, seq: 1 }, "【任务图 #141「取消残留」全部步骤做完，等你交付】");
    expect(formatGenerationMessage(ready, 2)).toContain("#141");
    expect(SYSTEM_EVENT_IN_SWITCH_LOG["schedule.run"]).toBe(true);
    expect(Object.keys(SYSTEM_EVENT_IN_SWITCH_LOG).length).toBe(16);
  });

  describe("with a ledger", () => {
    let f: PmFrictionFixture;

    beforeEach(() => {
      f = createPmFrictionFixture();
    });

    afterEach(() => {
      f.close();
    });

    async function readGraphAndWait(): Promise<number> {
      const graph = f.createGraph({ title: "取消残留", steps: [{ key: "impl", title: "实现", brief: "实现" }] }).data.graph;
      const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
      await f.startWorktree(wid);
      f.workerTurn(wid, reportBlock({ status: "做完了", summary: "实现好了" }));
      const note = f.pmSystemMessages().find((m) => systemEventOf(m)?.event === "task_graph.ready_to_finish")!;
      f.pmReplyTo(note.id, "暂不合并，等检查通过后合并");
      return graph.id;
    }

    const pmSessions = () =>
      f.db.all<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation", f.lin.conversationId).map((r) => r.id);

    it("S4.2: after a vendor switch with nothing queued, the preamble opens with what waits for the PM and one handover notice starts the new session", async () => {
      const graphId = await readGraphAndWait();
      f.ledger.editPersona(f.lin.pmId, { vendor: "codex", model: "gpt-6-luna" }, { kind: "user" });
      const sessions = pmSessions();
      expect(sessions).toHaveLength(2);
      const next = sessions[1]!;

      const preamble = f.ledger.sessionPreamble(next)!;
      expect(preamble).toContain(PM_AGENDA_PREAMBLE_HEADING);
      expect(preamble.split(PM_AGENDA_PREAMBLE_HEADING)[1]).toContain(`图 #${graphId}「取消残留」1 个步骤 · 全部做完，等你验收交付`);
      expect(preamble).not.toContain("## 未完结的任务图（账本实时状态）");

      const queued = f.pmMessages().filter((m) => m.sessionId === next && m.status === "queued");
      expect(queued).toHaveLength(1);
      expect(systemEventOf(queued[0]!)).toMatchObject({ event: "pm.wakeup" });
      expect(queued[0]!.text).toContain("【交接后还有事等你】");
    });

    it("S4.4: a restart after the switch sends no second handover notice", async () => {
      await readGraphAndWait();
      f.ledger.editPersona(f.lin.pmId, { vendor: "codex", model: "gpt-6-luna" }, { kind: "user" });
      const next = pmSessions()[1]!;
      f.ledger.recoverAfterRestart();
      const handoverNotices = f.pmMessages().filter((m) => m.sessionId === next && m.text.includes("【交接后还有事等你】"));
      expect(handoverNotices).toHaveLength(1);
    });

    it("S4.1 (regression): a delivery note still queued at a switch moves to the new session once", async () => {
      const graph = f.createGraph({ title: "排队中的交付单", steps: [{ key: "impl", title: "实现", brief: "实现" }] }).data.graph;
      const wid = f.showGraph(graph.id).nodes[0]!.activeWorkerId!;
      await f.startWorktree(wid);
      f.workerTurn(wid, reportBlock({ status: "做完了", summary: "实现好了" }));
      const note = f.pmSystemMessages().find((m) => systemEventOf(m)?.event === "task_graph.ready_to_finish")!;
      expect(note.status).toBe("queued");

      f.ledger.editPersona(f.lin.pmId, { vendor: "codex", model: "gpt-6-luna" }, { kind: "user" });
      const next = pmSessions().at(-1)!;
      const moved = f.ledger.getMessage(note.id)!;
      expect(moved).toMatchObject({ status: "queued", sessionId: next });
      expect(f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "task_graph.ready_to_finish")).toHaveLength(1);
    });
  });
});

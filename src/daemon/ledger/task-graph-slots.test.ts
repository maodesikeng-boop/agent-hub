import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemEventOf } from "../../shared/domain.ts";
import { createPmFrictionFixture, reportBlock, type PmFrictionFixture } from "./pm-friction-fixture.ts";
import { admitStep, slotHolderOf } from "./task-graphs/slots.ts";

describe("S7: steps that share a slot on this computer take turns", () => {
  let f: PmFrictionFixture;

  beforeEach(() => {
    f = createPmFrictionFixture();
  });

  afterEach(() => {
    f.close();
  });

  const realReview = (title: string) =>
    f.createGraph({
      title,
      steps: [
        { key: "review", title: "逻辑审查", brief: "审查", deps: [] },
        { key: "review-real", title: "真实环境审查", brief: "真实环境跑一遍", slot: "real-env", deps: [] },
      ],
    }).data.graph;

  it("S7.1 and S7.2: the second step with the same slot waits, shows its holder and position, and manual start does not bypass it", () => {
    const first = realReview("图甲");
    const second = realReview("图乙");
    const a = f.showGraph(first.id);
    const b = f.showGraph(second.id);
    expect(a.nodes.find((n) => n.key === "review")!.status).toBe("running");
    expect(a.nodes.find((n) => n.key === "review-real")).toMatchObject({ status: "running", slot: "real-env" });
    expect(b.nodes.find((n) => n.key === "review")!.status).toBe("running");
    const queued = b.nodes.find((n) => n.key === "review-real")!;
    expect(queued).toMatchObject({ status: "pending", slot: "real-env", activeWorkerId: null });
    expect(queued.slotQueue).toMatchObject({ position: 1, holder: { graphId: first.id, nodeKey: "review-real" } });

    const receipt = f.ledger.hubCall(f.lin.sessionId, "worker.start", { node: "review-real", graphId: second.id });
    expect(receipt.text).toContain("名额「real-env」");
    expect(f.showGraph(second.id).nodes.find((n) => n.key === "review-real")!.status).toBe("pending");
  });

  it("S7.3: when the holder reports done and ends, the waiting step starts in the next write without waking the PM", async () => {
    const first = realReview("图甲");
    const second = realReview("图乙");
    const holder = f.showGraph(first.id).nodes.find((n) => n.key === "review-real")!.activeWorkerId!;
    await f.startWorktree(holder);
    expect(f.showGraph(second.id).nodes.find((n) => n.key === "review-real")!.status).toBe("pending");
    const wakesBefore = f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "pm.wakeup").length;
    f.workerTurn(holder, reportBlock({ status: "做完了", summary: "真实环境通过" }));
    expect(f.showGraph(second.id).nodes.find((n) => n.key === "review-real")!.status).toBe("running");
    expect(f.pmSystemMessages().filter((m) => systemEventOf(m)?.event === "pm.wakeup")).toHaveLength(wakesBefore);
  });

  it("S7.4: a holder that brakes to the PM frees the slot for the next step", async () => {
    const first = realReview("图甲");
    const second = realReview("图乙");
    const holder = f.showGraph(first.id).nodes.find((n) => n.key === "review-real")!.activeWorkerId!;
    await f.startWorktree(holder);
    expect(f.showGraph(second.id).nodes.find((n) => n.key === "review-real")!.status).toBe("pending");
    f.workerTurn(holder, reportBlock({ status: "有问题", summary: "环境起不来" }));
    expect(f.showGraph(first.id).nodes.find((n) => n.key === "review-real")).toMatchObject({ status: "waiting", waitingFor: "pm" });
    expect(f.showGraph(second.id).nodes.find((n) => n.key === "review-real")!.status).toBe("running");
  });

  it("S7.6 (regression): graphs without slot start every ready step at once", () => {
    const graph = f.createGraph({
      title: "没有名额",
      steps: [
        { key: "a", title: "甲", brief: "甲", deps: [] },
        { key: "b", title: "乙", brief: "乙", deps: [] },
      ],
    }).data.graph;
    expect(f.showGraph(graph.id).nodes.map((n) => n.status)).toEqual(["running", "running"]);
  });

  it("S7 validation: a slot name outside lowercase letters, digits, and hyphens is refused", () => {
    expect(() => f.createGraph({ title: "坏名额", steps: [{ key: "a", title: "甲", brief: "甲", slot: "Real Env!" }] })).toThrow(/名额/);
  });

  it("slotHolderOf and admitStep report the holder and the queue position", () => {
    const first = realReview("图甲");
    const second = realReview("图乙");
    expect(slotHolderOf(f.db, "real-env")).toMatchObject({ graphId: first.id, nodeKey: "review-real" });
    expect(admitStep(f.db, second.id, "review-real")).toMatchObject({ kind: "queued", slot: "real-env", position: 1 });
    expect(admitStep(f.db, second.id, "review")).toEqual({ kind: "admitted" });
  });
});

import { describe, expect, it } from "vitest";
import { progressFrames } from "../../../test/fixtures/progress/load.ts";
import { codexChecklistFromPlanUpdated, codexItemStartedAt } from "./checklist.ts";
import { parseCodexToolStarted } from "./protocol.ts";

type Frame = { method: string; params: { item?: Record<string, unknown> } };
const plans = (name: string) => progressFrames<Frame>(name)
  .filter(({ method }) => method === "turn/plan/updated")
  .map(({ params }) => codexChecklistFromPlanUpdated(params));

describe("Codex checklist", () => {
  it("replays the three plan changes and produces no checklist for the default capture", () => {
    expect(plans("codex-plan.live.jsonl").map((plan) => plan?.kind === "replace" ? plan.items.map((i) => i.status) : null))
      .toEqual([["in_progress", "pending", "pending"], ["completed", "in_progress", "pending"], ["completed", "completed", "completed"]]);
    expect(plans("codex-default.live.jsonl")).toEqual([]);
    expect(codexChecklistFromPlanUpdated({})).toBeNull();
  });

  it("passes through item.startedAtMs and leaves missing or invalid time unset", () => {
    const frame = progressFrames<Frame>("codex-plan.live.jsonl").find(({ method }) => method === "item/started");
    const startedAtMs = codexItemStartedAt(frame?.params.item);
    expect(startedAtMs).toBe(1795596095584);
    const item = { id: "command", type: "commandExecution", command: "pwd" };
    expect(parseCodexToolStarted({ ...item, startedAtMs }, 123)).toMatchObject({ startedAt: startedAtMs });
    expect(parseCodexToolStarted({ ...item, startedAtMs: Infinity }, 123)).not.toHaveProperty("startedAt");
    expect(parseCodexToolStarted(item, 123)).not.toHaveProperty("startedAt");
  });
});

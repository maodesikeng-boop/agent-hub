import { afterEach, beforeEach, expect, it } from "vitest";
import { bundledModelCatalog } from "../../shared/vendors.ts";
import { workerOpsFixture } from "./test-helpers.ts";

const agent = { vendor: "agy", model: "gemini-4-neon", effort: "xhigh" } as const;
const catalog = {
  ...bundledModelCatalog("agy"),
  source: "vendor" as const,
  models: [
    { id: agent.model, label: "Gemini 4 Neon", description: null, efforts: ["low", "medium", "high"] },
    { id: "plain-model", label: "Plain", description: null, efforts: [] },
  ],
};
const options = /gemini-4-neon.*xhigh.*low、medium、high/;
let f: ReturnType<typeof workerOpsFixture>;
beforeEach(() => {
  f = workerOpsFixture({ models: { current: (vendor) => vendor === "agy" ? catalog : null, availability: () => "available" } });
});
afterEach(async () => { await f.close(); });

it("rejects an unsupported pair before starting a Worker", () => {
  expect(() => f.hub("worker.start", { ...agent, title: "Worker", task: "Inspect", noWorktree: true })).toThrow(options);
  expect(f.hub("worker.list", {}).data.workers).toEqual([]);
});

it("rejects an unsupported pair when creating a Task Graph step", () => {
  expect(() => f.hub("graph.create", {
    specJson: JSON.stringify({ title: "Example", nodes: [{ key: "a", title: "A", ...agent }] }),
  })).toThrow(options);
});

it("rejects an unsupported pair in PM defaults", () => {
  expect(() => f.ledger.editPersona(f.pm.pm.id, agent, { kind: "user" })).toThrow(options);
  f.ledger.editPersona(f.pm.pm.id, { ...agent, effort: "high" }, { kind: "user" });
  expect(() => f.ledger.editPersona(f.pm.pm.id, { effort: "xhigh" }, { kind: "user" })).toThrow(options);
});

it("checks the effective model and effort after inheriting PM defaults", () => {
  const { sessionId } = f.ledger.createPm({
    name: "Agy PM", mode: "manage_only", vendor: "agy", persona: "", defaultModel: "unlisted-model", effort: "xhigh",
  });
  f.ledger.hubCall(sessionId, "project.create", { folder: f.folder });
  expect(() => f.ledger.hubCall(sessionId, "worker.start", {
    title: "Worker", task: "Inspect", noWorktree: true, model: agent.model,
  })).toThrow(options);
});

function startFromPmWithEffort(effort: string) {
  const { sessionId } = f.ledger.createPm({
    name: "Agy PM", mode: "manage_only", vendor: "agy", persona: "", defaultModel: "unlisted-model", effort,
  });
  f.ledger.hubCall(sessionId, "project.create", { folder: f.folder });
  return (setting: { model?: string; effort?: string | null }) => {
    const { worker } = f.ledger.hubCall(sessionId, "worker.start", {
      title: "Worker", task: "Inspect", noWorktree: true, ...setting,
    }).data;
    return f.db.get("SELECT model, effort FROM agent_sessions WHERE id = ?", f.sessionOf(worker.id));
  };
}

it("does not inherit the PM effort for a model that has no effort levels", () => {
  const start = startFromPmWithEffort("high");
  expect(start({ model: "plain-model" })).toEqual({ model: "plain-model", effort: null });
  expect(start({ model: agent.model })).toEqual({ model: agent.model, effort: "high" });
  expect(() => start({ model: "plain-model", effort: "high" })).toThrow(/plain-model.*high/);
});

it("uses the vendor's default effort when a start explicitly clears the PM effort", () => {
  const start = startFromPmWithEffort("xhigh");
  expect(start({ model: agent.model, effort: null })).toEqual({ model: agent.model, effort: null });
  expect(start({ effort: null })).toEqual({ model: "unlisted-model", effort: null });
});

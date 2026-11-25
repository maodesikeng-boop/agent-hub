import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundledModelCatalog, modelShortLabel } from "../../../shared/vendors.ts";
import { workerOpsFixture } from "../test-helpers.ts";
import { formatStepAgentConfig } from "./step-agent-label.ts";

const context = { pmVendor: "claude", modelCatalog: bundledModelCatalog, modelShortLabel };

describe("graph step agent placeholders", () => {
  it("includes configured labels, marks PM inheritance, and omits slim snapshot rows", () => {
    expect(formatStepAgentConfig({ vendor: "codex", model: "gpt-5.4", effort: "high" }, context)).toMatch(/厂商 Codex.*模型 .*5\.4.*思考程度 High/);
    expect(formatStepAgentConfig({ vendor: null, model: null, effort: null }, context)).toMatch(/Claude Code（跟项目经理） · 模型 .+ · 思考程度 默认/);
    expect(formatStepAgentConfig({}, context)).toBeNull();
  });
});

describe("hub graph inventory", () => {
  let f: ReturnType<typeof workerOpsFixture>;
  beforeEach(() => { f = workerOpsFixture(); });
  afterEach(() => f.close());

  it("shows vendor, model, and effort in create and show and reflects patch updates immediately", () => {
    const created = f.hub("graph.create", { specJson: JSON.stringify({ title: "Inventory", nodes: [
      { key: "first", title: "Inherited" },
      { key: "later", title: "Configured", vendor: "codex", model: "gpt-5.4", effort: "high", deps: ["first"] },
    ] }) });
    const graphId = created.data.graph.id;
    const codex = /厂商 Codex.*模型 .*5\.4.*思考程度 High/;
    expect(created.text).toMatch(codex);
    const show = () => f.hub("graph.show", { graphId }).text;
    expect(show()).toMatch(codex);
    expect(show()).toContain("Claude Code（跟项目经理）");
    const patched = f.hub("graph.patch", { graphId, specJson: JSON.stringify({ updateNodes: [
      { key: "later", vendor: "claude", model: "claude-haiku-5-5", effort: "low" },
    ] }) });
    for (const text of [patched.text, show(), f.hub("graph.list", {}).text]) {
      expect(text).not.toMatch(codex);
      expect(text).toMatch(/厂商 Claude Code · 模型 Haiku 5\.5 · 思考程度 Low/);
    }
  });
});

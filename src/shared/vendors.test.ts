import { describe, expect, it } from "vitest";
import {
  AGENT_VENDORS,
  CUSTOM_MODEL,
  DEFAULT_AGENT_VENDOR,
  VENDOR_SPECS,
  agentLaunchArgs,
  checkAgentSetting,
  checkEffort,
  checkModel,
  isAgentVendor,
  bundledModelCatalog,
  effortsFor,
  modelChoiceOf,
  modelLabel,
  type ModelCatalog,
} from "./vendors.ts";
import { MAX_MODEL_CHARS } from "./limits.ts";

describe("厂商清单", () => {
  it("现在只有 Claude Code：模型别名 fable / opus / sonnet / haiku 可以自定义，思考程度 low～max", () => {
    expect(AGENT_VENDORS).toEqual(["claude"]);
    expect(DEFAULT_AGENT_VENDOR).toBe("claude");
    const claude = VENDOR_SPECS.claude;
    expect(claude.label).toBe("Claude Code");
    expect(claude.models.map((m) => [m.id, m.label])).toEqual([
      ["fable", "Fable"],
      ["opus", "Opus"],
      ["sonnet", "Sonnet"],
      ["haiku", "Haiku"],
    ]);
    expect(claude.customModel).toBe(true);
    expect(claude.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("isAgentVendor 只认清单里的", () => {
    expect(isAgentVendor("claude")).toBe(true);
    for (const v of ["codex", "", "Claude", null, 1]) expect(isAgentVendor(v)).toBe(false);
  });
});

describe("取值校验", () => {
  it("模型：null（默认）、别名、合规的完整模型名都行", () => {
    for (const m of [null, "haiku", "opus", "claude-opus-5-5", "claude-sonnet-5-5[1m]", "us.anthropic.claude-haiku-5-5:0", "a".repeat(MAX_MODEL_CHARS)]) {
      expect(checkModel("claude", m)).toBeNull();
    }
  });

  it("模型：超长、空白、横线开头、带空格或别的字符都不行", () => {
    for (const m of ["a".repeat(MAX_MODEL_CHARS + 1), "", " ", "-p", "--model", "claude opus", "opus;rm", "模型", "a\nb", "$(x)"]) {
      expect(checkModel("claude", m)).toMatch(/模型/);
    }
  });

  it("思考程度：null（默认）和清单里的五档行，别的不行", () => {
    for (const e of [null, "low", "medium", "high", "xhigh", "max"]) expect(checkEffort("claude", e)).toBeNull();
    for (const e of ["", "LOW", "min", "ultra", " high"]) expect(checkEffort("claude", e)).toBe("思考程度只能是 low、medium、high、xhigh、max");
  });

  it("checkAgentSetting：厂商不对、模型不对、思考程度不对各报各的", () => {
    expect(checkAgentSetting({ vendor: "claude", model: "haiku", effort: "low" })).toBeNull();
    expect(checkAgentSetting({ vendor: "codex", model: null, effort: null })).toBe("厂商只能是 claude");
    expect(checkAgentSetting({ vendor: "claude", model: "a b", effort: null })).toMatch(/模型/);
    expect(checkAgentSetting({ vendor: "claude", model: null, effort: "huge" })).toMatch(/思考程度/);
  });
});

describe("命令行参数", () => {
  it("默认 = 不传对应参数", () => {
    expect(agentLaunchArgs({ vendor: "claude", model: null, effort: null })).toEqual([]);
  });

  it("模型、思考程度各自对应 --model、--effort", () => {
    expect(agentLaunchArgs({ vendor: "claude", model: "haiku", effort: null })).toEqual(["--model", "haiku"]);
    expect(agentLaunchArgs({ vendor: "claude", model: null, effort: "low" })).toEqual(["--effort", "low"]);
    expect(agentLaunchArgs({ vendor: "claude", model: "claude-opus-5-5", effort: "max" })).toEqual(["--model", "claude-opus-5-5", "--effort", "max"]);
  });
});

describe("界面上的叫法", () => {
  it("modelChoiceOf：默认是空串，别的是模型名本身；“自定义”的值以横线开头，不会和模型名撞", () => {
    expect(modelChoiceOf(null)).toBe("");
    expect(modelChoiceOf("sonnet")).toBe("sonnet");
    expect(modelChoiceOf("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(checkModel("claude", CUSTOM_MODEL)).not.toBeNull();
  });

  it("modelLabel：默认、别名的名字、完整模型名原样", () => {
    expect(modelLabel("claude", null)).toBe("默认");
    expect(modelLabel("claude", "haiku")).toBe("Haiku");
    expect(modelLabel("claude", "claude-haiku-5-5")).toBe("claude-haiku-5-5");
  });

  it("modelLabel 给了名单：用名单里的名字", () => {
    expect(modelLabel("claude", "claude-opus-4-6", catalog)).toBe("Opus 4.6");
    expect(modelLabel("claude", "haiku", catalog)).toBe("haiku");
  });
});

const catalog: ModelCatalog = {
  vendor: "claude",
  source: "vendor",
  models: [
    { id: "opus", label: "Opus 5.5", description: null, efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-opus-4-6", label: "Opus 4.6", description: null, efforts: ["low", "high", "max", "ultra"] },
    { id: "claude-haiku-4-5", label: "Haiku 4.5", description: null, efforts: null },
    { id: "old", label: "Old", description: null, efforts: [] },
  ],
  defaultEfforts: ["low", "high"],
};

describe("模型名单", () => {
  it("打包的名单：VENDOR_SPECS 里的模型，来源 bundled，都没写思考程度", () => {
    expect(bundledModelCatalog("claude")).toEqual({
      vendor: "claude",
      source: "bundled",
      defaultEfforts: null,
      models: VENDOR_SPECS.claude.models.map((m) => ({ id: m.id, label: m.label, description: null, efforts: null })),
    });
  });

  it("effortsFor：名单里写了按它（只留通用档位里有的），没写或不在名单里用通用档位；默认看 defaultEfforts", () => {
    expect(effortsFor(catalog, "claude-opus-4-6")).toEqual(["low", "high", "max"]);
    expect(effortsFor(catalog, "claude-haiku-4-5")).toEqual(VENDOR_SPECS.claude.efforts);
    expect(effortsFor(catalog, "old")).toEqual([]);
    expect(effortsFor(catalog, "not-listed")).toEqual(VENDOR_SPECS.claude.efforts);
    expect(effortsFor(catalog, null)).toEqual(["low", "high"]);
    expect(effortsFor(bundledModelCatalog("claude"), null)).toEqual(VENDOR_SPECS.claude.efforts);
  });
});

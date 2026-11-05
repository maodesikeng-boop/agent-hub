import { describe, expect, it } from "vitest";
import {
  AGENT_VENDORS,
  CUSTOM_MODEL,
  DEFAULT_AGENT_VENDOR,
  VENDOR_FAILURE_SIGNS,
  VENDOR_SPECS,
  agentLaunchArgs,
  checkAgentSetting,
  checkEffort,
  checkModel,
  isAgentVendor,
  bundledModelCatalog,
  defaultModelOption,
  effortsFor,
  modelChoiceOf,
  modelLabel,
  modelShortLabel,
  vendorFailureOf,
  type ModelCatalog,
} from "./vendors.ts";
import { MAX_MODEL_CHARS } from "./limits.ts";

describe("厂商清单", () => {
  it("支持 claude、agy、codex 三家厂商，默认 claude", () => {
    expect(AGENT_VENDORS).toEqual(["claude", "agy", "codex"]);
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

    const agy = VENDOR_SPECS.agy;
    expect(agy.label).toBe("Antigravity");
    expect(agy.models).toEqual([
      { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
      { id: "gemini-4-argon-max", label: "Gemini 4 Argon (Max)" },
      { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
    ]);
    expect(agy.customModel).toBe(true);
    expect(agy.customModelExample).toBe("如 gemini-4-argon-medium");
    expect(agy.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(agy.modelFlag).toBe("--model");
    expect(agy.effortFlag).toBe("--effort");
    expect(agy.quotaWindows).toEqual({ five_hour: "5 小时", seven_day: "7 天" });
    expect(agy.composer.compactCommand).toBe("compact");
    for (const cmd of ["clear", "resume", "logout", "login", "model", "effort", "mode", "update", "doctor", "color", "focus"]) {
      expect(agy.composer.blockedCommands[cmd], cmd).toBeTruthy();
    }

    const codex = VENDOR_SPECS.codex;
    expect(codex.label).toBe("Codex");
    expect(codex.models).toEqual([
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    ]);
    expect(codex.customModel).toBe(true);
    expect(codex.customModelExample).toBe("如 gpt-5.4");
    expect(codex.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(codex.modelFlag).toBe("--model");
    expect(codex.effortFlag).toBe("-c");
    expect(codex.quotaWindows).toEqual({ five_hour: "5 小时", seven_day: "7 天" });
    expect(codex.composer.compactCommand).toBe("compact");
    for (const cmd of ["clear", "new", "resume", "fork", "login", "logout", "model", "approvals", "permissions", "sandbox", "quit", "exit"]) {
      expect(codex.composer.blockedCommands[cmd], cmd).toBeTruthy();
    }
  });

  it("isAgentVendor 只认清单里的", () => {
    expect(isAgentVendor("claude")).toBe(true);
    expect(isAgentVendor("agy")).toBe(true);
    expect(isAgentVendor("codex")).toBe(true);
    for (const v of ["gemini", "", "Claude", null, 1]) expect(isAgentVendor(v)).toBe(false);
  });
});

describe("取值校验", () => {
  it("模型：null（默认）、别名、合规的完整模型名都行", () => {
    for (const m of [null, "haiku", "opus", "claude-opus-5-5", "claude-sonnet-5-5[1m]", "us.anthropic.claude-haiku-5-5:0", "a".repeat(MAX_MODEL_CHARS)]) {
      expect(checkModel("claude", m)).toBeNull();
    }
    expect(checkModel("agy", "gemini-4-argon-medium")).toBeNull();
    expect(checkModel("codex", "gpt-5.4")).toBeNull();
  });

  it("模型：超长、空白、横线开头、带空格或别的字符都不行", () => {
    for (const m of ["a".repeat(MAX_MODEL_CHARS + 1), "", " ", "-p", "--model", "claude opus", "opus;rm", "模型", "a\nb", "$(x)"]) {
      expect(checkModel("claude", m)).toMatch(/模型/);
      expect(checkModel("agy", m)).toMatch(/模型/);
      expect(checkModel("codex", m)).toMatch(/模型/);
    }
  });

  it("思考程度：null（默认）和各厂商清单里的档位行，别的不行", () => {
    for (const e of [null, "low", "medium", "high", "xhigh", "max"]) {
      expect(checkEffort("claude", e)).toBeNull();
      expect(checkEffort("agy", e)).toBeNull();
    }
    for (const e of ["", "LOW", "min", "ultra", " high"]) {
      expect(checkEffort("claude", e)).toBe("思考程度只能是 low、medium、high、xhigh、max");
      expect(checkEffort("agy", e)).toBe("思考程度只能是 low、medium、high、xhigh、max");
    }
    for (const e of [null, "low", "medium", "high", "xhigh"]) {
      expect(checkEffort("codex", e)).toBeNull();
    }
    expect(checkEffort("codex", "max")).toBe("思考程度只能是 low、medium、high、xhigh");
  });

  it("checkAgentSetting：厂商不对、模型不对、思考程度不对各报各的", () => {
    expect(checkAgentSetting({ vendor: "claude", model: "haiku", effort: "low" })).toBeNull();
    expect(checkAgentSetting({ vendor: "agy", model: "gemini-4-argon-medium", effort: "max" })).toBeNull();
    expect(checkAgentSetting({ vendor: "codex", model: "gpt-5.4", effort: "xhigh" })).toBeNull();
    expect(checkAgentSetting({ vendor: "codex", model: "gpt-5.4", effort: "max" })).toBe("思考程度只能是 low、medium、high、xhigh");
    expect(checkAgentSetting({ vendor: "unknown", model: null, effort: null })).toBe("厂商只能是 claude、agy、codex");
    expect(checkAgentSetting({ vendor: "claude", model: "a b", effort: null })).toMatch(/模型/);
    expect(checkAgentSetting({ vendor: "claude", model: null, effort: "huge" })).toMatch(/思考程度/);
  });
});

describe("命令行参数", () => {
  it("默认 = 不传对应参数", () => {
    expect(agentLaunchArgs({ vendor: "claude", model: null, effort: null })).toEqual([]);
    expect(agentLaunchArgs({ vendor: "agy", model: null, effort: null })).toEqual([]);
    expect(agentLaunchArgs({ vendor: "codex", model: null, effort: null })).toEqual([]);
  });

  it("模型、思考程度各自对应厂商的 modelFlag、effortFlag", () => {
    expect(agentLaunchArgs({ vendor: "claude", model: "haiku", effort: null })).toEqual(["--model", "haiku"]);
    expect(agentLaunchArgs({ vendor: "claude", model: null, effort: "low" })).toEqual(["--effort", "low"]);
    expect(agentLaunchArgs({ vendor: "claude", model: "claude-opus-5-5", effort: "max" })).toEqual(["--model", "claude-opus-5-5", "--effort", "max"]);
    expect(agentLaunchArgs({ vendor: "agy", model: "gemini-4-argon-medium", effort: "high" })).toEqual(["--model", "gemini-4-argon-medium", "--effort", "high"]);
    expect(agentLaunchArgs({ vendor: "codex", model: "gpt-5.4", effort: "high" })).toEqual(["--model", "gpt-5.4", "-c", "high"]);
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
    expect(modelLabel("agy", "gemini-4-argon-medium")).toBe("Gemini 4 Argon (Medium)");
    expect(modelLabel("codex", "gpt-5.4-mini")).toBe("GPT-5.4 Mini");
  });

  it("modelLabel 给了名单：用名单里的名字", () => {
    expect(modelLabel("claude", "claude-opus-4-6", catalog)).toBe("Opus 4.6");
    expect(modelLabel("claude", "haiku", catalog)).toBe("haiku");
  });
});

const catalog: ModelCatalog = {
  ...bundledModelCatalog("claude"),
  source: "vendor",
  models: [
    { id: "opus", label: "Opus 5.5", description: null, efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-opus-4-6", label: "Opus 4.6", description: null, efforts: ["low", "high", "max", "ultra"] },
    { id: "claude-haiku-4-5", label: "Haiku 4.5", description: null, efforts: null },
    { id: "old", label: "Old", description: null, efforts: [] },
  ],
  defaultEfforts: ["low", "high"],
  defaultModel: "Opus 5.5",
};

describe("模型名单", () => {
  it("打包的名单：VENDOR_SPECS 里的模型，来源 bundled，都没写思考程度", () => {
    expect(bundledModelCatalog("claude")).toEqual({
      vendor: "claude",
      label: VENDOR_SPECS.claude.label,
      source: "bundled",
      defaultEfforts: null,
      defaultModel: null,
      efforts: VENDOR_SPECS.claude.efforts,
      customModelExample: VENDOR_SPECS.claude.customModelExample,
      models: VENDOR_SPECS.claude.models.map((m) => ({ id: m.id, label: m.label, description: null, efforts: null })),
    });
  });

  it("defaultModelOption：知道默认是哪个模型就写出来，不知道只写“默认”", () => {
    expect(defaultModelOption(catalog)).toBe("Opus 5.5（默认）");
    expect(defaultModelOption(bundledModelCatalog("claude"))).toBe("默认");
  });

  it("effortsFor 按名单自己的通用档位（换一家厂商的名单，档位跟着变）", () => {
    const other: ModelCatalog = { ...catalog, efforts: ["low", "high"], models: [], defaultEfforts: null };
    expect(effortsFor(other, null)).toEqual(["low", "high"]);
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

describe("modelShortLabel 与 shortModelName", () => {
  it("claude：名单里有的用名单的名字；完整的 claude 模型名缩成“家族 版本”；认不出来的原样", () => {
    expect(modelShortLabel("claude", null)).toBe("默认");
    expect(modelShortLabel("claude", "sonnet")).toBe("Sonnet");
    expect(modelShortLabel("claude", "claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelShortLabel("claude", "claude-opus-4-1-20250805")).toBe("Opus 4.1");
    expect(modelShortLabel("claude", "claude-sonnet-5-5[1m]")).toBe("Sonnet 5.5 1M");
    expect(modelShortLabel("claude", "claude-haiku-5")).toBe("Haiku 5");
    expect(modelShortLabel("claude", "us.anthropic.claude-haiku-5-5:0")).toBe("us.anthropic.claude-haiku-5-5:0");
    expect(modelShortLabel("claude", null, { ...bundledModelCatalog("claude"), defaultModel: "Opus 5.5" })).toBe("Opus 5.5");
  });

  it("agy 與 codex 的 shortModelName", () => {
    expect(VENDOR_SPECS.agy.shortModelName?.("gemini-4-argon-medium")).toBe("Argon Medium");
    expect(VENDOR_SPECS.agy.shortModelName?.("gemini-4-argon-max")).toBe("Argon Max");
    expect(VENDOR_SPECS.agy.shortModelName?.("claude-opus-4-6-thinking")).toBe("Opus 4.6");
    expect(VENDOR_SPECS.agy.shortModelName?.("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(VENDOR_SPECS.agy.shortModelName?.("gpt-oss-120b-medium")).toBe("GPT-OSS 120B");
    expect(VENDOR_SPECS.agy.shortModelName?.("custom-unknown-model")).toBeNull();

    expect(VENDOR_SPECS.codex.shortModelName?.("gpt-5.4")).toBe("GPT-5.4");
    expect(VENDOR_SPECS.codex.shortModelName?.("gpt-5.4-mini")).toBe("GPT-5.4 Mini");
    expect(VENDOR_SPECS.codex.shortModelName?.("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
    expect(VENDOR_SPECS.codex.shortModelName?.("custom-unknown-model")).toBeNull();
  });
});

describe("VENDOR_FAILURE_SIGNS：错误特征匹配", () => {
  it("agy 和 codex 具备鉴权失败、额度耗尽、上下文超长匹配正则", () => {
    for (const vendor of ["agy", "codex"] as const) {
      const signs = VENDOR_FAILURE_SIGNS[vendor];
      for (const sample of ["not logged in", "UNAUTHENTICATED", "Please sign in", "HTTP 401", "invalid_api_key"]) {
        expect(signs.auth.test(sample), `${vendor} auth: ${sample}`).toBe(true);
      }
      for (const sample of ["quota exceeded", "rate_limit", "usage_limit_reached", "RESOURCE_EXHAUSTED"]) {
        expect(signs.quota.test(sample), `${vendor} quota: ${sample}`).toBe(true);
      }
      for (const sample of ["context_length_exceeded", "exceeds the context window", "prompt is too long"]) {
        expect(signs.context.test(sample), `${vendor} context: ${sample}`).toBe(true);
      }
    }
    expect(vendorFailureOf("agy_not_found: spawn agy ENOENT")).toEqual({ kind: "start", serviceName: "Antigravity" });
    expect(vendorFailureOf("codex_not_found: spawn codex ENOENT")).toEqual({ kind: "start", serviceName: "Codex" });
  });
});

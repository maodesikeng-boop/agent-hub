// Antigravity 的思考程度写在模型 ID 末尾（gemini-4-argon-high）：界面按软件的做法拆成“模型 + 思考程度”，启动时再拼回去。
// 实测依据见 docs/model-catalog.md「agy 的模型和思考程度」。
import { describe, expect, it } from "vitest";
import {
  vendorSpec,
  agentLaunchArgs,
  bundledModelCatalog,
  checkAgentSetting,
  checkModelEffort,
  effortsFor,
  modelLabel,
  agentEffortOf,
  modelShortLabel,
  splitModelEffort,
} from "./vendors.ts";

describe("splitModelEffort：完整 ID 拆成 模型 + 思考程度", () => {
  it("带档位的 ID 拆开，档位用厂商清单里的（low、medium、high）", () => {
    expect(splitModelEffort("agy", "gemini-4-argon-high", null)).toEqual({ model: "gemini-4-argon", effort: "high" });
    expect(splitModelEffort("agy", "gemini-3.8-flash-low", null)).toEqual({ model: "gemini-3.8-flash", effort: "low" });
    expect(splitModelEffort("agy", "claude-opus-5-5-medium", null)).toEqual({ model: "claude-opus-5-5", effort: "medium" });
    expect(splitModelEffort("agy", "gpt-oss-120b-medium", null)).toEqual({ model: "gpt-oss-120b", effort: "medium" });
  });

  it("ID 里的档位优先于另存的思考程度（和启动时 agy 认的一致）", () => {
    expect(splitModelEffort("agy", "gemini-4-argon-low", "high")).toEqual({ model: "gemini-4-argon", effort: "low" });
  });

  it("不带档位的、默认（null）、别家厂商、末尾不是档位词的：原样", () => {
    expect(splitModelEffort("agy", "gemini-4-argon", "high")).toEqual({ model: "gemini-4-argon", effort: "high" });
    expect(splitModelEffort("agy", null, "high")).toEqual({ model: null, effort: "high" });
    expect(splitModelEffort("agy", "some-new-model-thinking", null)).toEqual({ model: "some-new-model-thinking", effort: null });
    expect(splitModelEffort("claude", "claude-opus-4-low", null)).toEqual({ model: "claude-opus-4-low", effort: null });
    expect(splitModelEffort("codex", "gpt-5.4-high", null)).toEqual({ model: "gpt-5.4-high", effort: null });
  });
});

describe("agy 的启动参数：拼回完整 ID，不同时传 --effort", () => {
  it("不带档位的模型 + 思考程度 → 拼成完整 ID 一个 --model", () => {
    expect(agentLaunchArgs({ vendor: "agy", model: "gemini-4-argon", effort: "high" })).toEqual(["--model", "gemini-4-argon-high"]);
    expect(agentLaunchArgs({ vendor: "agy", model: "claude-sonnet-5-5", effort: "low" })).toEqual(["--model", "claude-sonnet-5-5-low"]);
    expect(agentLaunchArgs({ vendor: "agy", model: "gpt-oss-120b", effort: "medium" })).toEqual(["--model", "gpt-oss-120b-medium"]);
  });

  it("只选了模型（思考程度默认）→ 只传不带档位的模型名，agy 自己挑档位", () => {
    expect(agentLaunchArgs({ vendor: "agy", model: "gemini-4-argon", effort: null })).toEqual(["--model", "gemini-4-argon"]);
  });

  it("老数据：存的就是完整 ID → 原样传；ID 和另存的思考程度对不上时 ID 说了算（agy 对两个都传且对不上会报错）", () => {
    expect(agentLaunchArgs({ vendor: "agy", model: "gemini-4-argon-high", effort: null })).toEqual(["--model", "gemini-4-argon-high"]);
    expect(agentLaunchArgs({ vendor: "agy", model: "gemini-4-argon-high", effort: "high" })).toEqual(["--model", "gemini-4-argon-high"]);
    expect(agentLaunchArgs({ vendor: "agy", model: "gemini-4-argon-low", effort: "high" })).toEqual(["--model", "gemini-4-argon-low"]);
  });

  it("只有思考程度（模型默认）→ 只传 --effort；都默认 → 什么都不传", () => {
    expect(agentLaunchArgs({ vendor: "agy", model: null, effort: "high" })).toEqual(["--effort", "high"]);
    expect(agentLaunchArgs({ vendor: "agy", model: null, effort: null })).toEqual([]);
  });

  it("claude、codex 不变：模型、思考程度各传各的", () => {
    expect(agentLaunchArgs({ vendor: "claude", model: "opus", effort: "max" })).toEqual(["--model", "opus", "--effort", "max"]);
    expect(agentLaunchArgs({ vendor: "codex", model: "gpt-5.4", effort: "high" })).toEqual(["--model", "gpt-5.4", "-c", "high"]);
  });
});

describe("agy 的取值校验", () => {
  it("思考程度只有 low、medium、high（实测 xhigh、max 被 agy 拒绝）", () => {
    expect(vendorSpec("agy").models.efforts).toEqual(["low", "medium", "high"]);
    expect(checkAgentSetting({ vendor: "agy", model: "gemini-4-argon", effort: "high" })).toBeNull();
    expect(checkAgentSetting({ vendor: "agy", model: "gemini-4-argon", effort: "xhigh" })).toBe("思考程度只能是 low、medium、high");
  });

  it("完整 ID 加同一档的 --effort、完整 ID 单独用都行；档位对不上的报错，说清楚怎么改", () => {
    expect(checkAgentSetting({ vendor: "agy", model: "gemini-4-argon-high", effort: null })).toBeNull();
    expect(checkAgentSetting({ vendor: "agy", model: "gemini-4-argon-high", effort: "high" })).toBeNull();
    expect(checkModelEffort("agy", "gemini-4-argon-low", "high")).toMatch(/gemini-4-argon-low.*low.*high/);
    expect(checkAgentSetting({ vendor: "agy", model: "gemini-4-argon-low", effort: "high" })).toMatch(/gemini-4-argon-low/);
    expect(checkModelEffort("claude", "opus", "high")).toBeNull();
  });
});

describe("打包的名单：照 agy models 的实际内容，模型不带档位", () => {
  const catalog = bundledModelCatalog("agy");

  it("五个模型，档位各自列出", () => {
    expect(catalog.models.map((m) => [m.id, m.label, m.efforts])).toEqual([
      ["gemini-4-argon", "Gemini 4 Argon", ["low", "medium", "high"]],
      ["gemini-3.8-flash", "Gemini 3.8 Flash", ["low", "medium", "high"]],
      ["claude-opus-5-5", "Claude Opus 5.5", ["low", "medium", "high"]],
      ["claude-sonnet-5-5", "Claude Sonnet 5.5", ["low", "medium", "high"]],
      ["gpt-oss-120b", "GPT-OSS 120B", ["medium"]],
    ]);
  });

  it("effortsFor：GPT-OSS 只有 Medium 一档；默认模型用通用的三档", () => {
    expect(effortsFor(catalog, "gpt-oss-120b")).toEqual(["medium"]);
    expect(effortsFor(catalog, "gemini-4-argon")).toEqual(["low", "medium", "high"]);
    expect(effortsFor(catalog, null)).toEqual(["low", "medium", "high"]);
  });
});

describe("老数据和右栏的显示：模型 + 档位", () => {
  const catalog = bundledModelCatalog("agy");

  it("modelLabel：用名单的名字；老数据的完整 ID 只显示模型的名字，档位另外显示，不拼在一起", () => {
    expect(modelLabel("agy", "gemini-4-argon", catalog)).toBe("Gemini 4 Argon");
    expect(modelLabel("agy", "gemini-4-argon-high", catalog)).toBe("Gemini 4 Argon");
    expect(modelLabel("agy", "gpt-oss-120b-medium", catalog)).toBe("GPT-OSS 120B");
    expect(modelLabel("agy", "unknown-thing", catalog)).toBe("unknown-thing");
  });

  it("modelShortLabel（右栏）：名单里有的用名单的名字，名单里没有的按规则缩短，档位另外显示", () => {
    expect(modelShortLabel("agy", "gemini-4-argon", catalog)).toBe("Gemini 4 Argon");
    expect(modelShortLabel("agy", "claude-opus-5-5", { ...catalog, models: [] })).toBe("Claude Opus 5.5");
    expect(modelShortLabel("agy", "gemini-3.8-flash", { ...catalog, models: [] })).toBe("Gemini 3.8 Flash");
    expect(modelShortLabel("agy", "gpt-oss-120b", { ...catalog, models: [] })).toBe("GPT-OSS 120B");
  });

  it("老数据（完整 ID）：右栏模型名只显示模型，档位从 ID 里取，另外显示", () => {
    expect(modelShortLabel("agy", "gemini-4-argon-high", catalog)).toBe("Gemini 4 Argon");
    expect(agentEffortOf("agy", "gemini-4-argon-high", null)).toBe("high");
    expect(agentEffortOf("agy", "gemini-4-argon", "low")).toBe("low");
    expect(agentEffortOf("agy", null, null)).toBeNull();
    expect(agentEffortOf("claude", "opus", "max")).toBe("max");
  });
});

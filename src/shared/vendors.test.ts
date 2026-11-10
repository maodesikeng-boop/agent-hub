import { describe, expect, it } from "vitest";
import {
  AGENT_VENDORS,
  AVAILABILITY_LABELS,
  VENDOR_AVAILABILITIES,
  isListed,
  isSelectable,
  notFoundCode,
  CUSTOM_MODEL,
  DEFAULT_AGENT_VENDOR,
  VENDOR_FAILURE_SIGNS,
  agentLaunchArgs,
  checkAgentSetting,
  checkEffort,
  checkModel,
  handoverTokenThresholdOf,
  isAgentVendor,
  bundledModelCatalog,
  defaultModelOption,
  effortsFor,
  modelChoiceOf,
  modelLabel,
  modelShortLabel,
  vendorFailureOf,
  vendorSpec,
  type ModelCatalog,
} from "./vendors.ts";
import { AUTO_RENEW_CONTEXT_TOKENS, HANDOVER_TOKEN_THRESHOLD, MAX_MODEL_CHARS } from "./limits.ts";
import { VENDOR_LIST } from "../vendors/registry.ts";

describe("厂商清单", () => {
  it("与注册表 VENDOR_LIST 顺序一致，包含核心厂商，默认 claude", () => {
    expect(AGENT_VENDORS).toEqual(VENDOR_LIST.map((s) => s.id));
    expect(AGENT_VENDORS).toEqual(expect.arrayContaining(["claude", "agy", "codex", "deepseek"]));
    expect(DEFAULT_AGENT_VENDOR).toBe("claude");

    const claude = vendorSpec("claude");
    expect(claude.label).toBe("Claude Code");
    expect(claude.models.bundled.map((m) => [m.id, m.label])).toEqual([
      ["fable", "Fable"],
      ["opus", "Opus"],
      ["sonnet", "Sonnet"],
      ["haiku", "Haiku"],
    ]);
    expect(claude.models.customModel).toBe(true);
    expect(claude.models.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(claude.capabilities.backgroundWake).toBe(true);
    expect(claude.cli.command).toBe("claude");
    expect(claude.cli.envVar).toBe("AGENT_HUB_CLAUDE");
    expect(claude.prompt.subagentTools).toEqual(["Agent", "Task"]);
    expect(claude.prompt.backgroundCommandTool).toBe("Bash 工具的 `run_in_background`");
    expect(claude.capabilities.readonly).toBe("settings");
    expect(claude.capabilities.explicitDefaultModel ?? false).toBe(false);
    expect(handoverTokenThresholdOf("claude")).toBe(HANDOVER_TOKEN_THRESHOLD);

    const agy = vendorSpec("agy");
    expect(agy.label).toBe("Antigravity");
    expect(agy.capabilities.backgroundWake).toBe(false);
    expect(agy.cli.command).toBe("agy");
    expect(agy.cli.envVar).toBe("AGENT_HUB_AGY");
    expect(agy.prompt.subagentTools).toEqual(["invoke_subagent"]);
    expect(agy.prompt.backgroundCommandTool).toBe("`run_command` 的 `WaitMsBeforeAsync`");
    expect(agy.capabilities.readonly).toBe("os_sandbox");
    expect(agy.capabilities.explicitDefaultModel ?? false).toBe(false);
    expect(handoverTokenThresholdOf("agy")).toBe(HANDOVER_TOKEN_THRESHOLD);
    // 模型不带档位，档位另外列（agy-effort.test.ts 里有更细的）
    expect(agy.models.bundled.map((m) => [m.id, m.label])).toEqual([
      ["gemini-4-argon", "Gemini 4 Argon"],
      ["gemini-3.8-flash", "Gemini 3.8 Flash"],
      ["claude-opus-5-5", "Claude Opus 5.5"],
      ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
      ["gpt-oss-120b", "GPT-OSS 120B"],
    ]);
    expect(agy.models.customModel).toBe(true);
    expect(agy.models.customModelExample).toBe("如 gemini-4-argon");
    expect(agy.models.efforts).toEqual(["low", "medium", "high"]);
    expect(agy.models.effortInModelId).toBe(true);
    expect(agy.models.flags.model).toBe("--model");
    expect(agy.models.flags.effort).toBe("--effort");
    expect(agy.quota?.fetched?.args).toEqual(["-p", "/usage"]);
    expect(agy.composer.compactCommand).toBe("compact");
    for (const cmd of ["clear", "resume", "logout", "login", "model", "effort", "mode", "update", "doctor", "color", "focus"]) {
      expect(agy.composer.blockedCommands[cmd], cmd).toBeTruthy();
    }

    const codex = vendorSpec("codex");
    expect(codex.label).toBe("Codex");
    expect(codex.capabilities.backgroundWake).toBe(false);
    expect(codex.cli.command).toBe("codex");
    expect(codex.cli.envVar).toBe("AGENT_HUB_CODEX");
    expect(codex.prompt.subagentTools).toEqual(["spawn_agent"]);
    expect(codex.prompt.backgroundCommandTool).toBe("后台命令参数");
    expect(codex.capabilities.readonly).toBe("driver");
    expect(codex.capabilities.explicitDefaultModel ?? false).toBe(true);
    expect(handoverTokenThresholdOf("codex")).toBe(HANDOVER_TOKEN_THRESHOLD);
    const fullEfforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
    const maxEfforts = ["low", "medium", "high", "xhigh", "max"];
    expect(codex.models.bundled).toEqual([
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: fullEfforts },
      { id: "gpt-6-astra", label: "GPT-6-Astra", efforts: fullEfforts },
      { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", efforts: fullEfforts },
      { id: "gpt-6-sol", label: "GPT-6-Sol", efforts: fullEfforts },
      { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: maxEfforts },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", efforts: fullEfforts },
      { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", efforts: fullEfforts },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", efforts: maxEfforts },
    ]);
    expect(codex.models.customModel).toBe(true);
    expect(codex.models.customModelExample).toBe("如 gpt-6.1-sol");
    expect(codex.models.efforts).toEqual(fullEfforts);
    expect(codex.models.flags.model).toBe("--model");
    expect(codex.models.flags.effort).toBe("-c");
    expect(codex.quota).toEqual({ name: "Codex", windows: ["five_hour", "seven_day", "thirty_day"] });
    expect(vendorSpec("claude").quota?.windows).toEqual(["five_hour", "seven_day"]);
    expect(codex.composer.compactCommand).toBe("compact");
    for (const cmd of ["clear", "new", "resume", "fork", "login", "logout", "model", "approvals", "permissions", "sandbox", "quit", "exit"]) {
      expect(codex.composer.blockedCommands[cmd], cmd).toBeTruthy();
    }
  });

  it("isAgentVendor 只认清单里的", () => {
    for (const v of AGENT_VENDORS) expect(isAgentVendor(v)).toBe(true);
    for (const v of ["gemini", "", "Claude", null, 1]) expect(isAgentVendor(v)).toBe(false);
  });

  it("handoverTokenThresholdOf 按声明表返回", () => {
    expect(HANDOVER_TOKEN_THRESHOLD).toBe(200_000);
    expect(AUTO_RENEW_CONTEXT_TOKENS).toBe(HANDOVER_TOKEN_THRESHOLD);
    for (const v of AGENT_VENDORS) expect(handoverTokenThresholdOf(v)).toBe(HANDOVER_TOKEN_THRESHOLD);
    expect(handoverTokenThresholdOf("unknown")).toBe(HANDOVER_TOKEN_THRESHOLD);

  });
});

describe("spec 的 home：厂商的凭据和配置目录", () => {
  it("每家都有，且只读禁读的文件与缓存指纹监听文件都在它自己的目录里", () => {
    expect(vendorSpec("claude").home.dirs).toEqual(expect.arrayContaining([".claude", ".claude.json"]));
    expect(vendorSpec("claude").home.readonlySecrets).toContain(".claude.json");
    expect(vendorSpec("codex").home.readonlySecrets).toContain(".codex/.credentials.json");
    expect(vendorSpec("codex").home.catalogWatchPaths).toContain(".codex/models_cache.json");
    expect(vendorSpec("agy").home.readonlySecrets).toContain(".gemini/mcp-oauth-tokens.json");
    expect(vendorSpec("codex").home.dirs).toContain(".codex");
    expect(vendorSpec("agy").home.dirs).toContain(".gemini");
    for (const vendor of AGENT_VENDORS) {
      const { dirs, readonlySecrets, catalogWatchPaths } = vendorSpec(vendor).home;
      expect(dirs.length, vendor).toBeGreaterThan(0);
      expect(catalogWatchPaths.length, vendor).toBeGreaterThan(0);
      for (const f of readonlySecrets) expect(dirs.some((d) => f === d || f.startsWith(`${d}/`)), `${vendor}:${f}`).toBe(true);
      for (const f of catalogWatchPaths) expect(dirs.some((d) => f === d || f.startsWith(`${d}/`)), `${vendor}:watch:${f}`).toBe(true);
    }
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

  it("思考程度：null（默认）、各厂商清单里的档位以及动态 ModelCatalog 报出的新档位行，别的不行", () => {
    for (const e of [null, "low", "medium", "high", "xhigh", "max"]) {
      expect(checkEffort("claude", e)).toBeNull();
    }
    for (const e of [null, "low", "medium", "high"]) expect(checkEffort("agy", e)).toBeNull();
    for (const e of ["", "LOW", "min", "ultra", " high"]) {
      expect(checkEffort("claude", e)).toBe("思考程度只能是 low、medium、high、xhigh、max");
      expect(checkEffort("agy", e)).toBe("思考程度只能是 low、medium、high");
    }
    for (const e of ["xhigh", "max"]) expect(checkEffort("agy", e)).toBe("思考程度只能是 low、medium、high");
    for (const e of [null, "low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(checkEffort("codex", e)).toBeNull();
    }
    expect(checkEffort("codex", "hyper")).toBe("思考程度只能是 low、medium、high、xhigh、max、ultra");
    // 若动态 ModelCatalog 返回了厂商新增的档位，不应被静态列表误拦
    expect(checkEffort("claude", "ultra", catalog)).toBeNull();
  });

  it("checkAgentSetting：厂商不对、模型不对、思考程度不对各报各的；支持传入动态 ModelCatalog", () => {
    expect(checkAgentSetting({ vendor: "claude", model: "haiku", effort: "low" })).toBeNull();
    expect(checkAgentSetting({ vendor: "agy", model: "gemini-4-argon", effort: "high" })).toBeNull();
    expect(checkAgentSetting({ vendor: "codex", model: "gpt-6.1-sol", effort: "ultra" })).toBeNull();
    expect(checkAgentSetting({ vendor: "codex", model: "gpt-6-luna", effort: "max" })).toBeNull();
    expect(checkAgentSetting({ vendor: "codex", model: "gpt-5.4", effort: "hyper" })).toBe("思考程度只能是 low、medium、high、xhigh、max、ultra");
    expect(checkAgentSetting({ vendor: "claude", model: "claude-opus-4-6", effort: "ultra" }, catalog)).toBeNull();
    expect(checkAgentSetting({ vendor: "unknown", model: null, effort: null })).toBe(`厂商只能是 ${AGENT_VENDORS.join("、")}`);
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
    // agy 把思考程度拼进模型 ID（agy-effort.test.ts）
    expect(agentLaunchArgs({ vendor: "agy", model: "gemini-4-argon", effort: "high" })).toEqual(["--model", "gemini-4-argon-high"]);
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
    expect(modelLabel("agy", "gemini-4-argon")).toBe("Gemini 4 Argon");
    expect(modelLabel("agy", "gemini-4-argon-medium")).toBe("Gemini 4 Argon");
    expect(modelLabel("codex", "gpt-5.6-terra")).toBe("GPT-5.6-Terra");
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
  it("打包的名单：spec 里的模型，来源 bundled，都没写思考程度", () => {
    expect(bundledModelCatalog("claude")).toEqual({
      vendor: "claude",
      label: vendorSpec("claude").label,
      source: "bundled",
      availability: "unknown",
      defaultEfforts: null,
      defaultModel: null,
      defaultModelId: null,
      efforts: vendorSpec("claude").models.efforts,
      customModelExample: vendorSpec("claude").models.customModelExample,
      models: vendorSpec("claude").models.bundled.map((m) => ({ id: m.id, label: m.label, description: null, efforts: null })),
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

  it("effortsFor：名单里写了按它（按通用档位排序，且不截断模型动态返回的新档位），没写或不在名单里用通用档位；默认看 defaultEfforts", () => {
    expect(effortsFor(catalog, "claude-opus-4-6")).toEqual(["low", "high", "max", "ultra"]);
    expect(effortsFor(catalog, "claude-haiku-4-5")).toEqual(vendorSpec("claude").models.efforts);
    expect(effortsFor(catalog, "old")).toEqual([]);
    expect(effortsFor(catalog, "not-listed")).toEqual(vendorSpec("claude").models.efforts);
    expect(effortsFor(catalog, null)).toEqual(["low", "high"]);
    expect(effortsFor(bundledModelCatalog("claude"), null)).toEqual(vendorSpec("claude").models.efforts);
  });
});

describe("modelShortLabel 与 shortModelName", () => {
  it("claude：名单里有的用名单的名字；完整的 claude 模型名缩成“家族 版本”；认不出来的原样", () => {
    expect(modelShortLabel("claude", null)).toBe("默认");
    expect(modelShortLabel("claude", "sonnet")).toBe("Sonnet");
    expect(modelShortLabel("claude", "claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelShortLabel("claude", "claude-opus-4-1-20250805")).toBe("Opus 4.1");
    expect(modelShortLabel("claude", "claude-sonnet-5-5[1m]")).toBe("Sonnet 5.5 1M");
    expect(modelShortLabel("claude", "claude-opus-5-5-latest[2m]")).toBe("Opus 5.5 2M");
    expect(modelShortLabel("claude", "claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(modelShortLabel("claude", "claude-haiku-5")).toBe("Haiku 5");
    expect(modelShortLabel("claude", "us.anthropic.claude-haiku-5-5:0")).toBe("us.anthropic.claude-haiku-5-5:0");
    expect(modelShortLabel("claude", null, { ...bundledModelCatalog("claude"), defaultModel: "Opus 5.5" })).toBe("Opus 5.5");
  });

  it("agy 與 codex 的 shortModelName", () => {
    expect(vendorSpec("agy").models.shortName?.("gemini-4-argon")).toBe("Gemini 4 Argon");
    expect(vendorSpec("agy").models.shortName?.("gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
    expect(vendorSpec("agy").models.shortName?.("gemini-2.5-flash-lite")).toBe("Gemini 2.5 Flash Lite");
    expect(vendorSpec("agy").models.shortName?.("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(vendorSpec("agy").models.shortName?.("claude-sonnet-5-5[1m]")).toBe("Claude Sonnet 5.5 1M");
    expect(vendorSpec("agy").models.shortName?.("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(vendorSpec("agy").models.shortName?.("gpt-oss-120b")).toBe("GPT-OSS 120B");
    expect(vendorSpec("agy").models.shortName?.("custom-unknown-model")).toBeNull();

    expect(vendorSpec("codex").models.shortName?.("gpt-5.4")).toBe("GPT-5.4");
    expect(vendorSpec("codex").models.shortName?.("gpt-5.4-mini")).toBe("GPT-5.4 Mini");
    expect(vendorSpec("codex").models.shortName?.("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
    expect(vendorSpec("codex").models.shortName?.("gpt-5.3-codex-spark")).toBe("GPT-5.3 Codex Spark");
    expect(vendorSpec("codex").models.shortName?.("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(vendorSpec("codex").models.shortName?.("custom-unknown-model")).toBeNull();
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
    expect(vendorFailureOf("agy_not_found: spawn agy ENOENT")).toEqual({ kind: "missing", serviceName: "Antigravity" });
    expect(vendorFailureOf("codex_not_found: spawn codex ENOENT")).toEqual({ kind: "missing", serviceName: "Codex" });
  });

  it("vendorFailureOf：支持显式传 vendor 或按原文里的厂商特征词归属 serviceName", () => {
    // 1. 显式传 vendor：通用错误码归属给指定厂商
    expect(vendorFailureOf("rate_limit_exceeded", "agy")).toEqual({ kind: "quota", serviceName: "Antigravity" });
    expect(vendorFailureOf("not logged in", "codex")).toEqual({ kind: "auth", serviceName: "Codex" });
    expect(vendorFailureOf("context_length_exceeded", "claude")).toEqual({ kind: "context", serviceName: "Claude" });

    // 2. 未传 vendor：按原文里的 agy/antigravity 或 codex/openai/chatgpt 特征词优先匹配
    expect(vendorFailureOf("Antigravity RESOURCE_EXHAUSTED: quota exceeded")).toEqual({
      kind: "quota",
      serviceName: "Antigravity",
    });
    expect(vendorFailureOf("agy: unauthenticated, please sign in")).toEqual({
      kind: "auth",
      serviceName: "Antigravity",
    });
    expect(vendorFailureOf("OpenAI API error: usage_limit_reached")).toEqual({
      kind: "quota",
      serviceName: "Codex",
    });
    expect(vendorFailureOf("codex error: invalid_api_key (401)")).toEqual({
      kind: "auth",
      serviceName: "Codex",
    });
    expect(vendorFailureOf("ChatGPT context window exceeded")).toEqual({
      kind: "context",
      serviceName: "Codex",
    });
  });
});

describe("厂商在这台设备上能不能用", () => {
  it("没装的不列；没登录的列出来但不能选；能用、认不出的能选", () => {
    expect(VENDOR_AVAILABILITIES.filter(isListed)).toEqual(["available", "signed_out", "unknown"]);
    expect(VENDOR_AVAILABILITIES.filter(isSelectable)).toEqual(["available", "unknown"]);
  });

  it("不能选的状态有英文状态词，能选的没有", () => {
    for (const a of VENDOR_AVAILABILITIES) expect(AVAILABILITY_LABELS[a] === null).toBe(isSelectable(a));
    expect(AVAILABILITY_LABELS.signed_out).toBe("Not signed in");
    expect(AVAILABILITY_LABELS.not_installed).toBe("Not installed");
  });

  it("打包的名单状态是认不出（当能用）", () => {
    for (const v of AGENT_VENDORS) expect(bundledModelCatalog(v).availability).toBe("unknown");
  });

  it("找不到程序的错误码按厂商，认得出是哪家", () => {
    for (const v of AGENT_VENDORS) {
      expect(notFoundCode(v)).toBe(`${v}_not_found`);
      expect(vendorFailureOf(`${notFoundCode(v)}: /x/${v}: spawn ENOENT`)?.kind).toBe("missing");
    }
  });
});

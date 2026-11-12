import { describe, expect, it } from "vitest";
import { TurnUsage } from "../../daemon/driver/usage.ts";
import { EMPTY_TOKEN_USAGE } from "../../shared/index.ts";
import { buildReadonlyPolicy } from "../../shared/readonly-policy.ts";
import {
  codexReadonlyConfig,
  decideMcpElicitation,
  exhaustCodexRateLimitOnTurnError,
  parseCodexRateLimits,
  parseCodexTokenUsage,
  parseCodexToolStarted,
  readCodexLaunchConfig,
  ZERO_CODEX_USAGE_COUNTS,
} from "./protocol.ts";

// 真实数据（2026-11-07，codex-cli 0.162 的 account/rateLimits/updated）：这个账号只有一个 30 天窗口（windowDurationMins 43200），放在 primary 里。
describe("parseCodexRateLimits：窗口按 windowDurationMins 归类，不按 primary / secondary 的位置", () => {
  it("primary 是 30 天窗口：不能当成 5 小时（用户看到 5 小时“12/2 14:39 重置”就是它）", () => {
    const info = parseCodexRateLimits({ primary: { usedPercent: 19, windowDurationMins: 43200, resetsAt: 1796193545 }, secondary: null });
    expect(info).toEqual({
      status: "allowed",
      resetsAt: 1796193545,
      windows: { thirty_day: { utilization: 0.19, resetsAt: 1796193545, status: "allowed" } },
    });
  });

  it("300 分钟是 5 小时、10080 分钟是 7 天，和 primary / secondary 谁在哪无关", () => {
    const info = parseCodexRateLimits({
      primary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1793646000 },
      secondary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1793619600 },
    });
    expect(info?.windows).toEqual({
      seven_day: { utilization: 0.6, resetsAt: 1793646000, status: "allowed" },
      five_hour: { utilization: 0.35, resetsAt: 1793619600, status: "allowed" },
    });
  });

  it("不知道窗口多长（windowDurationMins 是 null 或不认识）的窗口不显示，不猜", () => {
    expect(parseCodexRateLimits({ primary: { usedPercent: 10, windowDurationMins: null, resetsAt: 1793646000 }, secondary: null })).toBeNull();
    expect(parseCodexRateLimits({ primary: { usedPercent: 10, windowDurationMins: 77, resetsAt: 1793646000 }, secondary: null })).toBeNull();
  });

  // 真实数据（2026-11-09 16:37，~/.codex/sessions/2026/11/09/rollout-2026-11-09T16-36-39-01a1bf73-ca31-7e02-ad20-6aebce6a86a3.jsonl）：
  // 第 39 行是 limit_id="codex"（5h 99%、7d 16%），455ms 后第 40 行是 limit_id="premium"，第 41 行 task_complete 报 usage_limit_exceeded（try again at 6:13 PM）。
  it("2026-11-09 真实 rollout 事件：兼容 snake_case，忽略非 codex 的专项桶（如 premium），并在 usage_limit_exceeded 时把耗尽的 5 小时桶标为 100% rejected", () => {
    const rolloutLine39RateLimits = {
      limit_id: "codex",
      limit_name: null,
      primary: { used_percent: 99.0, window_minutes: 300, resets_at: 1794219196 },
      secondary: { used_percent: 16.0, window_minutes: 10080, resets_at: 1794805996 },
      credits: { has_credits: false, unlimited: false, balance: "0" },
      individual_limit: null,
      spend_control_reached: null,
      plan_type: "plus",
      rate_limit_reached_type: null,
    };
    const codexInfo = parseCodexRateLimits(rolloutLine39RateLimits);
    expect(codexInfo).toEqual({
      status: "allowed",
      resetsAt: 1794219196,
      windows: {
        five_hour: { utilization: 0.99, resetsAt: 1794219196, status: "allowed" },
        seven_day: { utilization: 0.16, resetsAt: 1794805996, status: "allowed" },
      },
    });

    // 非 codex 的专项配额桶（即便带了窗口）也绝不能覆盖主额度 codex
    expect(
      parseCodexRateLimits({
        limit_id: "premium",
        limit_name: null,
        primary: { used_percent: 26.0, window_minutes: 300, resets_at: 1796193546 },
        secondary: null,
      }),
    ).toBeNull();
    expect(
      parseCodexRateLimits({
        limitId: "premium",
        primary: { usedPercent: 26, windowDurationMins: 300, resetsAt: 1796193546 },
        secondary: null,
      }),
    ).toBeNull();

    // 第 41 行 task_complete / turn/completed 的 usage_limit_exceeded 错误将 99% 的 5 小时窗口置为 100% rejected
    const rolloutLine41Error = {
      message:
        "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 6:13 PM.",
      codex_error_info: "usage_limit_exceeded",
    };
    expect(exhaustCodexRateLimitOnTurnError(codexInfo, rolloutLine41Error)).toEqual({
      status: "rejected",
      resetsAt: 1794219196,
      windows: {
        five_hour: { utilization: 1, resetsAt: 1794219196, status: "rejected" },
        seven_day: { utilization: 0.16, resetsAt: 1794805996, status: "allowed" },
      },
    });

    // account/rateLimits/read 返回 rateLimitReachedType="rate_limit_reached" 时直接标 rejected
    expect(
      parseCodexRateLimits({
        ordinaryUsageAllowed: false,
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1794219196 },
          secondary: { usedPercent: 16, windowDurationMins: 10080, resetsAt: 1794805996 },
          rateLimitReachedType: "rate_limit_reached",
        },
      }),
    ).toEqual({
      status: "rejected",
      resetsAt: 1794219196,
      windows: {
        five_hour: { utilization: 1, resetsAt: 1794219196, status: "rejected" },
        seven_day: { utilization: 0.16, resetsAt: 1794805996, status: "allowed" },
      },
    });

    // 普通非额度错误不改 rateLimit
    expect(exhaustCodexRateLimitOnTurnError(codexInfo, { message: "command failed", codexErrorInfo: "sandboxError" })).toBeNull();
  });
});

const policy = (connectors: { extraAllow?: string[]; deny?: string[] } = {}) => buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/Users/u/.agent-hub/state", connectors });

describe("codexReadonlyConfig：只读 Worker 的 codex 配置（设计 2.3 / 第 5 节；S5 实测只有 profile 这种写法的 deny_read 生效）", () => {
  it("密钥禁读：default_permissions 指向 :read-only 的 profile，密钥路径设成 none", () => {
    const cfg = codexReadonlyConfig(policy());
    expect(cfg["default_permissions"]).toBe("hub_readonly");
    expect(cfg["permissions.hub_readonly.extends"]).toBe(":read-only");
    const fs = cfg["permissions.hub_readonly.filesystem"] as Record<string, string>;
    expect(fs["/Users/u/.ssh"]).toBe("none");
    expect(fs["/Users/u/.codex/auth.json"]).toBe("none");
    expect(fs["/Users/u/.agent-hub/state/ui-token"]).toBe("none");
    expect(Object.values(fs).every((v) => v === "none")).toBe(true);
  });

  it("连接器补充：approval_mode=approve；排除：disabled_tools；排除整个服务器：enabled=false", () => {
    const cfg = codexReadonlyConfig(policy({ extraAllow: ["slack/post_note", "gmail/*", "*/x"], deny: ["jenkins/build", "jenkins/stop", "amplitude/*", "*/y"] }));
    expect(cfg["mcp_servers.slack.tools.post_note.approval_mode"]).toBe("approve");
    expect(cfg["mcp_servers.jenkins.disabled_tools"]).toEqual(["build", "stop"]);
    expect(cfg["mcp_servers.amplitude.enabled"]).toBe(false);
    // 服务器或工具是通配的写不进 codex 配置（要有确切名字），不乱写，留给 elicitation 兜底
    expect(Object.keys(cfg).filter((k) => k.includes("gmail") || k.includes("*"))).toEqual([]);
  });

  it("补充和排除同一个工具：排除优先，不再写 approve", () => {
    const cfg = codexReadonlyConfig(policy({ extraAllow: ["slack/post"], deny: ["slack/post"] }));
    expect(cfg["mcp_servers.slack.tools.post.approval_mode"]).toBeUndefined();
    expect(cfg["mcp_servers.slack.disabled_tools"]).toEqual(["post"]);
  });

  it("名字里有点或空格的服务器、工具加引号", () => {
    const cfg = codexReadonlyConfig(policy({ extraAllow: ["my.server/do it"] }));
    expect(cfg['mcp_servers."my.server".tools."do it".approval_mode']).toBe("approve");
  });

  it("readCodexLaunchConfig：files.readonly 有值才并进只读配置，普通 Worker 不带", () => {
    const base = { promptFile: "/nonexistent", env: {} } as never;
    expect(readCodexLaunchConfig(base).config["default_permissions"]).toBeUndefined();
    const ro = readCodexLaunchConfig({ ...(base as object), readonly: policy() } as never);
    expect(ro.readonly).toBe(true);
    expect(ro.config["default_permissions"]).toBe("hub_readonly");
    expect(ro.config["shell_environment_policy.inherit"]).toBe("all");
  });
});

describe("decideMcpElicitation：mcpServer/elicitation/request 回 {action}", () => {
  const ask = (server: string, tool: string, extra: Record<string, unknown> = {}) => ({
    serverName: server,
    message: `Allow the ${server} MCP server to run tool "${tool}"?`,
    _meta: { codex_approval_kind: "mcp_tool_call", tool_title: tool, ...extra },
  });

  it("只读：手动补充的放行，其余（没标只读的、排除的）拒", () => {
    const p = policy({ extraAllow: ["slack/post"], deny: ["slack/delete"] });
    expect(decideMcpElicitation(ask("slack", "post"), { readonly: true, policy: p })).toEqual({ action: "accept" });
    expect(decideMcpElicitation(ask("slack", "other"), { readonly: true, policy: p })).toEqual({ action: "decline" });
    expect(decideMcpElicitation(ask("slack", "delete"), { readonly: true, policy: p })).toEqual({ action: "decline" });
  });

  it("只读：带着只读声明的放行（annotations 在 _meta.tool_annotations 里时），排除的仍然拒", () => {
    const p = policy({ deny: ["s/bad"] });
    const ann = { tool_annotations: { readOnlyHint: true } };
    expect(decideMcpElicitation(ask("s", "look", ann), { readonly: true, policy: p })).toEqual({ action: "accept" });
    expect(decideMcpElicitation(ask("s", "bad", ann), { readonly: true, policy: p })).toEqual({ action: "decline" });
  });

  it("认不出服务器或工具、不是 mcp_tool_call 的一律拒；非只读也拒（另议）", () => {
    const p = policy({ extraAllow: ["*/*"] });
    expect(decideMcpElicitation({}, { readonly: true, policy: p })).toEqual({ action: "decline" });
    expect(decideMcpElicitation({ serverName: "s", _meta: { codex_approval_kind: "other", tool_title: "t" } }, { readonly: true, policy: p })).toEqual({ action: "decline" });
    expect(decideMcpElicitation(ask("s", "t"), { readonly: false, policy: null })).toEqual({ action: "decline" });
  });
});

describe("parseCodexToolStarted：连接器与子 agent 条目", () => {
  it("mcpToolCall：有 appContext（ChatGPT 应用连接器）用应用名、动作名，没有用 server / tool", () => {
    const withApp = parseCodexToolStarted(
      {
        type: "mcpToolCall",
        id: "m1",
        server: "codex_apps",
        tool: "linear_list_issues",
        arguments: { q: 1 },
        appContext: { connectorId: "c", linkId: null, resourceUri: null, appName: "Linear", actionName: "list_issues" },
      },
      1,
    );
    expect(withApp?.input).toEqual({ server: "Linear", tool: "list_issues", arguments: { q: 1 } });
    const plain = parseCodexToolStarted({ type: "mcpToolCall", id: "m2", server: "github", tool: "get_issue", appContext: null }, 2);
    expect(plain?.input).toEqual({ server: "github", tool: "get_issue" });
    const blankApp = parseCodexToolStarted({ type: "mcpToolCall", id: "m3", server: "github", tool: "x", appContext: { appName: " ", actionName: "" } }, 3);
    expect(blankApp?.input).toEqual({ server: "github", tool: "x" });
  });

  it("collabAgentToolCall（现在的名字）和 collabToolCall（老名字）都当工具条目", () => {
    expect(parseCodexToolStarted({ type: "collabAgentToolCall", id: "c1", tool: "spawnAgent", prompt: "查一下" }, 1)).toMatchObject({
      type: "agent.tool",
      name: "collabAgentToolCall",
      input: { tool: "spawnAgent", prompt: "查一下" },
    });
    expect(parseCodexToolStarted({ type: "collabToolCall", id: "c2" }, 1)).toMatchObject({ name: "collabToolCall" });
  });
});

describe("parseCodexTokenUsage：扣除已含缓存的 inputTokens，避免 context 翻倍", () => {
  it("inputTokens 含 cachedInputTokens 时：input 为不含缓存部分，context 为真实上下文 118111 而非 233361", () => {
    const parsed = parseCodexTokenUsage(
      {
        last: { inputTokens: 118_111, cachedInputTokens: 115_250, outputTokens: 500, reasoningOutputTokens: 120 },
        total: { inputTokens: 118_111, cachedInputTokens: 115_250, outputTokens: 500, reasoningOutputTokens: 120 },
      },
      "turn-603",
    );
    expect(parsed).not.toBeNull();
    const turnUsage = new TurnUsage();
    const live = turnUsage.observe(parsed!.observeObj, EMPTY_TOKEN_USAGE);
    expect(live).toEqual({
      input: 2_861,
      cacheRead: 115_250,
      cacheWrite: 0,
      output: 500,
      context: 118_111,
    });
    const finished = turnUsage.finish(EMPTY_TOKEN_USAGE, parsed!.resultUsage);
    expect(finished).toEqual({
      input: 2_861,
      cacheRead: 115_250,
      cacheWrite: 0,
      output: 500,
      context: 118_111,
    });
  });

  it("异常数据 cachedInputTokens 大于 inputTokens 时截断为 0，不产生负数", () => {
    const parsed = parseCodexTokenUsage(
      {
        last: { inputTokens: 80, cachedInputTokens: 100, cacheWriteInputTokens: 10, outputTokens: 20 },
        total: { inputTokens: 80, cachedInputTokens: 100, cacheWriteInputTokens: 10, outputTokens: 20 },
      },
      "turn-clamp",
    );
    expect(parsed).not.toBeNull();
    const turnUsage = new TurnUsage();
    const live = turnUsage.observe(parsed!.observeObj, EMPTY_TOKEN_USAGE);
    expect(live).toEqual({
      input: 0,
      cacheRead: 100,
      cacheWrite: 10,
      output: 20,
      context: 110,
    });
  });

  it("线程累计 total 回退到已记录基线以下（服务端重置等）：按 total - last 重新校准基线，后续步骤不被截成 0", () => {
    const highWater = { input_tokens: 50_000, cache_read_input_tokens: 450_000, cache_creation_input_tokens: 0, output_tokens: 3_000 };
    const reset = parseCodexTokenUsage(
      {
        last: { inputTokens: 30_000, cachedInputTokens: 20_000, outputTokens: 100 },
        total: { inputTokens: 30_000, cachedInputTokens: 20_000, outputTokens: 100 },
      },
      "t9",
      { lastThreadTotal: highWater, turnResultUsage: null, stepSeq: 0 },
    )!;
    expect(reset.duplicate).toBe(false);
    expect(reset.resultUsage).toEqual({ input_tokens: 10_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0, output_tokens: 100 });
    expect(reset.nextState.lastThreadTotal).toEqual(reset.resultUsage);

    const next = parseCodexTokenUsage(
      {
        last: { inputTokens: 35_000, cachedInputTokens: 30_000, outputTokens: 50 },
        total: { inputTokens: 65_000, cachedInputTokens: 50_000, outputTokens: 150 },
      },
      "t9",
      reset.nextState,
    )!;
    expect(next.resultUsage).toEqual({ input_tokens: 15_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0, output_tokens: 150 });
    expect(next.context).toBe(35_000);
  });

  it("codex 自带压缩后那条 total 不变、last 全 0 的通知按重复跳过，不把 context 冲成 0 也不加用量", () => {
    const before = { input_tokens: 318_000, cache_read_input_tokens: 2_996_614, cache_creation_input_tokens: 0, output_tokens: 12_492 };
    const parsed = parseCodexTokenUsage(
      {
        last: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        total: { inputTokens: 3_314_614, cachedInputTokens: 2_996_614, outputTokens: 12_492 },
      },
      "t10",
      { lastThreadTotal: before, turnResultUsage: null, stepSeq: 0 },
    )!;
    expect(parsed.duplicate).toBe(true);
    expect(parsed.nextState.lastThreadTotal).toEqual(before);
  });

  it("跨步、重复通知、跨轮与冷恢复（lastThreadTotal=null）差值计算准确", () => {
    const turn1 = new TurnUsage();
    const step1 = parseCodexTokenUsage(
      {
        last: { inputTokens: 60_000, cachedInputTokens: 50_000, outputTokens: 200 },
        total: { inputTokens: 60_000, cachedInputTokens: 50_000, outputTokens: 200 },
      },
      "t1",
      { lastThreadTotal: ZERO_CODEX_USAGE_COUNTS, turnResultUsage: null, stepSeq: 0 },
    )!;
    expect(step1.duplicate).toBe(false);
    expect(turn1.observe(step1.observeObj, EMPTY_TOKEN_USAGE)).toEqual({
      input: 10_000,
      cacheRead: 50_000,
      cacheWrite: 0,
      output: 200,
      context: 60_000,
    });

    const step2 = parseCodexTokenUsage(
      {
        last: { inputTokens: 65_000, cachedInputTokens: 60_000, outputTokens: 300 },
        total: { inputTokens: 125_000, cachedInputTokens: 110_000, outputTokens: 500 },
      },
      "t1",
      step1.nextState,
    )!;
    expect(step2.duplicate).toBe(false);
    const live2 = turn1.observe(step2.observeObj, EMPTY_TOKEN_USAGE)!;
    expect({ ...live2, context: step2.context }).toEqual({
      input: 15_000,
      cacheRead: 110_000,
      cacheWrite: 0,
      output: 500,
      context: 65_000,
    });

    const dup = parseCodexTokenUsage(
      {
        last: { inputTokens: 65_000, cachedInputTokens: 60_000, outputTokens: 300 },
        total: { inputTokens: 125_000, cachedInputTokens: 110_000, outputTokens: 500 },
      },
      "t1",
      step2.nextState,
    )!;
    expect(dup.duplicate).toBe(true);
    const afterTurn1 = turn1.finish(EMPTY_TOKEN_USAGE, dup.resultUsage);
    expect(afterTurn1).toEqual({
      input: 15_000,
      cacheRead: 110_000,
      cacheWrite: 0,
      output: 500,
      context: 65_000,
    });

    // 冷启动 thread/resume（lastThreadTotal 为 null）：首步用 total - last 反推基线
    const turn2 = new TurnUsage();
    const coldStep = parseCodexTokenUsage(
      {
        last: { inputTokens: 70_000, cachedInputTokens: 65_000, outputTokens: 400 },
        total: { inputTokens: 195_000, cachedInputTokens: 175_000, outputTokens: 900 },
      },
      "t2",
      { lastThreadTotal: null, turnResultUsage: null, stepSeq: 0 },
    )!;
    expect(coldStep.duplicate).toBe(false);
    expect(turn2.observe(coldStep.observeObj, afterTurn1)).toEqual({
      input: 20_000,
      cacheRead: 175_000,
      cacheWrite: 0,
      output: 900,
      context: 70_000,
    });
    expect(turn2.finish(afterTurn1, coldStep.resultUsage)).toEqual({
      input: 20_000,
      cacheRead: 175_000,
      cacheWrite: 0,
      output: 900,
      context: 70_000,
    });
  });
});

// 只读 agy 的翻译层（设计第 6 节测试 4）：--settings 规则、连接器拒绝规则、兜底检查、外层沙箱参数、被拒后补一轮的文字。
import { describe, expect, it } from "vitest";
import { buildReadonlyPolicy, type ReadonlyPolicy } from "../../shared/index.ts";
import {
  AGY_RUNTIME_DIRS,
  READONLY_CACHE_DIRS,
  agyConnectorRules,
  agyMcpRule,
  agyReadonlySandboxInput,
  agyReadonlySettings,
  checkAgyConnectorCall,
  connectorProbeSandboxInput,
  deniedActionsOf,
  deniedContinueText,
  describeDeniedAction,
  type AgyConnectorCatalog,
} from "./readonly-agy.ts";

const policy = (connectors: Partial<ReadonlyPolicy["connectors"]> = {}): ReadonlyPolicy =>
  buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/Users/u/.agent-hub/state", connectors });
const identity = (p: string) => p;

const catalog: AgyConnectorCatalog = {
  servers: {
    slack: { send_message: { readOnlyHint: false, destructiveHint: true }, read_channel: { readOnlyHint: true }, edit: { readOnlyHint: true, destructiveHint: true } },
    jenkins: { get_build: null, build_item: {} },
    "claude-ai": { search: { readOnlyHint: true } },
  },
  unlistable: ["broken"],
};

describe("agyReadonlySettings", () => {
  it("放行读、命令、读网页，拒写文件，关掉 agy 自带终端沙箱（外层沙箱里不能嵌套）", () => {
    const s = agyReadonlySettings(policy(), undefined, identity);
    expect(s.permissions.allow).toEqual(["read_file(*)", "command(*)", "read_url(*)"]);
    expect(s.permissions.deny[0]).toBe("write_file(*)");
    expect(s.enableTerminalSandbox).toBe(false);
  });

  it("密钥路径按真实路径拒读（目录连子树）；通配 agy 的规则表达不了，不写（外层沙箱的正则管）", () => {
    const real = (p: string) => p.replace("/Users/u", "/private/Users/u");
    const deny = agyReadonlySettings(policy(), undefined, real).permissions.deny;
    expect(deny).toContain("read_file(/private/Users/u/.ssh)");
    expect(deny).toContain("read_file(/private/Users/u/.ssh/*)");
    expect(deny).toContain("read_file(/private/Users/u/.agent-hub/state/ui-token)");
    expect(deny.some((r) => r.includes("*.env") || r.includes("**"))).toBe(false);
  });

  it("连接器的规则接在后面：补充的进 allow，拒绝的进 deny", () => {
    const s = agyReadonlySettings(policy(), { allow: ["mcp(jenkins/get_build)"], deny: ["mcp(slack/send_message)"] }, identity);
    expect(s.permissions.allow).toContain("mcp(jenkins/get_build)");
    expect(s.permissions.deny).toContain("mcp(slack/send_message)");
  });
});

describe("agyConnectorRules：连接器按 readOnlyHint 拒（统一用 connectorToolAllowed）", () => {
  it("没标、标了非只读、既只读又 destructive 的工具拒；只读的不拒、显式写进 allow（agy 无头下没规则的 mcp 工具会被自动拒、整轮空回复）；问不到清单的服务器整个拒", () => {
    const { allow, deny } = agyConnectorRules(policy(), catalog);
    expect(allow.sort()).toEqual(["mcp(claude-ai/search)", "mcp(slack/read_channel)"]);
    expect(deny.sort()).toEqual(["mcp(broken/*)", "mcp(jenkins/build_item)", "mcp(jenkins/get_build)", "mcp(slack/edit)", "mcp(slack/send_message)"]);
  });

  it("手动补充：没标记的工具放行（进 allow、不进 deny）；手动排除压过只读标记和补充", () => {
    const rules = agyConnectorRules(policy({ extraAllow: ["jenkins/get_build", "slack/send_message"], deny: ["slack/read_channel", "slack/send_message"] }), catalog);
    expect(rules.allow.sort()).toEqual(["mcp(claude-ai/search)", "mcp(jenkins/get_build)"]); // slack/send_message 又补充又排除：排除赢，不进 allow
    expect(rules.deny).toContain("mcp(slack/read_channel)");
    expect(rules.allow).not.toContain("mcp(slack/read_channel)"); // 被手动排除的不进 allow
    expect(rules.deny).toContain("mcp(slack/send_message)"); // deny 压过 extraAllow
    expect(rules.deny).not.toContain("mcp(jenkins/get_build)");
    expect(rules.deny).toContain("mcp(jenkins/build_item)");
  });

  it("补充写 服务器/*：整个服务器放行，连没法查清单的也放行", () => {
    const rules = agyConnectorRules(policy({ extraAllow: ["jenkins/*", "broken/*"] }), catalog);
    expect(rules.deny).not.toContain("mcp(jenkins/get_build)");
    expect(rules.deny).not.toContain("mcp(broken/*)");
    expect(rules.allow).toEqual(expect.arrayContaining(["mcp(jenkins/*)", "mcp(broken/*)", "mcp(slack/read_channel)"]));
    expect(rules.allow.filter((r) => r === "mcp(jenkins/*)")).toHaveLength(1);
  });

  it("allow 里每条规则都不在 deny 里（只读的放行、非只读的拒，两边不重叠）", () => {
    const { allow, deny } = agyConnectorRules(policy(), catalog);
    expect(allow.filter((r) => deny.includes(r))).toEqual([]);
  });

  it("agyMcpRule：没有 / 的当整个服务器，全通配是 mcp(*)", () => {
    expect(agyMcpRule("slack")).toBe("mcp(slack/*)");
    expect(agyMcpRule("slack/send")).toBe("mcp(slack/send)");
    expect(agyMcpRule("*/*")).toBe("mcp(*)");
  });
});

describe("checkAgyConnectorCall：调用时的兜底检查", () => {
  const check = (toolName: string, parameters: unknown, p: ReadonlyPolicy = policy()) => checkAgyConnectorCall(toolName, parameters, p, catalog);

  it("call_mcp_tool：按 ServerName / ToolName 看清单", () => {
    expect(check("call_mcp_tool", { ServerName: "slack", ToolName: "read_channel" })).toBeNull();
    expect(check("call_mcp_tool", { ServerName: "slack", ToolName: "send_message" })).toContain("slack/send_message");
    expect(check("call_mcp_tool", { ServerName: "jenkins", ToolName: "get_build" })).toContain("jenkins/get_build");
    expect(check("call_mcp_tool", { ServerName: "unknown", ToolName: "x" })).toContain("unknown/x");
    expect(check("call_mcp_tool", {})).toContain("只读的连接器工具");
    expect(check("call_mcp_tool", null)).toContain("只读的连接器工具");
  });

  it("mcp_<服务器>_<工具>：按清单反查（服务器名里的 - 在工具名里变成 _）；清单里没有的拒", () => {
    expect(check("mcp_slack_read_channel", {})).toBeNull();
    expect(check("mcp_claude_ai_search", {})).toBeNull();
    expect(check("mcp_slack_send_message", {})).toContain("slack/send_message");
    expect(check("mcp_jenkins_get_build", {})).toContain("jenkins/get_build");
    expect(check("mcp_other_tool", {})).not.toBeNull();
  });

  it("扁平名撞名（a-b/c 和 a_b/c 都是 mcp_a_b_c）：分不清，一律拒，哪怕撞上的有只读的、有手动补充", () => {
    const clash: AgyConnectorCatalog = {
      servers: { "a-b": { c: { readOnlyHint: true } }, a_b: { c: { readOnlyHint: false } } },
      unlistable: [],
    };
    expect(checkAgyConnectorCall("mcp_a_b_c", {}, policy(), clash)).toContain("分不清");
    expect(checkAgyConnectorCall("mcp_a_b_c", {}, policy({ extraAllow: ["a-b/c"] }), clash)).toContain("分不清");
    // 两个都只读也拒（撞名一律拒）；不撞的照常
    const bothRo: AgyConnectorCatalog = { servers: { "a-b": { c: { readOnlyHint: true } }, a_b: { c: { readOnlyHint: true } }, ok: { x: { readOnlyHint: true } } }, unlistable: [] };
    expect(checkAgyConnectorCall("mcp_a_b_c", {}, policy(), bothRo)).toContain("分不清");
    expect(checkAgyConnectorCall("mcp_ok_x", {}, policy(), bothRo)).toBeNull();
  });

  it("手动补充放行、手动排除拒（压过只读标记）", () => {
    expect(check("call_mcp_tool", { ServerName: "jenkins", ToolName: "get_build" }, policy({ extraAllow: ["jenkins/get_build"] }))).toBeNull();
    expect(check("mcp_slack_read_channel", {}, policy({ deny: ["slack/*"] }))).not.toBeNull();
  });

  it("内置工具不管", () => {
    for (const name of ["read_file", "run_command", "write_file", "view_file", "call_other"]) expect(check(name, { ServerName: "slack", ToolName: "send_message" }), name).toBeNull();
  });
});

describe("connectorProbeSandboxInput：探测 MCP 服务器用的只读沙箱", () => {
  it("只有私有临时目录和通用缓存目录可写，agy 运行时目录不放；密钥照禁（含钥匙串）", () => {
    const input = connectorProbeSandboxInput({ homeDir: "/Users/u", tmpDir: "/tmp/probe-1", policy: policy(), realpath: (p) => p });
    expect(input.tmpDir).toBe("/tmp/probe-1");
    expect(input.writableDirs).toEqual(READONLY_CACHE_DIRS.map((d) => `/Users/u/${d}`));
    expect(input.writableFileGlobs).toEqual([]);
    expect(input.writableFileRegexes).toEqual([]);
    expect(input.secretPaths).toContain("/Users/u/.ssh");
    expect(input.secretPaths).toContain("/Users/u/Library/Keychains");
  });
});

describe("agyReadonlySandboxInput", () => {
  it("可写的只有私有临时目录、agy 运行时目录、通用缓存目录和几个具体文件（bin/agentapi*、mcp 两层）；密钥原样交给沙箱；路径都过 realpath", () => {
    const real = (p: string) => p.replace(/^\/tmp\//, "/private/tmp/");
    const input = agyReadonlySandboxInput({ homeDir: "/Users/u", tmpDir: "/tmp/ro-1", policy: policy(), realpath: real });
    expect(input.tmpDir).toBe("/private/tmp/ro-1");
    expect(input.writableDirs).toEqual([
      ...AGY_RUNTIME_DIRS.map((d) => `/Users/u/.gemini/antigravity-cli/${d}`),
      ...READONLY_CACHE_DIRS.map((d) => `/Users/u/${d}`),
    ]);
    // bin/、mcp/ 不整个放开：只有 agentapi 脚本、MCP 工具定义缓存的文件（两层）可写
    expect(input.writableDirs).not.toContain("/Users/u/.gemini/antigravity-cli/bin");
    expect(input.writableDirs).not.toContain("/Users/u/.gemini/antigravity-cli/mcp");
    expect(input.writableFileGlobs).toContain("/Users/u/.gemini/antigravity-cli/bin/agentapi*");
    expect(input.writableFileGlobs).toContain("/Users/u/.gemini/antigravity-cli/mcp/*");
    expect(input.writableFileGlobs).toContain("/Users/u/.gemini/antigravity-cli/mcp/*/*");
    expect(input.writableFileRegexes).toContain("^/Users/u/\\.gemini/antigravity-cli/bin/agentapi[^/]*$");
    expect(input.writableFileRegexes).toContain("^/Users/u/\\.gemini/antigravity-cli/mcp/[^/]*$");
    expect(input.writableFileRegexes).toContain("^/Users/u/\\.gemini/antigravity-cli/mcp/[^/]*/[^/]*$");
    expect(input.writableFileRegexes.some((r) => r.includes("webm_encoder"))).toBe(false);
    expect(input.writableDirs).toContain("/Users/u/.cache");
    expect(input.writableDirs).toContain("/Users/u/Library/Caches");
    // 配置不放：settings.json、config/（mcp_config、hooks、plugins）
    expect(input.writableDirs.some((d) => d.endsWith("/config") || d.endsWith("settings.json"))).toBe(false);
    expect(input.writableFileRegexes).toContain("^/Users/u/\\.gemini/antigravity-cli/conversation_summaries\\.db[^/]*$");
    expect(input.secretPaths).toContain("/Users/u/.ssh");
    // agy 的登录在钥匙串里：沙箱不能禁读它（否则 Authentication required），其余密钥照禁
    expect(input.secretPaths).not.toContain("/Users/u/Library/Keychains");
    expect(input.secretPaths).toContain("/Users/u/.aws");
    expect(input.secretGlobs).toContain("**/.env");
  });
});

describe("被拒后补一轮的文字", () => {
  it("denied_actions 的几种写法都能描述；空、没有是 []", () => {
    expect(describeDeniedAction("write_file")).toBe("write_file");
    expect(describeDeniedAction({ tool_name: "run_command", reason: "需要批准" })).toBe("run_command（需要批准）");
    expect(describeDeniedAction({ action: "mcp", display_name: "CallMcpTool" })).toBe("CallMcpTool（需要 mcp 权限）"); // S4 实测的真实形状
    expect(describeDeniedAction({ foo: 1 })).toBe('{"foo":1}');
    expect(deniedActionsOf({ denied_actions: [{ name: "a" }, "b"] })).toEqual(["a", "b"]);
    expect(deniedActionsOf({ denied_actions: [] })).toEqual([]);
    expect(deniedActionsOf({})).toEqual([]);
    expect(deniedActionsOf({ denied_actions: "x" })).toEqual([]);
  });

  it("补发的话点名被拒的操作，叫它换办法、别再调", () => {
    const text = deniedContinueText(["write_file", "run_command"]);
    expect(text).toContain("write_file、run_command");
    expect(text).toContain("换别的办法");
    expect(text).toContain("不要再调用");
  });
});

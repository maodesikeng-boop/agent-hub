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
  it("没标、标了非只读、既只读又 destructive 的工具拒；只读的不拒；问不到清单的服务器整个拒", () => {
    const { allow, deny } = agyConnectorRules(policy(), catalog);
    expect(allow).toEqual([]);
    expect(deny.sort()).toEqual(["mcp(broken/*)", "mcp(jenkins/build_item)", "mcp(jenkins/get_build)", "mcp(slack/edit)", "mcp(slack/send_message)"]);
  });

  it("手动补充：没标记的工具放行（进 allow、不进 deny）；手动排除压过只读标记和补充", () => {
    const rules = agyConnectorRules(policy({ extraAllow: ["jenkins/get_build", "slack/send_message"], deny: ["slack/read_channel", "slack/send_message"] }), catalog);
    expect(rules.allow).toEqual(["mcp(jenkins/get_build)", "mcp(slack/send_message)"]);
    expect(rules.deny).toContain("mcp(slack/read_channel)");
    expect(rules.deny).toContain("mcp(slack/send_message)"); // deny 压过 extraAllow
    expect(rules.deny).not.toContain("mcp(jenkins/get_build)");
    expect(rules.deny).toContain("mcp(jenkins/build_item)");
  });

  it("补充写 服务器/*：整个服务器放行，连没法查清单的也放行", () => {
    const rules = agyConnectorRules(policy({ extraAllow: ["jenkins/*", "broken/*"] }), catalog);
    expect(rules.deny).not.toContain("mcp(jenkins/get_build)");
    expect(rules.deny).not.toContain("mcp(broken/*)");
    expect(rules.allow).toEqual(["mcp(jenkins/*)", "mcp(broken/*)"]);
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

  it("手动补充放行、手动排除拒（压过只读标记）", () => {
    expect(check("call_mcp_tool", { ServerName: "jenkins", ToolName: "get_build" }, policy({ extraAllow: ["jenkins/get_build"] }))).toBeNull();
    expect(check("mcp_slack_read_channel", {}, policy({ deny: ["slack/*"] }))).not.toBeNull();
  });

  it("内置工具不管", () => {
    for (const name of ["read_file", "run_command", "write_file", "view_file", "call_other"]) expect(check(name, { ServerName: "slack", ToolName: "send_message" }), name).toBeNull();
  });
});

describe("agyReadonlySandboxInput", () => {
  it("可写的只有私有临时目录、agy 运行时目录（含 bin：agentapi 脚本）、通用缓存目录；密钥原样交给沙箱；路径都过 realpath", () => {
    const real = (p: string) => p.replace(/^\/tmp\//, "/private/tmp/");
    const input = agyReadonlySandboxInput({ homeDir: "/Users/u", tmpDir: "/tmp/ro-1", policy: policy(), realpath: real });
    expect(input.tmpDir).toBe("/private/tmp/ro-1");
    expect(input.writableDirs).toEqual([
      ...AGY_RUNTIME_DIRS.map((d) => `/Users/u/.gemini/antigravity-cli/${d}`),
      ...READONLY_CACHE_DIRS.map((d) => `/Users/u/${d}`),
    ]);
    expect(input.writableDirs).toContain("/Users/u/.gemini/antigravity-cli/bin");
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

import { describe, expect, it } from "vitest";
import { READONLY_SECRET_GLOBS, READONLY_SECRET_HOME_PATHS, buildReadonlyPolicy, connectorToolAllowed, type ReadonlyPolicy } from "./readonly-policy.ts";

const policy = (connectors: Partial<ReadonlyPolicy["connectors"]> = {}) => buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/Users/u/.agent-hub/state", connectors });

describe("connectorToolAllowed：连接器按 readOnlyHint 自动放行，补充/排除手动调", () => {
  it("readOnlyHint 放行；没标记（没有 annotations、空对象、readOnlyHint 为 false）一律拒", () => {
    expect(connectorToolAllowed(policy(), "slack", "search", { readOnlyHint: true })).toBe(true);
    expect(connectorToolAllowed(policy(), "jenkins", "get_build", undefined)).toBe(false);
    expect(connectorToolAllowed(policy(), "jenkins", "get_build", null)).toBe(false);
    expect(connectorToolAllowed(policy(), "jenkins", "get_build", {})).toBe(false);
    expect(connectorToolAllowed(policy(), "slack", "send", { readOnlyHint: false })).toBe(false);
  });

  it("destructive 的拒，即使同时标了 readOnlyHint", () => {
    expect(connectorToolAllowed(policy(), "x", "drop", { readOnlyHint: false, destructiveHint: true })).toBe(false);
    expect(connectorToolAllowed(policy(), "x", "weird", { readOnlyHint: true, destructiveHint: true })).toBe(false);
  });

  it("extraAllow 放行没标记的；也放行标成非只读的（用户明确补充的）", () => {
    const p = policy({ extraAllow: ["jenkins/get_build"] });
    expect(connectorToolAllowed(p, "jenkins", "get_build", undefined)).toBe(true);
    expect(connectorToolAllowed(p, "jenkins", "build_item", undefined)).toBe(false);
    expect(connectorToolAllowed(p, "other", "get_build", undefined)).toBe(false);
    expect(connectorToolAllowed(policy({ extraAllow: ["x/y"] }), "x", "y", { readOnlyHint: false })).toBe(true);
  });

  it("deny 压过 extraAllow 和 readOnlyHint", () => {
    const p = policy({ extraAllow: ["jenkins/*"], deny: ["jenkins/run_groovy_script", "slack/slack_read_file"] });
    expect(connectorToolAllowed(p, "jenkins", "get_build", undefined)).toBe(true);
    expect(connectorToolAllowed(p, "jenkins", "run_groovy_script", undefined)).toBe(false);
    expect(connectorToolAllowed(p, "slack", "slack_read_file", { readOnlyHint: true })).toBe(false);
    expect(connectorToolAllowed(p, "slack", "slack_read_channel", { readOnlyHint: true })).toBe(true);
  });

  it("服务器/* 通配：补充和排除都认；* 当服务器名也行；没有斜杠的当整个服务器", () => {
    expect(connectorToolAllowed(policy({ extraAllow: ["pdf-viewer/*"] }), "pdf-viewer", "anything", undefined)).toBe(true);
    expect(connectorToolAllowed(policy({ extraAllow: ["pdf-viewer"] }), "pdf-viewer", "anything", undefined)).toBe(true);
    expect(connectorToolAllowed(policy({ deny: ["rea/*"] }), "rea", "open_binary", { readOnlyHint: true })).toBe(false);
    expect(connectorToolAllowed(policy({ deny: ["*/delete_all"] }), "any", "delete_all", { readOnlyHint: true })).toBe(false);
    expect(connectorToolAllowed(policy({ deny: ["rea/*"] }), "reax", "x", { readOnlyHint: true })).toBe(true);
  });
});

describe("buildReadonlyPolicy：密钥清单", () => {
  it("主目录下的密钥按主目录展开，数据目录里的令牌文件按 state/ 展开", () => {
    const p = policy();
    expect(p.secretPaths).toContain("/Users/u/.ssh");
    expect(p.secretPaths).toContain("/Users/u/.config/gh");
    expect(p.secretPaths).toContain("/Users/u/.codex/auth.json");
    expect(p.secretPaths).toContain("/Users/u/Library/Keychains");
    expect(p.secretPaths).toContain("/Users/u/.agent-hub/state/ui-token");
    expect(p.secretPaths).toHaveLength(READONLY_SECRET_HOME_PATHS.length + 1);
    expect(p.secretPaths.every((x) => x.startsWith("/") && !x.includes("~"))).toBe(true);
  });

  it("hub.sqlite 和日志不在禁读里（排查要读：库里没有现行令牌，查证见 readonly-policy.ts）；通配含 .env 和私钥", () => {
    const p = policy();
    expect(p.secretPaths.some((x) => /hub\.sqlite|logs/.test(x))).toBe(false);
    expect(p.secretPaths).not.toContain("/Users/u/.agent-hub/state");
    expect(p.secretGlobs).toEqual([...READONLY_SECRET_GLOBS]);
    expect(p.secretGlobs).toEqual(expect.arrayContaining(["**/.env", "**/id_rsa*", "**/*.pem"]));
  });

  it("主目录带尾部斜杠也行；连接器默认空；每次返回新对象，改了不影响下一次", () => {
    expect(buildReadonlyPolicy({ homeDir: "/Users/u/", stateDir: "/s/" }).secretPaths).toContain("/Users/u/.ssh");
    const a = policy();
    expect(a.connectors).toEqual({ extraAllow: [], deny: [] });
    a.connectors.deny.push("x/y");
    a.secretGlobs.length = 0;
    const b = policy();
    expect(b.connectors.deny).toEqual([]);
    expect(b.secretGlobs.length).toBeGreaterThan(0);
  });
});

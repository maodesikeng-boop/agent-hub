// 只读 Worker 的 claude 翻译（设计第 2.3 节 claude 一列）：统一策略 → --settings 里的权限规则和 claude 自带沙箱。
import { describe, expect, it } from "vitest";
import {
  CLAUDE_READONLY_ALLOW_TOOLS,
  CLAUDE_READONLY_DENY_TOOLS,
  CLAUDE_READONLY_PERMISSION_MODE,
  claudeReadonlyPermissions,
  claudeReadonlySandbox,
} from "./claude-readonly-settings.ts";
import { buildReadonlyPolicy, type ReadonlyPolicy } from "./readonly-policy.ts";

const policy = (connectors?: Partial<ReadonlyPolicy["connectors"]>): ReadonlyPolicy =>
  buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/Users/u/.agent-hub/state", connectors });

describe("claudeReadonlyPermissions", () => {
  it("default 档（不是 dontAsk、也不是 plan）：要批准的走驱动的 can_use_tool", () => {
    expect(CLAUDE_READONLY_PERMISSION_MODE).toBe("default");
  });

  it("放行内置的读、搜、命令、上网；拒绝三个编辑工具；连接器工具一条都不写进放行规则（驱动按 annotations 现场判断）", () => {
    const { allow, deny } = claudeReadonlyPermissions(policy());
    expect(allow).toEqual([...CLAUDE_READONLY_ALLOW_TOOLS]);
    expect([...CLAUDE_READONLY_ALLOW_TOOLS]).toEqual(["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"]);
    expect(allow.some((r) => r.startsWith("mcp__"))).toBe(false);
    expect([...CLAUDE_READONLY_DENY_TOOLS]).toEqual(["Edit", "Write", "NotebookEdit"]);
    expect(deny.slice(0, 3)).toEqual(["Edit", "Write", "NotebookEdit"]);
  });

  it("没有手写的 git 白名单和连接器清单了（Bash 整个放行，写由自带沙箱挡）", () => {
    const { allow, deny } = claudeReadonlyPermissions(policy());
    expect([...allow, ...deny].some((r) => r.includes("Bash(git"))).toBe(false);
  });

  it("密钥：每个路径拒绝读（路径本身和子树），通配拒绝读（// 开头的绝对路径）；claude 还会拿它查 Bash 命令行里写明的路径", () => {
    const { deny } = claudeReadonlyPermissions(policy());
    expect(deny).toContain("Read(//Users/u/.ssh)");
    expect(deny).toContain("Read(//Users/u/.ssh/**)");
    expect(deny).toContain("Read(//Users/u/.config/gh/**)");
    expect(deny).toContain("Read(//Users/u/.agent-hub/state/ui-token)");
    expect(deny).toContain("Read(//**/.env)");
    expect(deny).toContain("Read(//**/id_rsa*)");
  });

  it("密钥路径里的 \\ [ ] * ? 转义", () => {
    const p = { ...policy(), secretPaths: ["/Users/u/a[1]/k"], secretGlobs: [] };
    expect(claudeReadonlyPermissions(p).deny).toContain("Read(//Users/u/a\\[1\\]/k/**)");
  });

  it("连接器手动排除：<服务器>/<工具> → mcp__服务器__工具，<服务器>/* → mcp__服务器；*/工具 写不成规则，留给驱动判断", () => {
    const { deny } = claudeReadonlyPermissions(policy({ deny: ["jenkins/build_item", "rea/*", "jenkins", "*/send_message", "*/*"] }));
    expect(deny).toContain("mcp__jenkins__build_item");
    expect(deny).toContain("mcp__rea");
    expect(deny).toContain("mcp__jenkins");
    expect(deny.filter((r) => r.startsWith("mcp__"))).toHaveLength(3);
  });

  it("没有手动排除就没有 mcp__ 的拒绝规则；每次返回新数组", () => {
    const a = claudeReadonlyPermissions(policy());
    expect(a.deny.some((r) => r.startsWith("mcp__"))).toBe(false);
    a.allow.push("x");
    expect(claudeReadonlyPermissions(policy()).allow).not.toContain("x");
  });
});

describe("claudeReadonlySandbox", () => {
  const sandbox = claudeReadonlySandbox(policy(), { denyWrite: ["/w/cwd", "/w/main"], hubSock: "/private/tmp/h/run/hub.sock" });

  it("开自带沙箱，起不来就报错、不许绕出沙箱（实测 S1：echo >、python、touch 写工作目录、外面、主目录、/tmp 都失败）", () => {
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.failIfUnavailable).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    expect(sandbox.autoAllowBashIfSandboxed).toBe(true);
  });

  it("denyWrite 盖住工作目录和 add-dir（默认只有它们和 TMPDIR 能写）", () => {
    expect(sandbox.filesystem.denyWrite).toEqual(["/w/cwd", "/w/main"]);
  });

  it("denyRead：密钥路径、通配（**/ 开头的换成绝对根 /**/，实测 S3 的 <绝对路径>/**/.env 写法有效）", () => {
    expect(sandbox.filesystem.denyRead).toContain("/Users/u/.ssh");
    expect(sandbox.filesystem.denyRead).toContain("/Users/u/.agent-hub/state/ui-token");
    expect(sandbox.filesystem.denyRead).toContain("/**/.env");
    expect(sandbox.filesystem.denyRead).toContain("/**/*.pem");
    expect(sandbox.filesystem.denyRead).toContain("/**/id_rsa*");
    expect(sandbox.filesystem.denyRead.some((p) => p.startsWith("**"))).toBe(false);
  });

  it("网络：域名全放（curl、git 能通，实测 S2），hub.sock 放行（实测 S6）", () => {
    expect(sandbox.network.allowedDomains).toEqual(["*"]);
    expect(sandbox.network.allowUnixSockets).toEqual(["/private/tmp/h/run/hub.sock"]);
  });

  it("enableWeakerNetworkIsolation：macOS 沙箱放行 com.apple.trustd.agent，gh 等 Go 程序才能验 TLS 证书（不放就报 x509 OSStatus -26276，实测 S2）", () => {
    expect(sandbox.enableWeakerNetworkIsolation).toBe(true);
  });

  it("每次返回新对象", () => {
    sandbox.filesystem.denyWrite.push("/x");
    expect(claudeReadonlySandbox(policy(), { denyWrite: ["/w/cwd"], hubSock: "/s" }).filesystem.denyWrite).toEqual(["/w/cwd"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MODE,
  FORK_DENY_ALL_HOOK,
  FORK_DENY_RULES,
  FORK_PERMISSION_MODE,
  WORKER_ENV,
  buildForkSettings,
  buildSessionSettings,
  sessionEnv,
  stateDirDenyRule,
} from "./policy.ts";
import { claudeReadonlyPermissions, claudeReadonlySandbox } from "./claude-readonly-settings.ts";
import { HUB_COMMAND } from "./names.ts";
import { buildReadonlyPolicy } from "./readonly-policy.ts";

/** 放行 hub 的那条规则（命令名来自 names.ts）。 */
const allowHub = `Bash(${HUB_COMMAND}:*)`;

const base = { hubSock: "/private/tmp/h/run/hub.sock", stateDir: "/Users/u/.agent-hub/state", osSandboxed: false };
const stateDeny = "Edit(//Users/u/.agent-hub/state/**)";

describe("buildSessionSettings：项目经理", () => {
  it("auto 档；放行 hub 和 hub.sock；没有任何拒绝规则；不碰自动记忆", () => {
    const settings = buildSessionSettings({ role: "pm", ...base });
    expect(settings).toEqual({
      permissions: { defaultMode: "auto", allow: [allowHub] },
      sandbox: { network: { allowUnixSockets: ["/private/tmp/h/run/hub.sock"] } },
    });
    expect(DEFAULT_PERMISSION_MODE).toBe("auto");
    expect("deny" in settings.permissions).toBe(false);
    expect("autoMemoryEnabled" in settings).toBe(false);
  });

  it("没有额外的环境变量", () => {
    expect(sessionEnv("pm")).toEqual({});
  });
});

describe("buildSessionSettings：Worker", () => {
  it("和项目经理的一样，只多 autoMemoryEnabled: false 和 state/ 的兜底拒绝规则（数据目录不能写主要由驱动层按 writeScope 落实，见 write-scope.test.ts）", () => {
    const pm = buildSessionSettings({ role: "pm", ...base });
    const worker = buildSessionSettings({ role: "worker", ...base });
    expect(worker).toEqual({ ...pm, permissions: { ...pm.permissions, deny: [stateDeny] }, autoMemoryEnabled: false });
  });

  it("state/ 的拒绝规则：// 开头的绝对路径，结尾的 / 去掉，特殊字符转义", () => {
    expect(stateDirDenyRule("/Users/u/.agent-hub/state")).toBe(stateDeny);
    expect(stateDirDenyRule("/Users/u/.agent-hub/state/")).toBe(stateDeny);
    expect(stateDirDenyRule("/Users/u/a[1]/state")).toBe("Edit(//Users/u/a\\[1\\]/state/**)");
  });

  it("包进 OS 沙箱的 Worker 关掉 claude 自带的沙箱（不能嵌套）；没包的、项目经理不写，照用户设置", () => {
    expect(buildSessionSettings({ role: "worker", ...base, osSandboxed: true }).sandbox).toEqual({ enabled: false, network: { allowUnixSockets: [base.hubSock] } });
    expect("enabled" in buildSessionSettings({ role: "worker", ...base }).sandbox).toBe(false);
    expect("enabled" in buildSessionSettings({ role: "pm", ...base, osSandboxed: true }).sandbox).toBe(false);
  });

  it("关掉自动记忆的环境变量", () => {
    expect(WORKER_ENV).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    expect(sessionEnv("worker")).toEqual(WORKER_ENV);
  });
});

describe("buildSessionSettings：只读（claude 用自带沙箱，翻译见 claude-readonly-settings.ts）", () => {
  const policy = buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: base.stateDir });
  const readonly = { policy, denyWrite: ["/w/cwd", "/w/main"] };
  const ro = (extra: Partial<Parameters<typeof buildSessionSettings>[0]> = {}) => buildSessionSettings({ role: "worker", readonly, ...base, ...extra });

  it("default 档（不再是 dontAsk）；放行 hub 加内置读/命令/上网；拒绝编辑工具和读密钥；不写 state/ 的规则（编辑工具本来就全拒）", () => {
    const { allow, deny } = claudeReadonlyPermissions(policy);
    const s = ro();
    expect(s.permissions).toEqual({ defaultMode: "default", allow: [allowHub, ...allow], deny });
    expect(s.permissions.deny).not.toContain(stateDeny);
    expect(s.autoMemoryEnabled).toBe(false);
  });

  it("沙箱段是翻译出来的只读档（denyWrite 盖住工作目录和 add-dir、hub.sock 放行、enableWeakerNetworkIsolation 让 gh 验得了证书）", () => {
    const s = ro();
    expect(s.sandbox).toEqual(claudeReadonlySandbox(policy, { denyWrite: ["/w/cwd", "/w/main"], hubSock: base.hubSock }));
    expect(s.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, enableWeakerNetworkIsolation: true });
  });

  it("包进 OS 沙箱的标志对只读 Worker 不起作用：自带沙箱照开（进程不包外层，不会嵌套）", () => {
    expect(ro({ osSandboxed: true }).sandbox).toEqual(ro({ osSandboxed: false }).sandbox);
    expect((ro({ osSandboxed: true }).sandbox as { enabled: boolean }).enabled).toBe(true);
  });

  it("手写的只读白名单没了：不放行 git 子命令、没有 mcp__ 连接器清单、不放行任何写工具", () => {
    const { allow } = ro().permissions;
    expect(allow.some((r) => r.includes("git") || r.startsWith("mcp__") || /^(Edit|Write|NotebookEdit)\b/.test(r))).toBe(false);
    expect(allow).not.toContain("Bash(*)");
  });

  it("连接器手动排除进拒绝规则；补充不进放行规则", () => {
    const s = ro({ readonly: { policy: buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: base.stateDir, connectors: { extraAllow: ["rotest/plain_tool"], deny: ["jenkins/build_item"] } }), denyWrite: [] } });
    expect(s.permissions.deny).toContain("mcp__jenkins__build_item");
    expect(s.permissions.allow.some((r) => r.startsWith("mcp__"))).toBe(false);
  });

  it("不给 readonly 的 Worker 完全不变（回归）", () => {
    expect(buildSessionSettings({ role: "worker", ...base }).permissions).toEqual({ defaultMode: "auto", allow: [allowHub], deny: [stateDeny] });
  });

  it("每次返回新对象，改了不影响下一次", () => {
    const a = ro();
    a.permissions.deny!.length = 0;
    a.permissions.allow.push("Bash(*)");
    (a.sandbox as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite.length = 0;
    const b = ro();
    expect(b.permissions.deny).toEqual(claudeReadonlyPermissions(policy).deny);
    expect(b.permissions.allow).not.toContain("Bash(*)");
    expect((b.sandbox as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite).toEqual(["/w/cwd", "/w/main"]);
  });
});

describe("buildForkSettings：复制出来写交接的那份", () => {
  const pm = buildSessionSettings({ role: "pm", ...base });

  it("在项目经理的设置上：换成 dontAsk、加 Edit(//**) 拒绝、加拦所有工具的 PreToolUse 钩子、不许关钩子；别的照留", () => {
    expect(buildForkSettings(pm)).toEqual({
      permissions: { defaultMode: FORK_PERMISSION_MODE, allow: [allowHub], deny: ["Edit(//**)"] },
      sandbox: { network: { allowUnixSockets: [base.hubSock] } },
      hooks: { PreToolUse: [FORK_DENY_ALL_HOOK] },
      disableAllHooks: false,
    });
  });

  it("拒绝规则不写整个工具（Bash、Bash(*) 会把工具从清单里拿掉，缓存就没了）", () => {
    for (const rule of FORK_DENY_RULES) expect(rule).toMatch(/^\w+\(.+\)$/);
    expect(FORK_DENY_RULES).not.toContain("Bash(*)");
  });

  it("钩子拦所有工具：matcher 是 *，命令退出码 2（claude 把 2 当拦下）", () => {
    expect(FORK_DENY_ALL_HOOK.matcher).toBe("*");
    expect(FORK_DENY_ALL_HOOK.hooks).toHaveLength(1);
    expect(FORK_DENY_ALL_HOOK.hooks[0]!.command).toMatch(/exit 2$/);
  });

  it("项目经理已有的拒绝规则、钩子保留，追加在后面", () => {
    const own = { permissions: { defaultMode: "auto", allow: ["Read"], deny: ["Bash(rm *)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }], Stop: [{ hooks: [] }] } };
    const fork = buildForkSettings(own);
    expect(fork.permissions).toEqual({ defaultMode: "dontAsk", allow: ["Read"], deny: ["Bash(rm *)", "Edit(//**)"] });
    expect(fork.hooks).toEqual({ PreToolUse: [{ matcher: "Bash", hooks: [] }, FORK_DENY_ALL_HOOK], Stop: [{ hooks: [] }] });
  });

  it("没有设置（空对象）也给齐三层", () => {
    expect(buildForkSettings({})).toEqual({
      permissions: { defaultMode: "dontAsk", deny: ["Edit(//**)"] },
      hooks: { PreToolUse: [FORK_DENY_ALL_HOOK] },
      disableAllHooks: false,
    });
  });

  it("不改传进来的对象", () => {
    const own = buildSessionSettings({ role: "pm", ...base });
    const before = JSON.stringify(own);
    buildForkSettings(own);
    expect(JSON.stringify(own)).toBe(before);
  });
});

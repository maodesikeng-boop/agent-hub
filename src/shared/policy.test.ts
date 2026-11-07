import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MODE,
  FORK_DENY_ALL_HOOK,
  FORK_DENY_RULES,
  READONLY_GIT_DENY_RULES,
  READONLY_PERMISSION_MODE,
  WORKER_ENV,
  buildForkSettings,
  buildSessionSettings,
  readonlyAllowRules,
  sessionEnv,
  stateDirDenyRule,
} from "./policy.ts";
import { HUB_COMMAND } from "./names.ts";

/** 放行 hub 的那条规则（命令名来自 names.ts）。 */
const allowHub = `Bash(${HUB_COMMAND}:*)`;

const base = { hubSock: "/private/tmp/h/run/hub.sock", stateDir: "/Users/u/.agent-hub/state", osSandboxed: false };
const stateDeny = "Edit(//Users/u/.agent-hub/state/**)";

describe("buildSessionSettings：项目经理", () => {
  it("auto 档；放行 hub 和 hub.sock；没有任何拒绝规则；不碰自动记忆", () => {
    const settings = buildSessionSettings({ role: "pm", readonly: false, ...base });
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
    const pm = buildSessionSettings({ role: "pm", readonly: false, ...base });
    const worker = buildSessionSettings({ role: "worker", readonly: false, ...base });
    expect(worker).toEqual({ ...pm, permissions: { ...pm.permissions, deny: [stateDeny] }, autoMemoryEnabled: false });
  });

  it("state/ 的拒绝规则：// 开头的绝对路径，结尾的 / 去掉，特殊字符转义", () => {
    expect(stateDirDenyRule("/Users/u/.agent-hub/state")).toBe(stateDeny);
    expect(stateDirDenyRule("/Users/u/.agent-hub/state/")).toBe(stateDeny);
    expect(stateDirDenyRule("/Users/u/a[1]/state")).toBe("Edit(//Users/u/a\\[1\\]/state/**)");
  });

  it("包进 OS 沙箱的 Worker 关掉 claude 自带的沙箱（不能嵌套）；没包的、项目经理不写，照用户设置", () => {
    expect(buildSessionSettings({ role: "worker", readonly: false, ...base, osSandboxed: true }).sandbox).toEqual({ enabled: false, network: { allowUnixSockets: [base.hubSock] } });
    expect(buildSessionSettings({ role: "worker", readonly: true, ...base, osSandboxed: true }).sandbox.enabled).toBe(false);
    expect("enabled" in buildSessionSettings({ role: "worker", readonly: false, ...base }).sandbox).toBe(false);
    expect("enabled" in buildSessionSettings({ role: "pm", readonly: false, ...base, osSandboxed: true }).sandbox).toBe(false);
  });

  it("关掉自动记忆的环境变量", () => {
    expect(WORKER_ENV).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    expect(sessionEnv("worker")).toEqual(WORKER_ENV);
  });
});

describe("buildSessionSettings：只读", () => {
  it("readonly → dontAsk 档，多只读 git 的拒绝规则（Worker 再加 state/ 的）", () => {
    const worker = buildSessionSettings({ role: "worker", readonly: true, ...base });
    expect(READONLY_PERMISSION_MODE).toBe("dontAsk");
    expect(worker.permissions.defaultMode).toBe("dontAsk");
    expect(worker.permissions.allow).toEqual([allowHub, ...readonlyAllowRules(undefined)]);
    expect(worker.permissions.deny).toEqual([...READONLY_GIT_DENY_RULES, stateDeny]);
    expect(worker.autoMemoryEnabled).toBe(false);
  });

  it("只读 git 拒绝 --output（写文件）和 --ext-diff（跑外部程序）；项目经理开只读也有", () => {
    expect(READONLY_GIT_DENY_RULES).toEqual(["Bash(git * --output*)", "Bash(git * --ext-diff*)"]);
    expect(buildSessionSettings({ role: "pm", readonly: true, ...base }).permissions.deny).toEqual([...READONLY_GIT_DENY_RULES]);
    expect(buildSessionSettings({ role: "worker", readonly: false, ...base }).permissions.deny).toEqual([stateDeny]);
  });

  it("只读档放行：上网、读本项目 worktrees、只读 git、连接器只读工具", () => {
    const allow = buildSessionSettings({ role: "worker", readonly: true, ...base, projectWorktreesDir: "/Users/u/.agent-hub/worktrees/1" }).permissions.allow;
    expect(allow).toEqual(expect.arrayContaining([allowHub, "WebSearch", "WebFetch", "Read(//Users/u/.agent-hub/worktrees/1/**)"]));
    expect(allow).toContain("Bash(git -C * log *)");
    expect(allow).toContain("Bash(git -C * diff *)");
    expect(allow).toContain("mcp__claude_ai_Slack__slack_search_public");
    expect(allow).toContain("mcp__claude_ai_Slack__slack_read_channel");
    expect(allow).toContain("mcp__claude_ai_Gmail__search_threads");
  });

  it("写操作一条都不放行：不放行写文件、git 写命令、连接器写工具", () => {
    const s = buildSessionSettings({ role: "worker", readonly: true, ...base, projectWorktreesDir: "/Users/u/.agent-hub/worktrees/1" });
    const allow = s.permissions.allow;
    expect(allow.some((r) => /^(Edit|Write|NotebookEdit)\b/.test(r))).toBe(false);
    expect(allow.some((r) => /git -C \* (commit|push|add|reset|checkout|merge|rebase|stash|clean|rm|apply|branch)/.test(r))).toBe(false);
    expect(allow).not.toContain("Bash(*)");
    for (const rule of allow.filter((r) => r.startsWith("mcp__"))) {
      expect(rule).not.toMatch(/__(slack_send|slack_schedule|slack_create|slack_update|slack_add|slack_complete|slack_get_file_upload|send_|create_|update_|delete_|trash_|share_|copy_|forward|reply|label_|unlabel_|apply_|mark_|unmark_|untrash_|append_|batch_clear|insert_|edit|add|transition|set_)/);
    }
  });

  it("读 worktrees 的路径里有特殊字符要转义；非只读档不带这些规则", () => {
    expect(readonlyAllowRules("/Users/u/a[1]/worktrees/2/")).toContain("Read(//Users/u/a\\[1\\]/worktrees/2/**)");
    const normal = buildSessionSettings({ role: "worker", readonly: false, ...base, projectWorktreesDir: "/x/worktrees/1" });
    expect(normal.permissions.allow).toEqual([allowHub]);
  });

  it("项目经理开只读也只换档", () => {
    expect(buildSessionSettings({ role: "pm", readonly: true, ...base })).toEqual({
      permissions: { defaultMode: "dontAsk", allow: [allowHub, ...readonlyAllowRules(undefined)], deny: [...READONLY_GIT_DENY_RULES] },
      sandbox: { network: { allowUnixSockets: [base.hubSock] } },
    });
  });

  it("每次返回新对象，改了不影响下一次", () => {
    const a = buildSessionSettings({ role: "worker", readonly: true, ...base });
    a.permissions.deny!.length = 0;
    a.permissions.allow.push("Bash(*)");
    const b = buildSessionSettings({ role: "worker", readonly: true, ...base });
    expect(b.permissions.deny).toEqual([...READONLY_GIT_DENY_RULES, stateDeny]);
    expect(b.permissions.allow).not.toContain("Bash(*)");
  });
});

describe("buildForkSettings：复制出来写交接的那份", () => {
  const pm = buildSessionSettings({ role: "pm", readonly: false, ...base });

  it("在项目经理的设置上：换成 dontAsk、加 Edit(//**) 拒绝、加拦所有工具的 PreToolUse 钩子、不许关钩子；别的照留", () => {
    expect(buildForkSettings(pm)).toEqual({
      permissions: { defaultMode: READONLY_PERMISSION_MODE, allow: [allowHub], deny: ["Edit(//**)"] },
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
    const own = buildSessionSettings({ role: "pm", readonly: false, ...base });
    const before = JSON.stringify(own);
    buildForkSettings(own);
    expect(JSON.stringify(own)).toBe(before);
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MODE,
  READONLY_GIT_DENY_RULES,
  READONLY_PERMISSION_MODE,
  WORKER_ENV,
  buildSessionSettings,
  commandWritesStateDir,
  isStateDirPath,
  readonlyAllowRules,
  sessionEnv,
  stateDirDenyRule,
} from "./policy.ts";
import { HUB_COMMAND } from "./names.ts";

/** 放行 hub 的那条规则（命令名来自 names.ts）。 */
const allowHub = `Bash(${HUB_COMMAND}:*)`;

const base = { hubSock: "/private/tmp/h/run/hub.sock", stateDir: "/Users/u/.agent-hub/state" };

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
  it("和项目经理的一样，只多 state/ 的拒绝规则和 autoMemoryEnabled: false", () => {
    const pm = buildSessionSettings({ role: "pm", readonly: false, ...base });
    const worker = buildSessionSettings({ role: "worker", readonly: false, ...base });
    expect(worker).toEqual({
      ...pm,
      permissions: { ...pm.permissions, deny: [stateDirDenyRule(base.stateDir)] },
      autoMemoryEnabled: false,
    });
  });

  it("只有数据目录 state/ 的拒绝规则；记忆文件（AGENTS.md、CLAUDE.md、.claude/ 等）不再拒绝（2026-11-06 用户去掉了）", () => {
    expect(stateDirDenyRule("/Users/u/.agent-hub/state")).toBe("Edit(//Users/u/.agent-hub/state/**)");
    expect(stateDirDenyRule("/Users/u/.agent-hub/state/")).toBe("Edit(//Users/u/.agent-hub/state/**)");
    const deny = buildSessionSettings({ role: "worker", readonly: false, ...base }).permissions.deny;
    expect(deny).toEqual(["Edit(//Users/u/.agent-hub/state/**)"]);
  });

  it("isStateDirPath：只认 stateDir 本身和它下面的路径（含 ~ 展开）；记忆文件不算", () => {
    const stateDir = "/Users/u/.agent-hub/state";
    const homeDir = "/Users/u";
    for (const p of [
      "/Users/u/.agent-hub/state",
      "/Users/u/.agent-hub/state/personas/pm-1.md",
      "/Users/u/.agent-hub/work/../state/hub.sqlite",
      "~/.agent-hub/state/ui-token",
    ]) {
      expect(isStateDirPath(p, stateDir, homeDir), p).toBe(true);
    }
    for (const p of [
      "AGENTS.md",
      "/repo/CLAUDE.md",
      "/repo/GEMINI.md",
      "/repo/.claude/settings.json",
      "~/.claude/CLAUDE.md",
      "/repo/src/index.ts",
      "/Users/u/.agent-hub/worktrees/1/2/src/a.ts",
      "/Users/u/.agent-hub/state-other/a.txt",
      "",
    ]) {
      expect(isStateDirPath(p, stateDir, homeDir), p).toBe(false);
    }
  });

  it("isStateDirPath：防绕过（cwd 相对路径穿越、APFS 大小写混淆、未传 homeDir 时回退 process.env.HOME）", () => {
    const stateDir = "/Users/u/.agent-hub/state";
    const homeDir = "/Users/u";
    const cwd = "/Users/u/.agent-hub/worktrees/1/2";
    expect(isStateDirPath("../../../state/personas/pm-1.md", stateDir, homeDir, cwd)).toBe(true);
    expect(isStateDirPath("./src/index.ts", stateDir, homeDir, cwd)).toBe(false);
    expect(isStateDirPath("/Users/u/.AGENT-HUB/STATE/personas/pm-1.md", stateDir, homeDir)).toBe(true);
    expect(isStateDirPath("../../../STATE/personas/pm-1.md", stateDir, homeDir, cwd)).toBe(true);
    const realHome = process.env.HOME;
    if (realHome) {
      expect(isStateDirPath("~/.agent-hub/state/personas/pm-1.md", `${realHome}/.agent-hub/state`)).toBe(true);
      expect(isStateDirPath("~/.claude/settings.json", `${realHome}/.agent-hub/state`)).toBe(false);
    }
  });

  it("commandWritesStateDir：写 state/ 的命令算，cat/ls 读不算，写记忆文件不算", () => {
    const stateDir = "/Users/u/.agent-hub/state";
    expect(commandWritesStateDir("echo x > /Users/u/.agent-hub/state/ui-token", stateDir)).toBe(true);
    expect(commandWritesStateDir("rm -rf /Users/u/.agent-hub/state/personas", stateDir)).toBe(true);
    expect(commandWritesStateDir("cat /Users/u/.agent-hub/state/personas/pm-1.md", stateDir)).toBe(false);
    expect(commandWritesStateDir("echo x > AGENTS.md", stateDir, "/Users/u/.agent-hub/worktrees/1/2")).toBe(false);
    expect(commandWritesStateDir("sed -i s/a/b/ .claude/settings.json", stateDir)).toBe(false);
  });

  it("数据目录路径里有 gitignore 的特殊字符要转义", () => {
    expect(stateDirDenyRule("/Users/u/a[1]/b*c?d\\e/state")).toBe("Edit(//Users/u/a\\[1\\]/b\\*c\\?d\\\\e/state/**)");
  });

  it("关掉自动记忆的环境变量", () => {
    expect(WORKER_ENV).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    expect(sessionEnv("worker")).toEqual(WORKER_ENV);
  });
});

describe("buildSessionSettings：只读", () => {
  it("readonly → dontAsk 档，只多 state/ 的拒绝规则", () => {
    const worker = buildSessionSettings({ role: "worker", readonly: true, ...base });
    expect(READONLY_PERMISSION_MODE).toBe("dontAsk");
    expect(worker.permissions.defaultMode).toBe("dontAsk");
    expect(worker.permissions.allow).toEqual([allowHub, ...readonlyAllowRules(undefined)]);
    expect(worker.permissions.deny).toEqual([...READONLY_GIT_DENY_RULES, ...[stateDirDenyRule(base.stateDir)]]);
    expect(worker.autoMemoryEnabled).toBe(false);
  });

  it("只读 git 拒绝 --output（写文件）和 --ext-diff（跑外部程序）；项目经理开只读也有", () => {
    expect(READONLY_GIT_DENY_RULES).toEqual(["Bash(git * --output*)", "Bash(git * --ext-diff*)"]);
    expect(buildSessionSettings({ role: "pm", readonly: true, ...base }).permissions.deny).toEqual([...READONLY_GIT_DENY_RULES]);
    expect(buildSessionSettings({ role: "worker", readonly: false, ...base }).permissions.deny).toEqual([stateDirDenyRule(base.stateDir)]);
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

  it("写操作一条都不放行：不放行写文件、git 写命令、连接器写工具；state/ 拒绝规则照旧", () => {
    const s = buildSessionSettings({ role: "worker", readonly: true, ...base, projectWorktreesDir: "/Users/u/.agent-hub/worktrees/1" });
    const allow = s.permissions.allow;
    expect(allow.some((r) => /^(Edit|Write|NotebookEdit)\b/.test(r))).toBe(false);
    expect(allow.some((r) => /git -C \* (commit|push|add|reset|checkout|merge|rebase|stash|clean|rm|apply|branch)/.test(r))).toBe(false);
    expect(allow).not.toContain("Bash(*)");
    for (const rule of allow.filter((r) => r.startsWith("mcp__"))) {
      expect(rule).not.toMatch(/__(slack_send|slack_schedule|slack_create|slack_update|slack_add|slack_complete|slack_get_file_upload|send_|create_|update_|delete_|trash_|share_|copy_|forward|reply|label_|unlabel_|apply_|mark_|unmark_|untrash_|append_|batch_clear|insert_|edit|add|transition|set_)/);
    }
    expect(s.permissions.deny).toEqual(expect.arrayContaining([stateDirDenyRule(base.stateDir)]));
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
    const a = buildSessionSettings({ role: "worker", readonly: false, ...base });
    a.permissions.deny!.length = 0;
    a.permissions.allow.push("Bash(*)");
    const b = buildSessionSettings({ role: "worker", readonly: false, ...base });
    expect(b.permissions.deny).toEqual([stateDirDenyRule(base.stateDir)]);
    expect(b.permissions.allow).toEqual([allowHub]);
  });
});

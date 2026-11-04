import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MODE,
  READONLY_PERMISSION_MODE,
  WORKER_ENV,
  WORKER_MEMORY_DENY_RULES,
  buildSessionSettings,
  readonlyAllowRules,
  sessionEnv,
  stateDirDenyRule,
  workerMemoryDenyRules,
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
  it("和项目经理的一样，只多记忆规则和 autoMemoryEnabled: false", () => {
    const pm = buildSessionSettings({ role: "pm", readonly: false, ...base });
    const worker = buildSessionSettings({ role: "worker", readonly: false, ...base });
    expect(worker).toEqual({
      ...pm,
      permissions: { ...pm.permissions, deny: workerMemoryDenyRules(base.stateDir) },
      autoMemoryEnabled: false,
    });
  });

  it("记忆规则：整台机器上任何位置的约定文件和 .claude/（工作目录、附加文件夹都算）、用户级 ~/.claude/、数据目录的 state/", () => {
    // 相对写法（Edit(AGENTS.md)）只锚在当前目录，附加文件夹里的拦不住（审查实测），所以一律用 // 开头的绝对通配
    expect(WORKER_MEMORY_DENY_RULES).toEqual([
      "Edit(//**/AGENTS.md)",
      "Edit(//**/CLAUDE.md)",
      "Edit(//**/CLAUDE.local.md)",
      "Edit(//**/.claude/**)",
      "Edit(~/.claude/**)",
    ]);
    // 绝对路径的写法是 // 开头
    expect(stateDirDenyRule("/Users/u/.agent-hub/state")).toBe("Edit(//Users/u/.agent-hub/state/**)");
    expect(stateDirDenyRule("/Users/u/.agent-hub/state/")).toBe("Edit(//Users/u/.agent-hub/state/**)");
    expect(workerMemoryDenyRules(base.stateDir)).toEqual([...WORKER_MEMORY_DENY_RULES, "Edit(//Users/u/.agent-hub/state/**)"]);
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
  it("readonly → dontAsk 档，记忆规则一条不少", () => {
    const worker = buildSessionSettings({ role: "worker", readonly: true, ...base });
    expect(READONLY_PERMISSION_MODE).toBe("dontAsk");
    expect(worker.permissions.defaultMode).toBe("dontAsk");
    expect(worker.permissions.allow).toEqual([allowHub, ...readonlyAllowRules(undefined)]);
    expect(worker.permissions.deny).toEqual(workerMemoryDenyRules(base.stateDir));
    expect(worker.autoMemoryEnabled).toBe(false);
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

  it("写操作一条都不放行：不放行写文件、git 写命令、连接器写工具；记忆拒绝规则照旧", () => {
    const s = buildSessionSettings({ role: "worker", readonly: true, ...base, projectWorktreesDir: "/Users/u/.agent-hub/worktrees/1" });
    const allow = s.permissions.allow;
    expect(allow.some((r) => /^(Edit|Write|NotebookEdit)\b/.test(r))).toBe(false);
    expect(allow.some((r) => /git -C \* (commit|push|add|reset|checkout|merge|rebase|stash|clean|rm|apply|branch)/.test(r))).toBe(false);
    expect(allow).not.toContain("Bash(*)");
    for (const rule of allow.filter((r) => r.startsWith("mcp__"))) {
      expect(rule).not.toMatch(/__(slack_send|slack_schedule|slack_create|slack_update|slack_add|slack_complete|slack_get_file_upload|send_|create_|update_|delete_|trash_|share_|copy_|forward|reply|label_|unlabel_|apply_|mark_|unmark_|untrash_|append_|batch_clear|insert_|edit|add|transition|set_)/);
    }
    expect(s.permissions.deny).toEqual(workerMemoryDenyRules(base.stateDir));
  });

  it("读 worktrees 的路径里有特殊字符要转义；非只读档不带这些规则", () => {
    expect(readonlyAllowRules("/Users/u/a[1]/worktrees/2/")).toContain("Read(//Users/u/a\\[1\\]/worktrees/2/**)");
    const normal = buildSessionSettings({ role: "worker", readonly: false, ...base, projectWorktreesDir: "/x/worktrees/1" });
    expect(normal.permissions.allow).toEqual([allowHub]);
  });

  it("项目经理开只读也只换档", () => {
    expect(buildSessionSettings({ role: "pm", readonly: true, ...base })).toEqual({
      permissions: { defaultMode: "dontAsk", allow: [allowHub, ...readonlyAllowRules(undefined)] },
      sandbox: { network: { allowUnixSockets: [base.hubSock] } },
    });
  });

  it("每次返回新对象，改了不影响下一次", () => {
    const a = buildSessionSettings({ role: "worker", readonly: false, ...base });
    a.permissions.deny!.length = 0;
    a.permissions.allow.push("Bash(*)");
    const b = buildSessionSettings({ role: "worker", readonly: false, ...base });
    expect(b.permissions.deny).toEqual(workerMemoryDenyRules(base.stateDir));
    expect(b.permissions.allow).toEqual([allowHub]);
  });
});

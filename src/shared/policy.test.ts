import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MODE,
  READONLY_PERMISSION_MODE,
  WORKER_ENV,
  WORKER_MEMORY_DENY_RULES,
  buildSessionSettings,
  sessionEnv,
  stateDirDenyRule,
  workerMemoryDenyRules,
} from "./policy.ts";

const base = { hubSock: "/private/tmp/h/run/hub.sock", stateDir: "/Users/u/.agent-hub/state" };

describe("buildSessionSettings：项目经理", () => {
  it("auto 档；放行 hub 和 hub.sock；没有任何拒绝规则；不碰自动记忆", () => {
    const settings = buildSessionSettings({ role: "pm", readonly: false, ...base });
    expect(settings).toEqual({
      permissions: { defaultMode: "auto", allow: ["Bash(hub:*)"] },
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

  it("记忆规则：约定文件（任何深度）、.claude/、用户级 ~/.claude/、数据目录的 state/", () => {
    expect(WORKER_MEMORY_DENY_RULES).toEqual([
      "Edit(AGENTS.md)",
      "Edit(CLAUDE.md)",
      "Edit(CLAUDE.local.md)",
      "Edit(.claude/**)",
      "Edit(~/.claude/**)",
    ]);
    // 绝对路径的写法是 // 开头
    expect(stateDirDenyRule("/Users/u/.agent-hub/state")).toBe("Edit(//Users/u/.agent-hub/state/**)");
    expect(stateDirDenyRule("/Users/u/.agent-hub/state/")).toBe("Edit(//Users/u/.agent-hub/state/**)");
    expect(workerMemoryDenyRules(base.stateDir)).toEqual([...WORKER_MEMORY_DENY_RULES, "Edit(//Users/u/.agent-hub/state/**)"]);
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
    expect(worker.permissions.allow).toEqual(["Bash(hub:*)"]);
    expect(worker.permissions.deny).toEqual(workerMemoryDenyRules(base.stateDir));
    expect(worker.autoMemoryEnabled).toBe(false);
  });

  it("项目经理开只读也只换档", () => {
    expect(buildSessionSettings({ role: "pm", readonly: true, ...base })).toEqual({
      permissions: { defaultMode: "dontAsk", allow: ["Bash(hub:*)"] },
      sandbox: { network: { allowUnixSockets: [base.hubSock] } },
    });
  });

  it("每次返回新对象，改了不影响下一次", () => {
    const a = buildSessionSettings({ role: "worker", readonly: false, ...base });
    a.permissions.deny!.length = 0;
    a.permissions.allow.push("Bash(*)");
    const b = buildSessionSettings({ role: "worker", readonly: false, ...base });
    expect(b.permissions.deny).toEqual(workerMemoryDenyRules(base.stateDir));
    expect(b.permissions.allow).toEqual(["Bash(hub:*)"]);
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_VENDORS,
  EMPTY_TOKEN_USAGE,
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  vendorSpec,
  type AgentSessionRow,
} from "../../shared/index.ts";
import {
  cleanupRouterLaunchDir,
  createRouterSandboxGuard,
  ensureRouterHomeDir,
  prepareRouterSandboxLaunch,
} from "./sandbox.ts";

let root: string;
let dataDir: string;
let stateDir: string;
let launchDir: string;
let homeDir: string;
let hubBinDir: string;
let hubSock: string;

function makeAssistantSession(overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  const routerHome = ensureRouterHomeDir(stateDir);
  return {
    id: 901,
    role: "assistant",
    conversationId: null,
    pmId: null,
    workerId: null,
    vendor: "claude",
    vendorSessionId: "00000000-0000-4000-8000-000000000901",
    cwd: routerHome,
    addDirs: [],
    generation: 1,
    model: "claude-haiku-4-5",
    effort: "low",
    pid: null,
    status: "idle",
    hasCompletedTurn: false,
    lastEventAt: null,
    rateLimit: null,
    usage: { ...EMPTY_TOKEN_USAGE },
    personaRevision: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-router-sandbox-")));
  dataDir = join(root, ".agent-hub");
  stateDir = join(dataDir, "state");
  launchDir = join(dataDir, "launch");
  homeDir = join(root, "home");
  hubBinDir = join(dataDir, "bin");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(launchDir, { recursive: true, mode: 0o700 });
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  mkdirSync(hubBinDir, { recursive: true, mode: 0o700 });
  hubSock = join(dataDir, "run", "hub.sock");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Router 轨道 B 只读沙箱与令牌权限守卫", () => {
  it("ensureRouterHomeDir 建立 0700 隔离空目录，且全部 6 家厂商统一产出只读 LaunchFiles（零厂商硬编码）", () => {
    const routerHome = ensureRouterHomeDir(stateDir);
    expect(existsSync(routerHome)).toBe(true);
    if (process.platform !== "win32") expect(statSync(routerHome).mode & 0o777).toBe(0o700);

    for (const [idx, vendor] of AGENT_VENDORS.entries()) {
      const session = makeAssistantSession({ id: 1000 + idx, vendor, model: null, effort: "low" });
      const files = prepareRouterSandboxLaunch(session, {
        launchDir,
        dataDir,
        stateDir,
        homeDir,
        osSandboxed: true,
        tokens: { issue: (id) => `tok-${id}` },
        hubSock,
        hubBinDir,
        basePath: "/usr/bin:/bin",
      });

      expect(existsSync(files.promptFile)).toBe(true);
      const promptText = readFileSync(files.promptFile, "utf8");
      expect(promptText).toContain("四不准硬规矩");
      expect(promptText).toContain("dispatch pm");
      expect(files.env[ENV_HUB_TOKEN]).toBe(`tok-${session.id}`);
      expect(files.env[ENV_HUB_SOCK]).toBe(hubSock);
      expect(files.env.PATH).toBe(`${hubBinDir}:/usr/bin:/bin`);
      expect(files.readonly).toBeDefined();
      expect(files.readonly!.secretPaths.some((p) => p.includes(stateDir))).toBe(true);

      if (vendorSpec(vendor).capabilities.readonly === "settings") {
        expect(files.settingsFile).toBeDefined();
        const settingsJson = readFileSync(files.settingsFile!, "utf8");
        expect(settingsJson).toContain(hubSock);
        expect(files.writeScope).toBeUndefined();
      } else {
        expect(files.writeScope).toBeDefined();
      }

      cleanupRouterLaunchDir(launchDir, session.id);
      expect(existsSync(join(launchDir, String(session.id)))).toBe(false);
    }
  });

  it("严拒非隔离 cwd、挂载了业务目录（addDirs）或绑定了对话的会话进入 Router 沙箱", () => {
    expect(() =>
      prepareRouterSandboxLaunch(makeAssistantSession({ cwd: homeDir }), {
        launchDir,
        dataDir,
        stateDir,
        homeDir,
        tokens: { issue: () => "tok" },
        hubSock,
        hubBinDir,
      }),
    ).toThrow(/router-home/);

    expect(() =>
      prepareRouterSandboxLaunch(makeAssistantSession({ addDirs: ["/Users/someone/repo"] }), {
        launchDir,
        dataDir,
        stateDir,
        homeDir,
        tokens: { issue: () => "tok" },
        hubSock,
        hubBinDir,
      }),
    ).toThrow(/addDirs/);

    expect(() =>
      prepareRouterSandboxLaunch(makeAssistantSession({ role: "pm" }), {
        launchDir,
        dataDir,
        stateDir,
        homeDir,
        tokens: { issue: () => "tok" },
        hubSock,
        hubBinDir,
      }),
    ).toThrow(/assistant/);
  });

  it("RouterSandboxGuard 双向拦截：assistant 严禁调普通命令，pm/worker 与过期会话严禁调 hub dispatch", () => {
    const guard = createRouterSandboxGuard();
    guard.bind(901, 77);

    // 1. 活跃 assistant 会话可正常通过 dispatch 校验并拿到绑定的 commandId
    expect(guard.assertCanDispatch(901, "assistant")).toBe(77);

    // 2. assistant 会话调普通 hub 命令一律拒绝
    expect(() => guard.assertRegularHubAllowed("assistant")).toThrow(/严禁调用普通/);
    expect(() => guard.assertRegularHubAllowed("pm")).not.toThrow();
    expect(() => guard.assertRegularHubAllowed("worker")).not.toThrow();

    // 3. pm / worker 会话调 hub dispatch 一律拒绝
    expect(() => guard.assertCanDispatch(10, "pm")).toThrow(/只有总助/);
    expect(() => guard.assertCanDispatch(11, "worker")).toThrow(/只有总助/);

    // 4. unbind 后原 assistant 会话立刻失效
    guard.unbind(901);
    expect(guard.commandOf(901)).toBeNull();
    expect(() => guard.assertCanDispatch(901, "assistant")).toThrow(/已过期|未绑定/);
  });
});

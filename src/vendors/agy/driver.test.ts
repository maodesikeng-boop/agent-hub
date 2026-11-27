import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RequestPermissionRequest, SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import { readJsonLog } from "../../../test/append-log.ts";
import { MemorySessionStore } from "../../daemon/driver/test-helpers.ts";
import { WORKER_NEEDS_OS_SANDBOX_MESSAGE, type ReadonlySandboxInput } from "../../daemon/driver/write-scope.ts";
import {
  DriverError,
  EMPTY_TOKEN_USAGE,
  buildReadonlyPolicy,
  type AgentSessionRow,
  type DriverEvent,
  type LaunchFiles,
  type ReadonlyPolicy,
  type SessionCapabilities,
  type SessionId,
} from "../../shared/index.ts";
import { decideAcpPermission, type AcpLaunchContext } from "../_common/acp/index.ts";
import type { FakeAcpLogEntry, FakeAcpScript } from "../_common/acp/fixtures/fake-acp-agent.ts";
import {
  AGY_ACP_WRITE_TOOL_NAMES,
  buildAgyAcpAdditionalDirs,
  buildAgyAcpLaunchArgs,
  buildAgyWorkspaceHooks,
  extractAgyAcpMcpTool,
  matchesAgyAcpStaleProcess,
  resolveAgyAcpModelAndEffort,
} from "./acp-config.ts";
import { createAgyDriver } from "./driver.ts";
import { buildAgyUserLine, checkAgyUserLine, detectAgyArgsConflict, parseAgyUsage } from "./protocol.ts";

const FAKE_ACP_AGENT = fileURLToPath(new URL("../_common/acp/fixtures/fake-acp-agent.ts", import.meta.url));
const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanupDirs.push(dir);
  return dir;
}

function makeRow(overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  const now = Date.now();
  return {
    id: 1 as SessionId,
    conversationId: 1,
    pmId: 1,
    workerId: null,
    role: "pm",
    vendor: "agy",
    model: "gemini-3.8-flash",
    effort: "low",
    cwd: "/Users/alice/agent-hub",
    addDirs: [],
    vendorSessionId: "",
    generation: 1,
    status: "idle",
    pid: null,
    hasCompletedTurn: false,
    personaRevision: 0,
    usage: { ...EMPTY_TOKEN_USAGE },
    rateLimit: null,
    createdAt: now,
    updatedAt: now,
    lastEventAt: now,
    ...overrides,
  };
}

function makeFakeAcpEnv(
  dir: string,
  script: FakeAcpScript,
): { scriptFile: string; logFile: string; stateDir: string; env: Record<string, string> } {
  const scriptFile = join(dir, "script.json");
  const logFile = join(dir, "acp.jsonl");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(scriptFile, JSON.stringify(script), "utf8");
  return {
    scriptFile,
    logFile,
    stateDir,
    env: {
      FAKE_ACP_SCRIPT: scriptFile,
      FAKE_ACP_LOG: logFile,
      FAKE_ACP_STATE: stateDir,
      PATH: process.env.PATH ?? "",
    },
  };
}

function makeLaunchFiles(
  dir: string,
  overrides: {
    prompt?: string;
    skillsDir?: string;
    env?: Record<string, string>;
    fingerprint?: string;
    readonly?: ReadonlyPolicy;
    tmpDir?: string;
    capabilities?: SessionCapabilities;
  } = {},
): LaunchFiles {
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, overrides.prompt ?? "Follow project rules.\n", "utf8");
  const base = {
    promptFile,
    env: overrides.env ?? {},
    fingerprint: overrides.fingerprint ?? "fp-1",
    ...(overrides.skillsDir ? { skillsDir: overrides.skillsDir } : {}),
    ...(overrides.capabilities ? { capabilities: overrides.capabilities } : {}),
  };
  if (overrides.readonly !== undefined) {
    const tmp = overrides.tmpDir ?? join(dir, "tmp");
    mkdirSync(tmp, { recursive: true });
    return { ...base, readonly: overrides.readonly, tmpDir: tmp };
  }
  return base;
}

function waitForEventCount(
  driver: ReturnType<typeof createAgyDriver>,
  events: DriverEvent[],
  type: DriverEvent["type"],
  count: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const check = () => {
      if (events.filter((e) => e.type === type).length >= count) resolve();
    };
    driver.onEvent(() => check());
    check();
  });
}

describe("agy ACP pure helpers", () => {
  it("buildAgyAcpLaunchArgs separates normal and readonly permission flags", () => {
    const root = tempDir("agy-args-");
    const row = makeRow({ cwd: root });
    const normalCtx: AcpLaunchContext = {
      row,
      files: makeLaunchFiles(root),
      resume: false,
      executablePath: "agy",
    };
    expect(buildAgyAcpLaunchArgs(normalCtx)).toEqual(["acp", "--sandbox=false", "--dangerously-skip-permissions"]);

    const roCtx: AcpLaunchContext = {
      ...normalCtx,
      files: makeLaunchFiles(root, { readonly: buildReadonlyPolicy({ homeDir: root, stateDir: join(root, "s") }) }),
    };
    expect(buildAgyAcpLaunchArgs(roCtx)).toEqual(["acp", "--sandbox=false"]);
  });

  it("buildAgyAcpAdditionalDirs trims, deduplicates, and excludes primary cwd across POSIX and Windows paths", () => {
    const row = makeRow({
      cwd: "/Users/alice/proj/",
      addDirs: ["  ", "/Users/alice/aaa", "/Users/alice/proj", "/Users/alice/aaa/"],
    });
    const ctx: AcpLaunchContext = {
      row,
      files: { promptFile: "/tmp/p.md", env: {}, fingerprint: "fp" },
      resume: false,
      executablePath: "agy",
    };
    expect(buildAgyAcpAdditionalDirs(ctx, "/Users/alice/.agent-hub/state/launch/1/agy-rules")).toEqual([
      "/Users/alice/aaa",
      "/Users/alice/.agent-hub/state/launch/1/agy-rules",
    ]);

    const winCtx: AcpLaunchContext = {
      ...ctx,
      row: makeRow({ cwd: "D:\\Work\\Repo\\", addDirs: ["d:\\work\\repo", "C:\\extra\\dir"] }),
    };
    expect(buildAgyAcpAdditionalDirs(winCtx, "C:\\Users\\a\\.agent-hub\\state\\launch\\1\\agy-rules")).toEqual([
      "C:\\extra\\dir",
      "C:\\Users\\a\\.agent-hub\\state\\launch\\1\\agy-rules",
    ]);
  });

  it("buildAgyWorkspaceHooks builds deny-only hooks and call_mcp_tool guard filters only denied servers", () => {
    const caps: SessionCapabilities = {
      deny: { mcp: ["github", "my-srv"], skills: [], connectors: [], plugins: [], pluginOf: { skills: {}, mcp: {} } },
      allow: { skills: [], mcp: [] },
    };
    const hooks = buildAgyWorkspaceHooks({ readonly: true, capabilities: caps, platform: process.platform });
    expect(JSON.stringify(hooks)).not.toContain('"decision":"allow"');

    const mcpGroup = hooks["bellwood-mcp-deny"] as {
      PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    };
    const flatRule = mcpGroup.PreToolUse[0]!;
    const flatRe = new RegExp(flatRule.matcher);
    expect(flatRe.test("mcp_github_create_issue")).toBe(true);
    expect(flatRe.test("mcp_my_srv_run")).toBe(true);
    expect(flatRe.test("mcp_slack_post")).toBe(false);

    const callRule = mcpGroup.PreToolUse[1]!;
    expect(callRule.matcher).toBe("^call_mcp_tool$");
    const cmd = callRule.hooks[0]!.command;
    const match = /^node -e "(.+)"$/.exec(cmd);
    expect(match).not.toBeNull();

    const deniedOut = execFileSync(process.execPath, ["-e", match![1]!], {
      input: JSON.stringify({ tool_input: { ServerName: "github", ToolName: "create_issue" } }),
      encoding: "utf8",
    });
    expect(JSON.parse(deniedOut)).toMatchObject({ decision: "deny" });

    const allowedOut = execFileSync(process.execPath, ["-e", match![1]!], {
      input: JSON.stringify({ tool_input: { ServerName: "slack", ToolName: "list_channels" } }),
      encoding: "utf8",
    });
    expect(allowedOut.trim()).toBe("");
  });

  it("extractAgyAcpMcpTool parses call_mcp_tool, mcp_<server>_<tool>, and fails closed on missing ServerName", async () => {
    const policy = buildReadonlyPolicy({ homeDir: "/tmp/home", stateDir: "/tmp/state" });
    const flatReq = {
      sessionId: "s-1",
      toolCall: {
        toolCallId: "t-flat",
        name: "mcp_github_list_issues",
        title: "mcp_github_list_issues",
        kind: "other",
        _meta: { annotations: { readOnlyHint: true } },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    } as unknown as RequestPermissionRequest;
    expect(extractAgyAcpMcpTool(flatReq)).toEqual({
      server: "github",
      tool: "list_issues",
      annotations: { readOnlyHint: true },
    });

    const missingServerReq = {
      sessionId: "s-1",
      toolCall: {
        toolCallId: "t-missing",
        name: "call_mcp_tool",
        title: "call_mcp_tool",
        kind: "execute",
        rawInput: {},
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    } as unknown as RequestPermissionRequest;
    expect(extractAgyAcpMcpTool(missingServerReq)).toEqual({ server: "?", tool: "?", annotations: null });
    const decision = await decideAcpPermission(
      { request: missingServerReq, readonlyPolicy: policy, closing: false, signal: new AbortController().signal },
      { extractMcpTool: extractAgyAcpMcpTool, writeToolNames: AGY_ACP_WRITE_TOOL_NAMES },
    );
    expect(decision).toEqual({ outcome: "selected", optionId: "reject" });

    const builtinReq = {
      sessionId: "s-1",
      toolCall: { toolCallId: "t-read", name: "read_file", title: "Read file", kind: "read" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    } as unknown as RequestPermissionRequest;
    expect(extractAgyAcpMcpTool(builtinReq)).toBeNull();
  });

  it("resolveAgyAcpModelAndEffort handles combined IDs, explicit effort override, and already-current options", () => {
    const options: SessionConfigOption[] = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gemini-4-neon",
        options: [
          { value: "gemini-4-neon", name: "Gemini 4 Neon" },
          { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        ],
      },
      {
        id: "thought_level",
        name: "Thinking Level",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ];
    expect(resolveAgyAcpModelAndEffort({ model: "gemini-3.8-flash-low", effort: "medium", options })).toEqual([
      { configId: "model", value: "gemini-3.8-flash" },
      { configId: "thought_level", value: "medium" },
    ]);
    expect(resolveAgyAcpModelAndEffort({ model: "gemini-4-neon", effort: "high", options })).toEqual([]);
    expect(resolveAgyAcpModelAndEffort({ model: "  ", effort: " ", options })).toEqual([]);
  });

  it("matchesAgyAcpStaleProcess matches only Bellwood agy acp --sandbox=false processes", () => {
    const row = makeRow();
    expect(matchesAgyAcpStaleProcess("/usr/local/bin/agy acp --sandbox=false --dangerously-skip-permissions", row, "/usr/local/bin/agy")).toBe(true);
    expect(matchesAgyAcpStaleProcess("/usr/local/bin/agy --sandbox=false acp --sandbox=false", row, "/usr/local/bin/agy")).toBe(true);
    expect(matchesAgyAcpStaleProcess("C:\\Users\\u\\bin\\agy.exe acp --sandbox=false", row, "C:\\Users\\u\\bin\\agy.exe")).toBe(true);
    expect(matchesAgyAcpStaleProcess("/usr/local/bin/agy acp", row, "/usr/local/bin/agy")).toBe(false);
    expect(matchesAgyAcpStaleProcess("/usr/local/bin/agy", row, "/usr/local/bin/agy")).toBe(false);
    expect(matchesAgyAcpStaleProcess("/usr/local/bin/agy acp --sandbox=false", makeRow({ vendor: "claude" }), "/usr/local/bin/agy")).toBe(false);
  });

  it("handover protocol helpers validate user lines, conflict text, and usage parsing", () => {
    const line = buildAgyUserLine("交接\u2028正文");
    expect(checkAgyUserLine(line)).toBeNull();
    expect(checkAgyUserLine("not json")).not.toBeNull();
    expect(checkAgyUserLine(`${line}\n`)).not.toBeNull();
    expect(detectAgyArgsConflict("Error: conversation not found")).toBe("no_conversation");
    expect(detectAgyArgsConflict("other error")).toBeNull();
    expect(parseAgyUsage({ input_tokens: 10, cache_read_tokens: 50, cache_write_tokens: 5, output_tokens: 20 })).toEqual({
      input: 10,
      cacheRead: 50,
      cacheWrite: 5,
      output: 20,
    });
  });
});

describe("createAgyDriver ACP integration", () => {
  it("prepares launch workspace rules, skills, hooks, emits budget warning, and keeps primary cwd", async () => {
    const root = tempDir("agy-drv-launch-");
    const homeDir = join(root, "home");
    const projectDir = join(root, "zzz-proj");
    const launchDir = join(root, ".agent-hub", "state", "launch", "1");
    const skillsDir = join(root, "skills");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(launchDir, { recursive: true });
    mkdirSync(join(skillsDir, "fusa-task-graph"), { recursive: true });
    writeFileSync(join(skillsDir, "fusa-task-graph", "SKILL.md"), "---\nname: fusa-task-graph\n---\nBody\n");
    writeFileSync(join(projectDir, "AGENTS.md"), "x".repeat(25_000), "utf8");

    const { logFile, env } = makeFakeAcpEnv(root, {
      additionalDirectoriesCapability: true,
      initialConfigOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gemini-4-neon",
          options: [
            { value: "gemini-4-neon", name: "Gemini 4 Neon" },
            { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
          ],
        },
        {
          id: "thought_level",
          name: "Thinking Level",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
      turns: [{ textChunks: ["ok"] }],
    });

    const store = new MemorySessionStore();
    const row = makeRow({ cwd: projectDir, model: "gemini-3.8-flash-low", effort: null });
    store.add(row);
    const events: DriverEvent[] = [];
    const driver = createAgyDriver({
      executablePath: FAKE_ACP_AGENT,
      homeDir,
      store,
      prepareLaunch: async () => makeLaunchFiles(launchDir, { env, skillsDir }),
      log: () => {},
    });
    driver.onEvent((_id, ev) => events.push(ev));

    try {
      const done = waitForEventCount(driver, events, "turn.ended", 1);
      await driver.send(row.id, { messageIds: [1], source: "user", text: "hi" });
      await done;

      const workspace = join(launchDir, "agy-rules");
      expect(existsSync(join(workspace, ".agents", "rules", "fusa-01.md"))).toBe(true);
      expect(existsSync(join(workspace, ".agents", "skills", "fusa-task-graph", "SKILL.md"))).toBe(true);
      expect(existsSync(join(workspace, ".agents", "hooks.json"))).toBe(true);
      expect(events.some((e) => e.type === "driver.warning" && e.message.includes("agy 规则预算告警"))).toBe(true);

      const logs = readJsonLog<FakeAcpLogEntry>(logFile);
      const spawn = logs.find((e) => e.event === "spawn");
      expect(spawn?.argv).toEqual(["acp", "--sandbox=false", "--dangerously-skip-permissions"]);
      const sessionNew = logs.find((e) => e.event === "session/new")?.params as Record<string, unknown>;
      expect(sessionNew.cwd).toBe(projectDir);
      expect(sessionNew.additionalDirectories).toEqual([workspace]);

      const configCalls = logs.filter((e) => e.event === "session/set_config_option");
      expect(configCalls.map((c) => [c.configId, c.value])).toEqual([
        ["model", "gemini-3.8-flash"],
        ["thought_level", "low"],
      ]);
    } finally {
      await driver.shutdown();
    }
  });

  it("restarts and rewrites hooks.json + additionalDirectories when addDirs or capabilities fingerprint changes", async () => {
    const root = tempDir("agy-drv-relaunch-");
    const projectDir = join(root, "zzz-app");
    const earlyFolder = join(root, "aaa-shared");
    const launchDir = join(root, ".agent-hub", "state", "launch", "2");
    for (const d of [projectDir, earlyFolder, launchDir]) mkdirSync(d, { recursive: true });

    const { logFile, env } = makeFakeAcpEnv(root, {
      resumeCapability: true,
      additionalDirectoriesCapability: true,
      turns: [{ textChunks: ["first"] }, { textChunks: ["second"] }],
    });

    const store = new MemorySessionStore();
    const row = makeRow({ id: 2 as SessionId, cwd: projectDir, addDirs: [] });
    store.add(row);
    let fingerprint = "fp-1";
    let caps: SessionCapabilities | undefined;
    const events: DriverEvent[] = [];
    const driver = createAgyDriver({
      executablePath: FAKE_ACP_AGENT,
      homeDir: root,
      store,
      prepareLaunch: async () => makeLaunchFiles(launchDir, { env, fingerprint, capabilities: caps }),
      log: () => {},
    });
    driver.onEvent((_id, ev) => events.push(ev));

    try {
      const t1 = waitForEventCount(driver, events, "turn.ended", 1);
      await driver.send(row.id, { messageIds: [1], source: "user", text: "turn 1" });
      await t1;

      store.set(row.id, { addDirs: [earlyFolder] });
      fingerprint = "fp-2";
      caps = {
        deny: { mcp: ["github"], skills: [], connectors: [], plugins: [], pluginOf: { skills: {}, mcp: {} } },
        allow: { skills: [], mcp: [] },
      };

      const t2 = waitForEventCount(driver, events, "turn.ended", 2);
      await driver.send(row.id, { messageIds: [2], source: "user", text: "turn 2" });
      await t2;

      const hooksJson = readFileSync(join(launchDir, "agy-rules", ".agents", "hooks.json"), "utf8");
      expect(hooksJson).toContain("github");
      const logs = readJsonLog<FakeAcpLogEntry>(logFile);
      const resumed = logs.find((e) => e.event === "session/resume")?.params as Record<string, unknown>;
      expect(resumed.cwd).toBe(projectDir);
      expect(resumed.additionalDirectories).toEqual([earlyFolder, join(launchDir, "agy-rules")]);
    } finally {
      await driver.shutdown();
    }
  });

  it("enforces read-only outer OS sandbox, rejects write/schedule/subagent/write-MCP permissions, and fails closed if OS sandbox unavailable", async () => {
    const root = tempDir("agy-drv-ro-");
    const homeDir = join(root, "home");
    const projectDir = join(root, "proj");
    const launchDir = join(root, "launch");
    for (const d of [homeDir, projectDir, launchDir]) mkdirSync(d, { recursive: true });

    const { logFile, env } = makeFakeAcpEnv(root, {
      additionalDirectoriesCapability: true,
      turns: [
        {
          toolCalls: [
            {
              toolCallId: "t-write",
              name: "write_file",
              title: "Write file",
              kind: "edit",
              requestPermission: { kind: "edit", name: "write_file" },
            },
            {
              toolCallId: "t-sched",
              name: "schedule",
              title: "schedule",
              kind: "execute",
              requestPermission: { kind: "execute", name: "schedule" },
            },
            {
              toolCallId: "t-sub",
              name: "invoke_subagent",
              title: "invoke_subagent",
              kind: "execute",
              requestPermission: { kind: "execute", name: "invoke_subagent" },
            },
            {
              toolCallId: "t-mcp-ro",
              name: "call_mcp_tool",
              title: "Call MCP tool github/list_issues",
              kind: "other",
              rawInput: { ServerName: "github", ToolName: "list_issues" },
              requestPermission: {
                kind: "other",
                name: "call_mcp_tool",
                meta: { annotations: { readOnlyHint: true } },
              },
            },
          ],
          textChunks: ["done"],
        },
      ],
    });

    const policy = buildReadonlyPolicy({ homeDir, stateDir: join(root, "state") });
    const capturedInputs: ReadonlySandboxInput[] = [];
    const store = new MemorySessionStore();
    const row = makeRow({ id: 3 as SessionId, role: "worker", pmId: null, workerId: 9, cwd: projectDir });
    store.add(row);
    const events: DriverEvent[] = [];
    const driver = createAgyDriver({
      executablePath: FAKE_ACP_AGENT,
      homeDir,
      store,
      prepareLaunch: async () => makeLaunchFiles(launchDir, { env, readonly: policy }),
      readonlySpawn: (base, input) => {
        capturedInputs.push(input);
        return { command: base.command, args: base.args, osSandboxed: true };
      },
      log: () => {},
    });
    driver.onEvent((_id, ev) => events.push(ev));

    try {
      const done = waitForEventCount(driver, events, "turn.ended", 1);
      await driver.send(row.id, { messageIds: [1], source: "user", text: "inspect" });
      await done;

      expect(capturedInputs).toHaveLength(1);
      expect(capturedInputs[0]!.writableDirs.some((d) => d.includes("conversations"))).toBe(true);
      expect(capturedInputs[0]!.writableFileGlobs?.some((g) => g.includes("agentapi"))).toBe(true);
      if (process.platform === "darwin") {
        expect(capturedInputs[0]!.secretPaths.some((p) => p.endsWith("Library/Keychains"))).toBe(false);
      }

      const logs = readJsonLog<FakeAcpLogEntry>(logFile);
      const spawn = logs.find((e) => e.event === "spawn");
      expect(spawn?.argv).not.toContain("--dangerously-skip-permissions");
      expect(spawn?.argv).toContain("--sandbox=false");

      const outcomes = Object.fromEntries(
        logs
          .filter((e) => e.event === "permission_outcome")
          .map((e) => [e.toolCallId as string, (e.outcome as { optionId?: string }).optionId]),
      );
      expect(outcomes["t-write"]).toBe("reject-once");
      expect(outcomes["t-sched"]).toBe("reject-once");
      expect(outcomes["t-sub"]).toBe("reject-once");
      expect(outcomes["t-mcp-ro"]).toBe("allow-once");
    } finally {
      await driver.shutdown();
    }

    const blockedStore = new MemorySessionStore();
    const blockedRow = makeRow({ id: 4 as SessionId, role: "worker", pmId: null, workerId: 10, cwd: projectDir });
    blockedStore.add(blockedRow);
    const blockedDriver = createAgyDriver({
      executablePath: FAKE_ACP_AGENT,
      homeDir,
      store: blockedStore,
      prepareLaunch: async () => makeLaunchFiles(launchDir, { env, readonly: policy }),
      readonlySpawn: (base) => ({ command: base.command, args: base.args, osSandboxed: false }),
      log: () => {},
    });
    try {
      const err = await blockedDriver
        .send(blockedRow.id, { messageIds: [1], source: "user", text: "inspect" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DriverError);
      expect((err as DriverError).code).toBe("spawn_failed");
      expect((err as DriverError).message).toContain(WORKER_NEEDS_OS_SANDBOX_MESSAGE);
    } finally {
      await blockedDriver.shutdown();
    }
  });

  it("handles empty prompt files gracefully and ignores malformed update_steps payloads", async () => {
    const root = tempDir("agy-drv-dirty-");
    const projectDir = join(root, "proj");
    const launchDir = join(root, "launch");
    for (const d of [projectDir, launchDir]) mkdirSync(d, { recursive: true });

    const { env } = makeFakeAcpEnv(root, {
      additionalDirectoriesCapability: true,
      turns: [
        {
          toolCalls: [
            {
              toolCallId: "bad-steps",
              name: "update_steps",
              title: "update_steps",
              kind: "other",
              rawInput: { steps: "not-an-array" },
            },
          ],
          textChunks: ["ok"],
        },
      ],
    });

    const store = new MemorySessionStore();
    const row = makeRow({ id: 5 as SessionId, cwd: projectDir });
    store.add(row);
    const events: DriverEvent[] = [];
    const driver = createAgyDriver({
      executablePath: FAKE_ACP_AGENT,
      homeDir: root,
      store,
      prepareLaunch: async () => makeLaunchFiles(launchDir, { env, prompt: "   \n" }),
      log: () => {},
    });
    driver.onEvent((_id, ev) => events.push(ev));

    try {
      const done = waitForEventCount(driver, events, "turn.ended", 1);
      await driver.send(row.id, { messageIds: [1], source: "user", text: "hello" });
      await done;

      expect(existsSync(join(launchDir, "agy-rules", ".agents", "hooks.json"))).toBe(true);
      expect(events.filter((e) => e.type === "agent.checklist")).toHaveLength(0);
    } finally {
      await driver.shutdown();
    }
  });
});

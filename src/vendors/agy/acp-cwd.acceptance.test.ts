import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RequestPermissionRequest, SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import { readJsonLog } from "../../../test/append-log.ts";
import { MemorySessionStore } from "../../daemon/driver/test-helpers.ts";
import {
  AGENT_VENDORS,
  EMPTY_TOKEN_USAGE,
  buildReadonlyPolicy,
  dataDirReadScope,
  type AgentSessionRow,
  type DriverEvent,
  type LaunchFiles,
  type ReadonlyPolicy,
  type SessionCapabilities,
  type SessionId,
} from "../../shared/index.ts";
import { createAcpDriver, decideAcpPermission, type AcpLaunchContext } from "../_common/acp/index.ts";
import type { FakeAcpLogEntry, FakeAcpScript } from "../_common/acp/fixtures/fake-acp-agent.ts";
import { buildClaudeArgs } from "../claude/protocol.ts";
import { buildThreadStartRequest, readCodexLaunchConfig } from "../codex/protocol.ts";
import { buildPiArgs } from "../pi/protocol.ts";
import {
  AGY_ACP_WRITE_TOOL_NAMES,
  buildAgyAcpAdditionalDirs,
  buildAgyAcpLaunchArgs,
  buildAgyWorkspaceHooks,
  createAgyAcpDriver,
  extractAgyAcpMcpTool,
  matchesAgyAcpStaleProcess,
  resolveAgyAcpModelAndEffort,
} from "./acp-config.ts";
import { agyChecklistFromStep } from "./checklist.ts";
import { createAgyCopyForker } from "./handover.ts";
import { agyReadonlySandboxInput } from "./readonly.ts";
import { agyRuleBudgetWarning, writeAgyPromptRules } from "./rules.ts";
import agySpec from "./spec.ts";

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
    id: 101 as SessionId,
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

function makeFiles(
  dir: string,
  overrides: { env?: Record<string, string>; readonly?: ReadonlyPolicy; tmpDir?: string } = {},
): LaunchFiles {
  const promptFile = join(dir, "prompt.md");
  if (!existsSync(promptFile)) writeFileSync(promptFile, "Follow project rules.\n", "utf8");
  const base = { promptFile, env: overrides.env ?? {}, fingerprint: "fp-1" };
  if (overrides.readonly !== undefined) {
    return { ...base, readonly: overrides.readonly, tmpDir: overrides.tmpDir ?? join(dir, "tmp") };
  }
  return base;
}

function makeLaunchContext(row: AgentSessionRow, files: LaunchFiles, resume = false): AcpLaunchContext {
  return { row, files, resume, executablePath: "/usr/local/bin/agy" };
}

function makeFakeAcpEnv(dir: string, script: FakeAcpScript): { logFile: string; scriptFile: string; env: Record<string, string> } {
  const scriptFile = join(dir, "script.json");
  const logFile = join(dir, "acp.jsonl");
  writeFileSync(scriptFile, JSON.stringify(script), "utf8");
  return {
    scriptFile,
    logFile,
    env: {
      FAKE_ACP_SCRIPT: scriptFile,
      FAKE_ACP_LOG: logFile,
      PATH: process.env.PATH ?? "",
    },
  };
}

function readFakeAcpLogs(logFile: string): FakeAcpLogEntry[] {
  return readJsonLog<FakeAcpLogEntry>(logFile);
}

function loggedParams(entry: FakeAcpLogEntry | undefined): Record<string, unknown> | undefined {
  return entry?.params as Record<string, unknown> | undefined;
}

describe("Antigravity ACP cwd acceptance tests (fail before implementation)", () => {
  it("S1: PM and worktree Worker keep row.cwd as primary cwd across two consecutive turns with lexically earlier addDirs and preserve cacheRead", async () => {
    const root = tempDir("agy-acp-s1-");
    const projectDir = join(root, "zzz-agent-hub");
    const pmMemoryDir = join(root, ".agent-hub", "state", "pm-memory", "9");
    const worktreesDir = join(root, ".agent-hub", "worktrees", "7");
    const otherFolder = join(root, "aaa-lib");
    const launchDir = join(root, ".agent-hub", "state", "launch", "101");
    for (const d of [projectDir, pmMemoryDir, worktreesDir, otherFolder, launchDir]) mkdirSync(d, { recursive: true });

    const { logFile, env } = makeFakeAcpEnv(root, {
      resumeCapability: true,
      additionalDirectoriesCapability: true,
      turns: [
        { textChunks: [`PWD=${projectDir}`], usage: { inputTokens: 2000, cachedReadTokens: 0, outputTokens: 20, totalTokens: 2020 } },
        { textChunks: [`PWD=${projectDir}`], usage: { inputTokens: 300, cachedReadTokens: 1950, outputTokens: 15, totalTokens: 2265 } },
      ],
    });

    const store = new MemorySessionStore();
    const row = makeRow({
      cwd: projectDir,
      addDirs: [otherFolder, worktreesDir, pmMemoryDir],
    });
    store.add(row);
    const events: DriverEvent[] = [];
    const driver = createAgyAcpDriver({
      executablePath: FAKE_ACP_AGENT,
      store,
      prepareLaunch: async () => makeFiles(launchDir, { env }),
      log: () => {},
    });
    driver.onEvent((_id, event) => events.push(event));
    try {
      const waitTurn = (n: number) =>
        new Promise<void>((resolve) => {
          const check = () => {
            if (events.filter((e) => e.type === "turn.ended").length >= n) resolve();
          };
          driver.onEvent(() => check());
          check();
        });

      const t1 = waitTurn(1);
      await driver.send(row.id, { messageIds: [1], source: "user", text: "Run pwd" });
      await t1;

      const t2 = waitTurn(2);
      await driver.send(row.id, { messageIds: [2], source: "user", text: "Run pwd again" });
      await t2;

      const logs = readFakeAcpLogs(logFile);
      const sessionNew = loggedParams(logs.find((entry) => entry.event === "session/new"));
      expect(sessionNew?.cwd).toBe(projectDir);
      const addDirsSent = sessionNew?.additionalDirectories as string[] | undefined;
      expect(addDirsSent).toContain(otherFolder);
      expect(addDirsSent).toContain(pmMemoryDir);
      expect(addDirsSent).toContain(join(launchDir, "agy-rules"));
      expect(store.get(row.id)?.usage.cacheRead).toBeGreaterThan(0);
    } finally {
      await driver.shutdown();
    }
  });

  it("S2: restarting mid-operation resumes via session/resume with primary cwd intact and falls back to session/new on session_not_found", async () => {
    const root = tempDir("agy-acp-s2-");
    const projectDir = join(root, "zzz-proj");
    const launchDir = join(root, ".agent-hub", "state", "launch", "102");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(launchDir, { recursive: true });

    const { logFile, env } = makeFakeAcpEnv(root, {
      resumeCapability: true,
      additionalDirectoriesCapability: true,
      resumeNotFound: true,
      turns: [{ textChunks: [`PWD=${projectDir}`], usage: { inputTokens: 500, cachedReadTokens: 400, outputTokens: 10, totalTokens: 910 } }],
    });

    const store = new MemorySessionStore();
    const row = makeRow({
      id: 102 as SessionId,
      cwd: projectDir,
      vendorSessionId: "11111111-2222-4333-8444-555555555555",
      hasCompletedTurn: true,
    });
    store.add(row);

    const driver = createAgyAcpDriver({
      executablePath: FAKE_ACP_AGENT,
      store,
      prepareLaunch: async () => makeFiles(launchDir, { env }),
      log: () => {},
    });
    try {
      const done = new Promise<void>((resolve) => {
        driver.onEvent((_id, event) => {
          if (event.type === "turn.ended") resolve();
        });
      });
      await driver.send(row.id, { messageIds: [1], source: "user", text: "Run pwd after restart" });
      await done;

      const logs = readFakeAcpLogs(logFile);
      const resumed = loggedParams(logs.find((entry) => entry.event === "session/resume"));
      const fallbackNew = loggedParams(logs.find((entry) => entry.event === "session/new"));
      expect(resumed?.cwd).toBe(projectDir);
      expect(fallbackNew?.cwd).toBe(projectDir);
    } finally {
      await driver.shutdown();
    }
  });

  it("S3: adding a lexically earlier otherFolder deduplicates additionalDirectories while excluding primary cwd", () => {
    const root = tempDir("agy-acp-s3-");
    const mainDir = join(root, "zzz-main");
    const addedEarly = join(root, "aaa-added");
    const launchWorkspace = join(root, ".agent-hub", "state", "launch", "103", "agy-rules");
    const row = makeRow({ cwd: mainDir, addDirs: [addedEarly, mainDir, ""] });
    const files = makeFiles(root);
    const dirs = buildAgyAcpAdditionalDirs(makeLaunchContext(row, files), launchWorkspace);
    expect(dirs).toEqual([addedEarly, launchWorkspace]);
    expect(dirs).not.toContain(mainDir);
  });

  it("S4a: buildAgyAcpLaunchArgs never widens permissions for read-only Workers and never passes --add-dir or --settings", () => {
    const root = tempDir("agy-acp-s4a-");
    const row = makeRow({ cwd: join(root, "proj") });
    const normalArgs = buildAgyAcpLaunchArgs(makeLaunchContext(row, makeFiles(root)));
    expect(normalArgs).toEqual(["acp", "--sandbox=false", "--dangerously-skip-permissions"]);
    expect(normalArgs).not.toContain("--add-dir");
    expect(normalArgs).not.toContain("--settings");

    const readonlyPolicy = buildReadonlyPolicy({ homeDir: root, stateDir: join(root, "state") });
    const readonlyArgs = buildAgyAcpLaunchArgs(
      makeLaunchContext(row, makeFiles(root, { readonly: readonlyPolicy })),
    );
    expect(readonlyArgs).toEqual(["acp", "--sandbox=false"]);
    expect(readonlyArgs).not.toContain("--dangerously-skip-permissions");
  });

  it("S4b: buildAgyWorkspaceHooks blocks schedule, denied MCP servers, and read-only writes/subagents without ever emitting decision allow", () => {
    const caps: SessionCapabilities = {
      deny: {
        mcp: ["github", "slack"],
        skills: [],
        connectors: [],
        plugins: [],
        pluginOf: { skills: {}, mcp: {} },
      },
      allow: { skills: [], mcp: [] },
    };
    const posixHooks = buildAgyWorkspaceHooks({ readonly: true, capabilities: caps, platform: "darwin" });
    const posixJson = JSON.stringify(posixHooks);
    expect(posixJson).toContain("schedule");
    expect(posixJson).toContain("github");
    expect(posixJson).toContain("slack");
    expect(posixJson).toContain("invoke_subagent");
    expect(posixJson).toContain(AGY_ACP_WRITE_TOOL_NAMES[0]!);
    expect(posixJson).not.toContain('"decision":"allow"');
    expect(posixJson).not.toContain('"decision": "allow"');

    const winHooks = buildAgyWorkspaceHooks({ readonly: false, platform: "win32" });
    const winJson = JSON.stringify(winHooks);
    expect(winJson).toContain("echo ");
    expect(winJson).not.toContain("printf ");
  });

  it("S4c: extractAgyAcpMcpTool + decideAcpPermission rejects write-capable MCP calls and approves readOnlyHint calls on read-only Workers", async () => {
    const policy = buildReadonlyPolicy({ homeDir: "/tmp/home", stateDir: "/tmp/state" });
    const writeReq = {
      sessionId: "s-1",
      toolCall: {
        toolCallId: "t-1",
        name: "call_mcp_tool",
        title: "Call MCP tool github/create_issue",
        kind: "other",
        rawInput: { ServerName: "github", ToolName: "create_issue" },
        _meta: { annotations: { readOnlyHint: false } },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    } as unknown as RequestPermissionRequest;

    const extractedWrite = extractAgyAcpMcpTool(writeReq);
    expect(extractedWrite?.server).toBe("github");
    expect(extractedWrite?.tool).toBe("create_issue");

    const decisionWrite = await decideAcpPermission(
      { request: writeReq, readonlyPolicy: policy, closing: false, signal: new AbortController().signal },
      { extractMcpTool: extractAgyAcpMcpTool, writeToolNames: AGY_ACP_WRITE_TOOL_NAMES },
    );
    expect(decisionWrite).toEqual({ outcome: "selected", optionId: "reject" });

    const readReq = {
      sessionId: "s-1",
      toolCall: {
        toolCallId: "t-2",
        name: "call_mcp_tool",
        title: "Call MCP tool github/list_issues",
        kind: "other",
        rawInput: { ServerName: "github", ToolName: "list_issues" },
        _meta: { annotations: { readOnlyHint: true } },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    } as unknown as RequestPermissionRequest;
    const decisionRead = await decideAcpPermission(
      { request: readReq, readonlyPolicy: policy, closing: false, signal: new AbortController().signal },
      { extractMcpTool: extractAgyAcpMcpTool, writeToolNames: AGY_ACP_WRITE_TOOL_NAMES },
    );
    expect(decisionRead).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("S6 & S7: resolveAgyAcpModelAndEffort splits legacy combined model-effort IDs and ignores empty inputs", () => {
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
    expect(resolveAgyAcpModelAndEffort({ model: "gemini-3.8-flash-low", effort: null, options })).toEqual([
      { configId: "model", value: "gemini-3.8-flash" },
      { configId: "thought_level", value: "low" },
    ]);
    expect(resolveAgyAcpModelAndEffort({ model: null, effort: null, options })).toEqual([]);
  });

  it("S9: cross-platform Windows cross-drive cwd and stale-process matching work identically across platforms", () => {
    const winRow = makeRow({
      cwd: "D:\\work\\repo",
      addDirs: ["C:\\Users\\alice\\.agent-hub\\state\\pm-memory\\1"],
    });
    const dirs = buildAgyAcpAdditionalDirs(
      makeLaunchContext(winRow, { promptFile: "C:\\Users\\alice\\.agent-hub\\state\\launch\\1\\prompt.md", env: {}, fingerprint: "fp" }),
      "C:\\Users\\alice\\.agent-hub\\state\\launch\\1\\agy-rules",
    );
    expect(dirs).toEqual([
      "C:\\Users\\alice\\.agent-hub\\state\\pm-memory\\1",
      "C:\\Users\\alice\\.agent-hub\\state\\launch\\1\\agy-rules",
    ]);

    expect(
      matchesAgyAcpStaleProcess(
        "/Users/alice/.local/bin/agy acp --sandbox=false --dangerously-skip-permissions",
        winRow,
        "/Users/alice/.local/bin/agy",
      ),
    ).toBe(true);
    expect(matchesAgyAcpStaleProcess("/Users/alice/.local/bin/agy", winRow, "/Users/alice/.local/bin/agy")).toBe(false);
  });

  it("S10: shared ACP handshake forwards extraAdditionalDirectories without changing cwd and maps update_steps via fromToolCall", async () => {
    const root = tempDir("agy-acp-s10-");
    const projectDir = join(root, "zzz-proj");
    const extraWorkspace = join(root, "aaa-launch-workspace");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(extraWorkspace, { recursive: true });

    const { logFile, env } = makeFakeAcpEnv(root, {
      additionalDirectoriesCapability: true,
      turns: [
        {
          toolCalls: [
            {
              toolCallId: "step-1",
              name: "update_steps",
              title: "Run update_steps",
              kind: "other",
              rawInput: { steps: [{ title: "Run pwd", status: "done" }] },
            },
          ],
          textChunks: ["done"],
        },
      ],
    });

    const store = new MemorySessionStore();
    const row = makeRow({ id: 110 as SessionId, cwd: projectDir, addDirs: [] });
    store.add(row);
    const events: DriverEvent[] = [];
    const driver = createAcpDriver(
      {
        vendor: "agy",
        launchArgs: [],
        session: {
          extraAdditionalDirectories: () => [extraWorkspace],
        },
        checklist: {
          fromToolCall: agyChecklistFromStep,
        },
      },
      {
        executablePath: FAKE_ACP_AGENT,
        store,
        prepareLaunch: async () => makeFiles(root, { env }),
        log: () => {},
      },
    );
    driver.onEvent((_id, event) => events.push(event));
    try {
      const done = new Promise<void>((resolve) => {
        driver.onEvent((_id, event) => {
          if (event.type === "turn.ended") resolve();
        });
      });
      await driver.send(row.id, { messageIds: [1], source: "user", text: "Check" });
      await done;

      const sessionNew = loggedParams(readFakeAcpLogs(logFile).find((entry) => entry.event === "session/new"));
      expect(sessionNew?.cwd).toBe(projectDir);
      expect(sessionNew?.additionalDirectories).toEqual([extraWorkspace]);
      const checklistEvents = events.filter((e) => e.type === "agent.checklist");
      expect(checklistEvents).toHaveLength(1);
    } finally {
      await driver.shutdown();
    }
  });
});

describe("Unchanged-rule regression tests (must pass before and after implementation)", () => {
  it("R1 & R2: writeAgyPromptRules writes always_on fusa-NN.md + hard-linked skills and agyRuleBudgetWarning still enforces limits", () => {
    const root = tempDir("agy-reg-r1-");
    const promptFile = join(root, "prompt.md");
    const skillsDir = join(root, "skills");
    mkdirSync(join(skillsDir, "fusa-task-graph"), { recursive: true });
    writeFileSync(join(skillsDir, "fusa-task-graph", "SKILL.md"), "---\nname: fusa-task-graph\n---\nBody\n");
    writeFileSync(promptFile, "Project instructions.\n");

    const workspace = writeAgyPromptRules(promptFile, skillsDir);
    expect(workspace).toBe(join(root, "agy-rules"));
    expect(readFileSync(join(workspace!, ".agents", "rules", "fusa-01.md"), "utf8")).toContain("trigger: always_on");
    expect(existsSync(join(workspace!, ".agents", "skills", "fusa-task-graph", "SKILL.md"))).toBe(true);
    expect(agyRuleBudgetWarning(join(root, "home"), [workspace!])).toBeNull();
  });

  it("R3: agyReadonlySandboxInput preserves dataDirScope, protectedRoots, runtime dirs, and Keychains readability", () => {
    const root = tempDir("agy-reg-r3-");
    const homeDir = join(root, "home");
    const dataDir = join(homeDir, ".agent-hub");
    const tmp = join(root, "tmp");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    const policy = buildReadonlyPolicy({
      homeDir,
      stateDir: join(dataDir, "state"),
      protectedRoots: [dataDir],
      dataDirScope: dataDirReadScope({ dataDir, launchDir: join(dataDir, "state", "launch", "1") }),
    });
    const input = agyReadonlySandboxInput({ homeDir, tmpDir: tmp, policy, realpath: (p) => p });
    expect(input.dataDirScope?.dataDir).toBe(dataDir);
    expect(input.secretPaths.some((p) => p.endsWith("Library/Keychains"))).toBe(false);
    expect(input.writableDirs.some((d) => d.endsWith(".gemini/antigravity-cli/conversations"))).toBe(true);
  });

  it("R4: createAgyCopyForker keeps copying Antigravity conversation SQLite databases with rewritten UUIDs", async () => {
    const root = tempDir("agy-reg-r4-");
    const srcId = "11111111-2222-4333-8444-555555555555";
    const oldTraj = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    mkdirSync(join(root, "conversations"), { recursive: true });
    const db = new DatabaseSync(join(root, "conversations", `${srcId}.db`));
    db.exec("create table trajectory_meta (trajectory_id TEXT, cascade_id TEXT)");
    db.prepare("insert into trajectory_meta values (?, ?)").run(oldTraj, srcId);
    db.close();

    const forker = createAgyCopyForker({ root });
    const handle = await forker.fork(
      {
        sessionId: 1,
        vendor: "agy",
        vendorSessionId: srcId,
        executablePath: "/bin/true",
        cwd: root,
        addDirs: [],
        model: null,
        effort: null,
        launch: { promptFile: join(root, "prompt.md"), env: {}, fingerprint: "fp" },
      },
      new AbortController().signal,
    );
    expect(handle.forkId).not.toBe(srcId);
    expect(existsSync(join(root, "conversations", `${handle.forkId}.db`))).toBe(true);
    await forker.remove(handle);
    expect(existsSync(join(root, "conversations", `${handle.forkId}.db`))).toBe(false);
  });

  it("R5: all eight vendors are registered and non-agy launch builders keep prompt/skills separate from cwd", () => {
    expect(AGENT_VENDORS).toEqual(["claude", "agy", "codex", "pi", "deepseek", "cursor", "opencode", "kimi"]);
    expect(agySpec.id).toBe("agy");

    const root = tempDir("agy-reg-r5-");
    const files = makeFiles(root);
    const claudeArgs = buildClaudeArgs(makeRow({ vendor: "claude", vendorSessionId: "cid-1", addDirs: ["/aaa"] }), files, false);
    expect(claudeArgs).toContain("--append-system-prompt-file");

    const codexLaunch = readCodexLaunchConfig(files);
    const threadStart = JSON.parse(buildThreadStartRequest(1, { cwd: "/zzz/proj", model: null }, codexLaunch)) as {
      params: { cwd: string };
    };
    expect(threadStart.params.cwd).toBe("/zzz/proj");

    const piArgs = buildPiArgs({
      row: { cwd: "/zzz/proj", addDirs: ["/aaa"], model: null, effort: null },
      files,
      sessionId: "pi-1",
    });
    expect(piArgs).toContain("--append-system-prompt");
    expect(piArgs).not.toContain("--add-dir");
  });
});

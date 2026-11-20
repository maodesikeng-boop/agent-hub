import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySessionStore } from "../../daemon/driver/test-helpers.ts";
import type { ReadonlySandboxInput } from "../../daemon/driver/write-scope.ts";
import { EMPTY_TOKEN_USAGE, MAX_COMMANDS, type AgentSessionRow, type DriverEvent, type Driver, type LaunchFiles } from "../../shared/index.ts";
import { writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";
import type { FakeAcpLogEntry, FakeAcpScript } from "../_common/acp/fixtures/fake-acp-agent.ts";
import type { AcpDriverOptions } from "../_common/acp/index.ts";
import { VENDOR_LIST } from "../registry.ts";
import { countOpenCodeAccounts, opencodeCatalogProbe, parseOpenCodeModelsText } from "./catalog.ts";
import { collectOpenCodeCommands } from "./composer.ts";
import opencodeDaemon from "./daemon.ts";
import {
  buildOpenCodeConfigOverride,
  classifyOpenCodeTurnError,
  createOpenCodeDriver,
  matchesOpenCodeAcpCommand,
  openCodeMcpAction,
  resolveOpenCodeModelValue,
} from "./driver.ts";
import * as opencodePaths from "./paths.ts";
import { opencodeSetupAdapter } from "./setup.ts";
import opencodeSpec from "./spec.ts";
import { openCodeMcpPath, opencodeSyncAdapter, parseOpenCodeMcpEntry } from "./sync.ts";

const FAKE_ACP_AGENT = join(dirname(fileURLToPath(import.meta.url)), "..", "_common", "acp", "fixtures", "fake-acp-agent.ts");

const MODEL_OPTION: SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "opencode/gemini-3.8-flash",
  options: [
    { value: "opencode/gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { value: "opencode/claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { value: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" },
  ],
};

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "opencode-test-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("opencode spec, paths, and registration", () => {
  it("registers after the existing vendors with claude still first", () => {
    const ids = VENDOR_LIST.map((s) => s.id);
    expect(ids[0]).toBe("claude");
    expect(ids).toContain("opencode");
    expect(opencodeSpec.cli).toEqual({ command: "opencode", envVar: "AGENT_HUB_OPENCODE", loginCommand: "opencode auth login" });
    expect(opencodeSpec.capabilities.readonly).toBe("os_sandbox");
    expect(opencodeSpec.models.shortName?.("opencode/claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(opencodeSpec.models.shortName?.("opencode/kimi-k3")).toBe("Kimi K3");
  });

  it("finds the install script binary under ~/.opencode/bin and the npm shim on Windows", () => {
    const join = (...parts: string[]) => parts.join("/");
    expect(opencodePaths.fallbackPaths!({ userHome: "/h", platform: "darwin", linuxInstallDirs: [], join })[0]).toBe("/h/.opencode/bin/opencode");
    expect(opencodePaths.fallbackPaths!({ userHome: "C:/h", platform: "win32", linuxInstallDirs: [], join })[0]).toBe("C:/h/AppData/Roaming/npm/opencode.cmd");
    expect(opencodePaths.installCommand).toContain("https://opencode.ai/v2/install");
  });
});

describe("opencode config override", () => {
  const base: LaunchFiles = { promptFile: "/p", env: {}, fingerprint: "f" };

  it("always denies the question tool so an unattended session never waits on a form", () => {
    expect(buildOpenCodeConfigOverride(base)).toEqual({ permissions: [{ action: "question", resource: "*", effect: "deny" }] });
  });

  it("routes every non-allowlisted tool, including Code Mode MCP calls, through ACP approval and blocks MCP servers for read-only Workers", () => {
    const override = buildOpenCodeConfigOverride({ ...base, readonly: { secretPaths: [], secretGlobs: [], connectors: { extraAllow: [], deny: [] } } });
    const permissions = override.permissions as { action: string; resource: string; effect: string }[];
    const effectOf = (action: string) => permissions.findLast((r) => r.action === action || r.action === "*")?.effect;
    expect(effectOf("execute")).toBe("ask");
    expect(effectOf("team_post_message")).toBe("ask");
    expect(effectOf("edit")).toBe("deny");
    expect(effectOf("question")).toBe("deny");
    for (const action of ["read", "grep", "shell", "webfetch"]) expect(effectOf(action), action).toBe("allow");
    expect(effectOf("subagent")).toBe("deny");
    expect(override.policies).toEqual([{ action: "mcp.use", resource: "*", effect: "deny" }]);
    expect(buildOpenCodeConfigOverride(base).policies).toBeUndefined();
  });

  it("pins the read-only rules onto the plan agent so project agents.plan.permissions cannot widen them", () => {
    const override = buildOpenCodeConfigOverride({ ...base, readonly: { secretPaths: [], secretGlobs: [], connectors: { extraAllow: [], deny: [] } } });
    expect(override.default_agent).toBe("plan");
    expect(override.agents).toEqual({ plan: { disabled: false, mode: "primary", permissions: override.permissions } });
    const permissions = override.permissions as { action: string; effect: string }[];
    expect(permissions.filter((r) => r.action === "subagent")).toEqual([{ action: "subagent", resource: "*", effect: "deny" }]);
    const writable = buildOpenCodeConfigOverride(base);
    expect(writable.agents).toBeUndefined();
    expect(writable.default_agent).toBeUndefined();
  });

  it("denies edits for read-only Workers, plus per-PM denied MCP servers and skills", () => {
    const override = buildOpenCodeConfigOverride({
      ...base,
      skillsDir: "/launch/skills",
      readonly: { secretPaths: [], secretGlobs: [], connectors: { extraAllow: [], deny: [] } },
      capabilities: {
        deny: { skills: ["deploy"], mcp: ["my server.v2"], connectors: [], plugins: [], pluginOf: { skills: {}, mcp: {} } },
        allow: { skills: [], mcp: [] },
      },
    });
    const permissions = override.permissions as unknown[];
    expect(permissions.slice(-5)).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" },
      { action: "my_server_v2_*", resource: "*", effect: "deny" },
      { action: "skill", resource: "deploy", effect: "deny" },
    ]);
    expect(override.skills).toEqual(["/launch/skills"]);
    expect(openCodeMcpAction("ok-name_1")).toBe("ok-name_1_*");
  });
});

describe("opencode model and error mapping", () => {
  it("matches exact, case-insensitive, and bare model IDs against provider/model values", () => {
    expect(resolveOpenCodeModelValue("opencode/claude-sonnet-5-5", MODEL_OPTION)).toBe("opencode/claude-sonnet-5-5");
    expect(resolveOpenCodeModelValue("OPENCODE/Gemini-3.8-Flash", MODEL_OPTION)).toBe("opencode/gemini-3.8-flash");
    expect(resolveOpenCodeModelValue("claude-opus-5-5", MODEL_OPTION)).toBe("anthropic/claude-opus-5-5");
    expect(resolveOpenCodeModelValue("", MODEL_OPTION)).toBeNull();
  });

  it("keeps the session default instead of sending a model OpenCode does not list (-32602 would fail the handshake)", () => {
    expect(resolveOpenCodeModelValue("custom/brand-new", MODEL_OPTION)).toBeNull();
    expect(resolveOpenCodeModelValue("brand-new", MODEL_OPTION)).toBeNull();
    expect(resolveOpenCodeModelValue("custom/brand-new", null)).toBe("custom/brand-new");
    expect(opencodeSpec.models.routerDefault.model).toBe("opencode/big-pickle");
  });

  it("matches only opencode acp processes when cleaning up stale PIDs", () => {
    const exe = "/h/.opencode/bin/opencode";
    expect(matchesOpenCodeAcpCommand(`${exe} acp`, null, exe)).toBe(true);
    expect(matchesOpenCodeAcpCommand("/opt/homebrew/bin/opencode acp --log-level warn", null, exe)).toBe(true);
    expect(matchesOpenCodeAcpCommand(`${exe}`, null, exe)).toBe(false);
    expect(matchesOpenCodeAcpCommand("/usr/bin/vim notes-about-opencode-acp.md", null, exe)).toBe(false);
  });

  it("keeps ACP auth_required and classifies provider rate limits as quota", () => {
    expect(classifyOpenCodeTurnError(new RequestError(-32000, "Authentication required")).subtype).toBe("auth_required");
    expect(classifyOpenCodeTurnError(new Error("provider.rate-limit: Rate limit exceeded (429)")).subtype).toBe("quota_exceeded");
    expect(classifyOpenCodeTurnError(new Error("boom")).subtype).toBe("error_during_execution");
  });
});

describe("opencode catalog probe", () => {
  it("parses provider/model lines, puts bundled models first, and caps the list", () => {
    const text = ["\u001b[32manthropic/claude-opus-5-5\u001b[0m", "opencode/kimi-k3", "not a model", "opencode/kimi-k3", ""].join("\n");
    const catalog = parseOpenCodeModelsText(text)!;
    expect(catalog.source).toBe("vendor");
    expect(catalog.models.map((m) => m.id)).toEqual(["opencode/kimi-k3", "anthropic/claude-opus-5-5"]);
    expect(catalog.models[0]!.label).toBe("Kimi K3");
    expect(parseOpenCodeModelsText("garbage")).toBeNull();
  });

  it("derives availability from accounts, free Zen models, and errors", () => {
    expect(countOpenCodeAccounts([{ id: 1 }])).toBe(1);
    expect(countOpenCodeAccounts({ accounts: [] })).toBe(0);
    expect(opencodeCatalogProbe.availabilityOf({ modelsText: null, authJson: [{ provider: "anthropic" }], error: null })).toBe("available");
    expect(opencodeCatalogProbe.availabilityOf({ modelsText: "opencode/big-pickle\n", authJson: [], error: null })).toBe("available");
    expect(opencodeCatalogProbe.availabilityOf({ modelsText: null, authJson: [], error: null })).toBe("signed_out");
    expect(opencodeCatalogProbe.availabilityOf({ modelsText: null, authJson: null, error: "spawn opencode ENOENT" })).toBe("not_installed");
  });
});

describe("opencode MCP sync", () => {
  const ctx = () => ({ userHome: dir, env: {} });
  const configFile = () => join(dir, ".config", "opencode", "opencode.json");
  const write = (value: unknown) => {
    mkdirSync(dirname(configFile()), { recursive: true });
    writeFileSync(configFile(), JSON.stringify(value, null, 2));
  };

  it("scans V1 servers directly under mcp and V2 servers under mcp.servers", () => {
    write({ mcp: { fs: { type: "local", command: ["npx", "-y", "fs-mcp"], environment: { A: "1" } }, off: { type: "local", command: ["x"], enabled: false } } });
    expect(opencodeSyncAdapter.scanMcp(ctx()).servers).toEqual({ fs: { transport: "stdio", command: "npx", args: ["-y", "fs-mcp"], env: { A: "1" } } });
    write({ mcp: { servers: { docs: { type: "remote", url: "https://mcp.example.com", headers: { K: "v" } }, sso: { type: "remote", url: "https://x", oauth: { client_id: "c" } } } } });
    const scan = opencodeSyncAdapter.scanMcp(ctx());
    expect(scan.servers).toEqual({ docs: { transport: "http", url: "https://mcp.example.com", headers: { K: "v" } } });
    expect(scan.nonSyncable.map((n) => n.name)).toEqual(["sso"]);
  });

  it("writes new servers into the layout already on disk and bridges SSE through mcp-remote", () => {
    write({ mcp: { fs: { type: "local", command: ["fs"] } } });
    const v1 = opencodeSyncAdapter.planMcpPatch(ctx(), { upsert: { web: { transport: "http", url: "https://w", headers: {} } }, removeNames: new Set(["fs"]) });
    expect(JSON.parse(v1.nextContent!)).toEqual({ mcp: { web: { type: "remote", url: "https://w" } } });

    rmSync(configFile());
    const v2 = opencodeSyncAdapter.planMcpPatch(ctx(), { upsert: { ev: { transport: "sse", url: "https://e/sse", headers: {} } }, removeNames: new Set() });
    expect(JSON.parse(v2.nextContent!)).toEqual({ mcp: { servers: { ev: { type: "local", command: ["npx", "-y", "mcp-remote", "https://e/sse"] } } } });
    expect(openCodeMcpPath({ exists: false, raw: "", data: {} })).toEqual(["mcp", "servers"]);
    expect(parseOpenCodeMcpEntry("x", { type: "local", command: [] })).toEqual({});
  });
});

describe("opencode composer and setup", () => {
  it("lists project and user command files and always keeps compact", () => {
    const cwd = join(dir, "repo");
    mkdirSync(join(cwd, ".opencode", "commands"), { recursive: true });
    writeFileSync(join(cwd, ".opencode", "commands", "release.md"), "---\ndescription: Cut a release\n---\nbody");
    writeFileSync(join(cwd, ".opencode", "commands", "bad name.md"), "x");
    const cmds = collectOpenCodeCommands({ cwd, addDirs: [] }, join(dir, "home"));
    expect(cmds).toEqual([{ name: "release", description: "Cut a release" }, { name: "compact", description: "压缩当前对话上下文", builtin: true }]);
    expect(cmds.length).toBeLessThanOrEqual(MAX_COMMANDS);
  });

  it("installs with the official script (npm fallback) and npm on Windows, and stores the Zen key", async () => {
    expect(opencodeSetupAdapter.installRecipe("darwin")).toMatchObject({ kind: "posix_script", scriptUrl: "https://opencode.ai/v2/install", fallback: { kind: "npm", packageSpec: "@opencode/cli" } });
    expect(opencodeSetupAdapter.installRecipe("win32")).toEqual({ kind: "npm", packageSpec: "@opencode/cli" });
    const stored: Record<string, string> = {};
    const secrets = {
      keys: () => Object.keys(stored),
      has: (_v: string, name: string) => name in stored,
      getEnv: () => stored,
      set: (_v: string, entries: Record<string, string>) => Object.assign(stored, entries),
      remove: () => {
        for (const k of Object.keys(stored)) delete stored[k];
      },
      fingerprint: () => "0",
    };
    const setupCtx = { platform: "darwin", userHome: dir, availability: "signed_out" as const, executablePath: () => "opencode", installed: () => true, env: () => ({}), secrets };
    await opencodeSetupAdapter.saveApiKey!(setupCtx, { apiKey: " sk-zen " });
    expect(stored).toEqual({ OPENCODE_API_KEY: "sk-zen" });
    expect((await opencodeSetupAdapter.inspectAuth(setupCtx)).accountSummary).toBe("API key configured");
    await opencodeSetupAdapter.signOut(setupCtx);
    expect((await opencodeSetupAdapter.inspectAuth(setupCtx)).accountSummary).toBeNull();
  });

  it("disables auto-update for every launch", () => {
    expect(opencodeDaemon.launchFiles?.({ role: "worker", stateDir: dir, osSandboxed: true })).toEqual({ env: { OPENCODE_DISABLE_AUTOUPDATE: "1" } });
  });
});

describe("opencode driver over the fake ACP agent", () => {
  const drivers: Driver[] = [];
  afterEach(async () => {
    for (const d of drivers.splice(0)) await d.shutdown();
  });

  function harness(options: { script: FakeAcpScript; readonly?: boolean; readonlySpawn?: AcpDriverOptions["readonlySpawn"]; model?: string }) {
    const cwd = join(dir, "workspace");
    mkdirSync(cwd, { recursive: true });
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "system", "utf8");
    const scriptFile = join(dir, "script.json");
    writeFileSync(scriptFile, JSON.stringify(options.script), "utf8");
    const logFile = join(dir, "fake.log");
    const envFile = join(dir, "env.json");
    const wrapper = writeExecutableNodeScript(
      join(dir, "opencode"),
      `
require("node:fs").writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({ argv: process.argv.slice(2), config: process.env.OPENCODE_CONFIG_CONTENT }));
const child = require("node:child_process").spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(FAKE_ACP_AGENT)}, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
`,
    );
    const store = new MemorySessionStore();
    const row: AgentSessionRow = {
      id: 1, role: "worker", conversationId: 10, pmId: null, workerId: 1, vendor: "opencode", vendorSessionId: "", cwd, addDirs: [],
      generation: 1, model: options.model ?? null, effort: null, pid: null, status: "idle", hasCompletedTurn: false, lastEventAt: null,
      rateLimit: null, usage: { ...EMPTY_TOKEN_USAGE }, createdAt: Date.now(), updatedAt: Date.now(),
    };
    store.add(row);
    const driver = createOpenCodeDriver({
      store,
      executablePath: wrapper,
      log: () => {},
      prepareLaunch: async () => ({
        promptFile,
        fingerprint: "fp",
        env: { ...process.env, FAKE_ACP_SCRIPT: scriptFile, FAKE_ACP_LOG: logFile, FAKE_ACP_STATE: join(dir, "state") } as Record<string, string>,
        ...(options.readonly ? { readonly: { secretPaths: [], secretGlobs: [], connectors: { extraAllow: [], deny: [] } } } : {}),
      }),
      ...(options.readonlySpawn ? { readonlySpawn: options.readonlySpawn } : {}),
    });
    drivers.push(driver);
    const events: DriverEvent[] = [];
    driver.onEvent((_id, ev) => events.push(ev));
    const logs = (): FakeAcpLogEntry[] => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeAcpLogEntry);
    const turnEnded = async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const hit = events.find((e): e is Extract<DriverEvent, { type: "turn.ended" }> => e.type === "turn.ended");
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`no turn.ended; events=${events.map((e) => e.type).join(",")}`);
    };
    const launch = () => JSON.parse(readFileSync(envFile, "utf8")) as { argv: string[]; config: string };
    return { driver, logs, turnEnded, launch };
  }

  it("launches `opencode acp` with the config override and maps a bare model to its provider value", async () => {
    const h = harness({ model: "claude-sonnet-5-5", script: { initialConfigOptions: [MODEL_OPTION], turns: [{ textChunks: ["ok"] }] } });
    await h.driver.send(1, { messageIds: [1], source: "user", text: "hi" });
    expect((await h.turnEnded()).ok).toBe(true);
    expect(h.launch().argv).toEqual(["acp"]);
    expect(JSON.parse(h.launch().config)).toEqual({ permissions: [{ action: "question", resource: "*", effect: "deny" }] });
    expect(h.logs().filter((e) => e.event === "session/set_config_option")).toEqual([
      expect.objectContaining({ configId: "model", value: "opencode/claude-sonnet-5-5" }),
    ]);
  });

  it("keeps the session default model when the requested one is not offered (no Zen key) instead of failing the handshake", async () => {
    const freeOnly: SessionConfigOption = { ...MODEL_OPTION, currentValue: "opencode/big-pickle", options: [{ value: "opencode/big-pickle", name: "opencode/Big Pickle" }] };
    const h = harness({
      model: "opencode/gemini-3.8-flash",
      script: { omitModes: true, rejectUnlistedConfigValues: true, initialConfigOptions: [freeOnly], turns: [{ textChunks: ["ok"] }] },
    });
    await h.driver.send(1, { messageIds: [1], source: "user", text: "hi" });
    expect((await h.turnEnded()).ok).toBe(true);
    expect(h.logs().filter((e) => e.event === "session/set_config_option")).toEqual([]);
  });

  it("read-only Workers switch to the plan agent and get OpenCode's data dirs writable inside the sandbox", async () => {
    const prevHome = process.env.HOME;
    process.env.HOME = join(dir, "ro-home");
    let captured: ReadonlySandboxInput | null = null;
    try {
      const h = harness({
        readonly: true,
        readonlySpawn: (base, input) => {
          captured = input;
          return { ...base, osSandboxed: true };
        },
        // OpenCode 2.3.2 session/new: no modes field, the agent is the "mode" config option.
        script: {
          omitModes: true,
          rejectUnlistedConfigValues: true,
          initialConfigOptions: [
            MODEL_OPTION,
            { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "build" }, { value: "plan", name: "plan" }] },
          ],
          turns: [{ textChunks: ["read only"] }],
        },
      });
      await h.driver.send(1, { messageIds: [1], source: "user", text: "look" });
      expect((await h.turnEnded()).ok).toBe(true);
      expect(h.logs().filter((e) => e.event === "session/set_mode")).toEqual([]);
      expect(h.logs().filter((e) => e.event === "session/set_config_option")).toEqual([expect.objectContaining({ configId: "mode", value: "plan" })]);
      const config = JSON.parse(h.launch().config) as { permissions: Array<{ action: string; effect: string }>; policies: unknown };
      expect(config.permissions.slice(-3)).toEqual([{ action: "edit", resource: "*", effect: "deny" }, { action: "subagent", resource: "*", effect: "deny" }, { action: "question", resource: "*", effect: "deny" }]);
      expect(config.policies).toEqual([{ action: "mcp.use", resource: "*", effect: "deny" }]);
      const home = realpathSync(join(dir, "ro-home"));
      expect(captured!.writableDirs).toEqual(expect.arrayContaining([join(home, ".local", "share", "opencode"), join(home, ".local", "state", "opencode")]));
      expect(captured!.readableFiles).toContain(join(home, ".local", "share", "opencode", "opencode.db"));
      expect(captured!.readableFiles).not.toContain(join(home, ".local", "share", "opencode", "mcp-auth.json"));
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});

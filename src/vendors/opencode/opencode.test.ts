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
    expect(override).toEqual({
      permissions: [
        { action: "question", resource: "*", effect: "deny" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "my_server_v2_*", resource: "*", effect: "deny" },
        { action: "skill", resource: "deploy", effect: "deny" },
      ],
      skills: ["/launch/skills"],
    });
    expect(openCodeMcpAction("ok-name_1")).toBe("ok-name_1_*");
  });
});

describe("opencode model and error mapping", () => {
  it("matches exact, case-insensitive, and bare model IDs against provider/model values", () => {
    expect(resolveOpenCodeModelValue("opencode/claude-sonnet-5-5", MODEL_OPTION)).toBe("opencode/claude-sonnet-5-5");
    expect(resolveOpenCodeModelValue("OPENCODE/Gemini-3.8-Flash", MODEL_OPTION)).toBe("opencode/gemini-3.8-flash");
    expect(resolveOpenCodeModelValue("claude-opus-5-5", MODEL_OPTION)).toBe("anthropic/claude-opus-5-5");
    expect(resolveOpenCodeModelValue("custom/brand-new", MODEL_OPTION)).toBe("custom/brand-new");
    expect(resolveOpenCodeModelValue("", MODEL_OPTION)).toBeNull();
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
        script: {
          modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }] },
          turns: [{ textChunks: ["read only"] }],
        },
      });
      await h.driver.send(1, { messageIds: [1], source: "user", text: "look" });
      expect((await h.turnEnded()).ok).toBe(true);
      expect(h.logs().filter((e) => e.event === "session/set_mode").map((e) => e.modeId)).toEqual(["plan"]);
      const permissions = (JSON.parse(h.launch().config) as { permissions: Array<{ action: string }> }).permissions.map((p) => p.action);
      expect(permissions).toEqual(["question", "edit"]);
      const home = realpathSync(join(dir, "ro-home"));
      expect(captured!.writableDirs).toEqual(expect.arrayContaining([join(home, ".local", "share", "opencode"), join(home, ".local", "state", "opencode")]));
      expect(captured!.readableFiles).toContain(join(home, ".local", "share", "opencode", "opencode.db"));
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestPermissionRequest, SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySessionStore } from "../../daemon/driver/test-helpers.ts";
import { EMPTY_TOKEN_USAGE, type AgentSessionRow, type Driver, type DriverEvent } from "../../shared/index.ts";
import { writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";
import type { FakeAcpLogEntry, FakeAcpScript } from "../_common/acp/fixtures/fake-acp-agent.ts";
import { kimiCatalogProbe, parseKimiCatalog, readKimiCatalogRaw } from "./catalog.ts";
import { KIMI_BUILTIN_COMMANDS, createKimiComposer } from "./composer.ts";
import kimiDaemon from "./daemon.ts";
import {
  classifyKimiTurnEnded,
  createKimiDriver,
  createKimiPromptOutcomeWatch,
  decideKimiPermission,
  readKimiTurnEnded,
  resolveKimiModelValue,
} from "./driver.ts";
import * as kimiPaths from "./paths.ts";
import { kimiSetupAdapter } from "./setup.ts";
import kimiSpec from "./spec.ts";
import { kimiSyncAdapter } from "./sync.ts";

const FAKE_ACP_AGENT = join(dirname(fileURLToPath(import.meta.url)), "..", "_common", "acp", "fixtures", "fake-acp-agent.ts");
const SESSION_ID = "session_06abd65a-ab8c-4f7a-a504-9b105fc7cd0d";

// Records trimmed from Kimi Code 2.7.1 wire.jsonl.
const failedTurn = (turnId: number, code = "provider.rate_limit") =>
  `${JSON.stringify({ type: "turn.ended", agentId: "main", turnId, reason: "failed", error: { code, message: "upstream limited", retryable: true } })}\n`;
const completedTurn = (turnId: number) => `${JSON.stringify({ type: "turn.ended", agentId: "main", turnId, reason: "completed" })}\n`;

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "kimi-test-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function wirePath(home: string, sessionId = SESSION_ID): string {
  const agentDir = join(home, "sessions", "wd_proj_1", sessionId, "agents", "main");
  mkdirSync(agentDir, { recursive: true });
  return join(agentDir, "wire.jsonl");
}

function fakeSecrets() {
  const stored: Record<string, string> = {};
  return {
    stored,
    keys: () => Object.keys(stored),
    has: (_v: string, name: string) => name in stored,
    getEnv: () => stored,
    set: (_v: string, entries: Readonly<Record<string, string>>) => Object.assign(stored, entries),
    remove: () => {
      for (const k of Object.keys(stored)) delete stored[k];
    },
    fingerprint: () => "0",
  };
}

describe("kimi spec and paths", () => {
  it("uses the kimi binary, ~/.kimi-code home, and KIMI_CODE_HOME override", () => {
    expect(kimiSpec.label).toBe("Kimi Code");
    expect(kimiSpec.cli.command).toBe("kimi");
    expect(kimiSpec.home.configHome).toEqual({ rel: ".kimi-code", env: "KIMI_CODE_HOME" });
    expect(kimiPaths.resolveKimiHome("/u", {})).toBe("/u/.kimi-code");
    expect(kimiPaths.resolveKimiHome("/u", { KIMI_CODE_HOME: "/elsewhere" })).toBe("/elsewhere");
    const join = (...parts: string[]) => parts.join("/");
    expect(kimiPaths.fallbackPaths!({ userHome: "/u", platform: "linux", linuxInstallDirs: [], join })[0]).toBe("/u/.kimi-code/bin/kimi");
    expect(kimiSpec.models.shortName?.("kimi-code/k3")).toBe("Kimi K3");
    expect(kimiSpec.models.shortName?.("kimi-k3.1-pro")).toBe("Kimi K3.1 Pro");
  });
});

describe("kimi turn outcome from wire.jsonl", () => {
  it("ignores failures written before this prompt and reports the one it appended", async () => {
    const wire = wirePath(dir);
    writeFileSync(wire, failedTurn(0));
    const watch = createKimiPromptOutcomeWatch(dir);
    const completed = watch({ sessionId: SESSION_ID })!;
    appendFileSync(wire, completedTurn(1));
    expect(await completed({ stopReason: "end_turn" })).toBeNull();

    const failed = watch({ sessionId: SESSION_ID })!;
    const line = failedTurn(2);
    appendFileSync(wire, line.slice(0, 30));
    const pending = failed({ stopReason: "end_turn" });
    setTimeout(() => appendFileSync(wire, line.slice(30)), 80);
    expect(await pending).toEqual({ subtype: "quota_exceeded", message: "upstream limited (provider.rate_limit)" });
  });

  it("finds a new session's wire file created by the first prompt and rejects unsafe session IDs", async () => {
    const watch = createKimiPromptOutcomeWatch(dir);
    const check = watch({ sessionId: SESSION_ID })!;
    writeFileSync(wirePath(dir), failedTurn(0, "provider.overloaded"));
    expect(await check({ stopReason: "end_turn" })).toEqual({ subtype: "error_during_execution", message: "upstream limited (provider.overloaded)" });
    expect(watch({ sessionId: "../etc" })).toBeNull();
  });

  it("decodes only the tail and classifies quota and auth codes", () => {
    const wire = wirePath(dir);
    writeFileSync(wire, `${"x".repeat(100_000)}\n${failedTurn(3, "exceeded_current_quota_error")}`);
    expect(readKimiTurnEnded(wire, 0)).toEqual({ reason: "failed", error: { code: "exceeded_current_quota_error", message: "upstream limited" } });
    expect(classifyKimiTurnEnded({ reason: "failed", error: { code: "provider.auth_error" } })?.subtype).toBe("auth_required");
    expect(classifyKimiTurnEnded({ reason: "completed" })).toBeNull();
  });
});

describe("kimi permissions and models", () => {
  const request = (title: string): RequestPermissionRequest => ({ sessionId: "s", toolCall: { toolCallId: "t", title }, options: [] });
  const ctx = (title: string) => ({ request: request(title), readonlyPolicy: null, closing: false, signal: new AbortController().signal });

  it("cancels AskUserQuestion prompts and leaves tool approvals to the default policy", () => {
    expect(decideKimiPermission(ctx("AskUserQuestion"))).toEqual({ outcome: "cancelled" });
    expect(decideKimiPermission(ctx("Bash"))).toBeNull();
  });

  it("matches listed aliases and skips models the session does not offer", () => {
    const option: SessionConfigOption = {
      id: "model", name: "Model", category: "model", type: "select", currentValue: "kimi-code/k3",
      options: [{ value: "kimi-code/k3", name: "K3" }, { value: "kimi-code/k3.1-pro", name: "K3.1 Pro" }],
    };
    expect(resolveKimiModelValue("k3.1-pro", option)).toBe("kimi-code/k3.1-pro");
    expect(resolveKimiModelValue("KIMI-CODE/K3", option)).toBe("kimi-code/k3");
    expect(resolveKimiModelValue("gpt-6", option)).toBeNull();
  });
});

describe("kimi catalog, sync, setup, composer", () => {
  it("reads models and sign-in state from config.toml, credentials, and the env model", () => {
    writeFileSync(join(dir, "config.toml"), 'default_model = "kimi-code/k3"\n[models."moonshot/kimi-k3"]\ndisplay_name = "Moonshot K3"\n');
    const signedOut = readKimiCatalogRaw(dir, {});
    expect(kimiCatalogProbe.availabilityOf(signedOut)).toBe("signed_out");
    expect(parseKimiCatalog(signedOut).models.map((m) => m.id)).toEqual(["kimi-code/k3", "moonshot/kimi-k3"]);
    expect(kimiCatalogProbe.availabilityOf(readKimiCatalogRaw(dir, { KIMI_MODEL_API_KEY: "sk" }))).toBe("available");
    mkdirSync(join(dir, "credentials"));
    writeFileSync(join(dir, "credentials", "kimi-code.json"), "{}");
    expect(kimiCatalogProbe.availabilityOf(readKimiCatalogRaw(dir, {}))).toBe("available");
  });

  it("syncs mcp.json, skipping disabled servers and naming SSE transport explicitly", () => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".kimi-code"), { recursive: true });
    writeFileSync(join(home, ".kimi-code", "mcp.json"), JSON.stringify({ mcpServers: { a: { command: "x", args: ["1"] }, off: { command: "y", enabled: false }, ev: { transport: "sse", url: "https://e" } } }));
    const ctx = { userHome: home, env: {} };
    expect(kimiSyncAdapter.scanMcp(ctx).servers).toEqual({
      a: { transport: "stdio", command: "x", args: ["1"], env: {} },
      ev: { transport: "sse", url: "https://e", headers: {} },
    });
    const plan = kimiSyncAdapter.planMcpPatch(ctx, { upsert: { legacy: { transport: "sse", url: "https://l", headers: {} } }, removeNames: new Set(["a"]) });
    expect(JSON.parse(plan.nextContent!).mcpServers).toEqual({ off: { command: "y", enabled: false }, ev: { transport: "sse", url: "https://e" }, legacy: { transport: "sse", url: "https://l" } });
  });

  it("installs with the official scripts, signs in with the device code, and maps a platform key to KIMI_MODEL_*", async () => {
    expect(kimiSetupAdapter.installRecipe("linux")).toMatchObject({ kind: "posix_script", scriptUrl: "https://code.kimi.com/kimi-code/install.sh" });
    expect(kimiSetupAdapter.installRecipe("win32")).toMatchObject({ kind: "powershell_script", scriptUrl: "https://code.kimi.com/kimi-code/install.ps1", fallback: { packageSpec: "@moonshot-ai/kimi-code" } });
    const secrets = fakeSecrets();
    const ctx = { platform: "darwin", userHome: dir, availability: "signed_out" as const, executablePath: () => "kimi", installed: () => true, env: () => ({}), secrets };
    expect((await kimiSetupAdapter.inspectAuth(ctx)).methods.map((m) => m.kind)).toEqual(["device_code", "api_key"]);
    await kimiSetupAdapter.saveApiKey!(ctx, { targetId: "moonshot-cn", apiKey: " sk-1 " });
    expect(secrets.stored).toEqual({ KIMI_MODEL_API_KEY: "sk-1", KIMI_MODEL_NAME: "kimi-k3", KIMI_MODEL_PROVIDER_TYPE: "kimi", KIMI_MODEL_BASE_URL: "https://api.moonshot.cn/v1" });
    const methods = (await kimiSetupAdapter.inspectAuth(ctx)).methods;
    expect(methods.find((m) => m.kind === "api_key")).toMatchObject({ targets: [{ id: "moonshot-ai", configured: false }, { id: "moonshot-cn", configured: true }] });

    const creds = join(dir, ".kimi-code", "credentials");
    mkdirSync(join(creds, "mcp"), { recursive: true });
    writeFileSync(join(creds, "kimi-code.json"), "{}");
    writeFileSync(join(creds, "mcp", "github.json"), "{}");
    await kimiSetupAdapter.signOut(ctx);
    expect(secrets.stored).toEqual({});
    expect(existsSync(join(creds, "kimi-code.json"))).toBe(false);
    expect(existsSync(join(creds, "mcp", "github.json"))).toBe(true);
  });

  it("offers the ACP built-ins while idle and disables auto-update at launch", async () => {
    expect(await createKimiComposer().queryCommands({ cwd: dir, addDirs: [] }, new AbortController().signal)).toEqual(KIMI_BUILTIN_COMMANDS);
    expect(kimiDaemon.launchFiles?.({ role: "pm", stateDir: dir, osSandboxed: false })).toEqual({ env: { KIMI_CODE_NO_AUTO_UPDATE: "1" } });
  });
});

describe("kimi driver over the fake ACP agent", () => {
  const drivers: Driver[] = [];
  afterEach(async () => {
    for (const d of drivers.splice(0)) await d.shutdown();
  });

  function harness(script: FakeAcpScript, kimiHome: string) {
    const cwd = join(dir, "workspace");
    mkdirSync(cwd, { recursive: true });
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "system", "utf8");
    const scriptFile = join(dir, "script.json");
    writeFileSync(scriptFile, JSON.stringify(script), "utf8");
    const logFile = join(dir, "fake.log");
    const wrapper = writeExecutableNodeScript(
      join(dir, "kimi"),
      `
const child = require("node:child_process").spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(FAKE_ACP_AGENT)}, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
`,
    );
    const store = new MemorySessionStore();
    const row: AgentSessionRow = {
      id: 1, role: "pm", conversationId: 10, pmId: 1, workerId: null, vendor: "kimi", vendorSessionId: "", cwd, addDirs: [],
      generation: 1, model: null, effort: null, pid: null, status: "idle", hasCompletedTurn: false, lastEventAt: null,
      rateLimit: null, usage: { ...EMPTY_TOKEN_USAGE }, createdAt: Date.now(), updatedAt: Date.now(),
    };
    store.add(row);
    const driver = createKimiDriver({
      store,
      executablePath: wrapper,
      log: () => {},
      env: { KIMI_CODE_HOME: kimiHome },
      prepareLaunch: async () => ({
        promptFile,
        fingerprint: "fp",
        env: { ...process.env, FAKE_ACP_SCRIPT: scriptFile, FAKE_ACP_LOG: logFile, FAKE_ACP_STATE: join(dir, "state") } as Record<string, string>,
      }),
    });
    drivers.push(driver);
    const events: DriverEvent[] = [];
    driver.onEvent((_id, ev) => events.push(ev));
    const logs = (): FakeAcpLogEntry[] =>
      existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeAcpLogEntry) : [];
    const turnEnded = async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const hit = events.find((e): e is Extract<DriverEvent, { type: "turn.ended" }> => e.type === "turn.ended");
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`no turn.ended; events=${events.map((e) => e.type).join(",")}`);
    };
    return { driver, logs, turnEnded };
  }

  it("fails a turn that kimi answered with end_turn when wire.jsonl records a rate limit, and switches to yolo", async () => {
    const kimiHome = join(dir, "kimi-home");
    const h = harness(
      {
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "yolo", name: "YOLO" }] },
        turns: [{ textChunks: ["partial"], sleepMs: 300 }],
      },
      kimiHome,
    );
    const sent = h.driver.send(1, { messageIds: [1], source: "user", text: "go" });
    const deadline = Date.now() + 10_000;
    let sessionId: string | undefined;
    while (sessionId === undefined && Date.now() < deadline) {
      sessionId = h.logs().find((e) => e.event === "session/prompt")?.sessionId as string | undefined;
      await new Promise((r) => setTimeout(r, 10));
    }
    writeFileSync(wirePath(kimiHome, sessionId!), failedTurn(0));
    await sent;
    const ended = await h.turnEnded();
    expect(ended.ok).toBe(false);
    expect(ended.error).toEqual({ subtype: "quota_exceeded", message: "upstream limited (provider.rate_limit)" });
    expect(h.logs().find((e) => e.event === "spawn")?.argv).toEqual(["acp"]);
    expect(h.logs().filter((e) => e.event === "session/set_mode").map((e) => e.modeId)).toEqual(["yolo"]);
  });
});

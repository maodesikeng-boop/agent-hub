// Invariant: BlindVendorMatrix exhaustively covers every AgentVendor registered in src/shared/vendors.ts.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInsideOrEqual, normalizePathForComparison } from "../../src/daemon/platform/index.ts";
import { vendorSpec, type AgentVendor } from "../../src/shared/vendors.ts";
import { agyIsolatedHomeEnv } from "../../src/vendors/agy/paths.ts";
import { VENDOR_PATHS } from "../../src/vendors/paths-registry.ts";
import { VENDOR_LIST } from "../../src/vendors/registry.ts";
import { assertBlindPromptClean, assertIsolatedWorkspace, buildBlindAgentEnv, resolveRealPath } from "./context-barrier.ts";
import type {
  BlindAction,
  BlindAgentAdapter,
  BlindAgentTurnResponse,
  BlindObservation,
  BlindVendorMatrix,
} from "./types.ts";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HOST_VENDOR_CONFIG_DIRS: readonly string[] = [
  ...new Set([...VENDOR_LIST.flatMap((spec) => spec.home.dirs), ".pi", ".kimi"]),
];

export interface ResolveVendorAdapterOptions {
  readonly vendor: AgentVendor;
  readonly systemPrompt: string;
  readonly blindCwd: string;
  readonly blindHomeDir: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly model?: string;
  readonly effort?: string;
  readonly executablePath?: string;
  readonly repoRoot?: string;
}

export type ParsedBlindResponse =
  | { readonly ok: true; readonly response: BlindAgentTurnResponse }
  | { readonly ok: false; readonly noiseReason: string };

const BLIND_VENDOR_MATRIX: BlindVendorMatrix = {
  claude: {
    vendor: "claude",
    mode: "vision_cli",
    reason: "Supports headless print mode with screenshot and sanitized accessibility tree observations.",
    supportsImageInput: true,
  },
  agy: {
    vendor: "agy",
    mode: "vision_cli",
    reason: "Supports headless print mode with Gemini/Claude models and native screenshot file inspection.",
    supportsImageInput: true,
  },
  codex: {
    vendor: "codex",
    mode: "vision_cli",
    reason: "Supports headless exec mode with image attachments and sanitized accessibility observations.",
    supportsImageInput: true,
  },
  pi: {
    vendor: "pi",
    mode: "a11y_cli",
    reason: "Runs ephemeral zero-tool headless text turns (--no-tools --no-mcp --no-session --no-context-files --no-extensions) over sanitized accessibility snapshots.",
    supportsImageInput: false,
  },
  deepseek: {
    vendor: "deepseek",
    mode: "unsupported",
    reason: "dsh headless single-turn execution without workspace file or shell tools is not yet verified for zero-context isolation.",
    supportsImageInput: false,
  },
  cursor: {
    vendor: "cursor",
    mode: "unsupported",
    reason: "cursor-agent print mode enables write and shell tools without a verified zero-tool isolation contract.",
    supportsImageInput: false,
  },
  opencode: {
    vendor: "opencode",
    mode: "unsupported",
    reason: "opencode headless single-turn execution without workspace file or shell tools is not yet verified for zero-context isolation.",
    supportsImageInput: false,
  },
  kimi: {
    vendor: "kimi",
    mode: "unsupported",
    reason: "kimi headless single-turn execution without workspace file or shell tools is not yet verified for zero-context isolation.",
    supportsImageInput: false,
  },
};

const EXTRA_MODEL_ENV_KEYS: Readonly<Record<AgentVendor, readonly string[]>> = {
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  agy: ["GEMINI_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  pi: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  cursor: ["CURSOR_API_KEY"],
  opencode: ["OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"],
  kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
};

const FORBIDDEN_PASSTHROUGH_KEYS = new Set(["HUB_TOKEN", "HUB_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"]);

/**
 * Postcondition: returns the deduplicated credential env keys declared for vendor in VENDOR_PATHS plus safe model keys present in baseEnv.
 */
export function collectVendorCredentialEnvKeys(
  vendor: AgentVendor,
  baseEnv: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const keys = new Set<string>(EXTRA_MODEL_ENV_KEYS[vendor]);
  const cred = VENDOR_PATHS[vendor].credentialEnv;
  if (cred?.names) {
    for (const name of cred.names) keys.add(name);
  }
  if (cred?.prefixes || cred?.pattern) {
    for (const key of Object.keys(baseEnv)) {
      const upper = key.toUpperCase();
      if (FORBIDDEN_PASSTHROUGH_KEYS.has(upper) || upper.startsWith("AGENT_HUB_")) continue;
      if (cred.prefixes?.some((prefix) => key.startsWith(prefix)) || cred.pattern?.test(key)) {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

/**
 * Postcondition: returns a complete support entry for every AgentVendor in VENDOR_LIST without silent omissions.
 */
export function listBlindVendorSupport(): BlindVendorMatrix {
  return BLIND_VENDOR_MATRIX;
}

function extractJsonCandidate(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced && fenced[1]) {
    const inner = fenced[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) return inner;
  }
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = firstBrace; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(firstBrace, i + 1);
    }
  }
  return null;
}

function parseActionObject(rawAction: unknown): { readonly ok: true; readonly action: BlindAction } | { readonly ok: false; readonly reason: string } {
  if (typeof rawAction !== "object" || rawAction === null || Array.isArray(rawAction)) {
    return { ok: false, reason: "action must be an object" };
  }
  const a = rawAction as Record<string, unknown>;
  switch (a.kind) {
    case "click_point":
      if (typeof a.x !== "number" || !Number.isFinite(a.x) || typeof a.y !== "number" || !Number.isFinite(a.y)) {
        return { ok: false, reason: "click_point requires finite numeric x and y" };
      }
      if (a.x < 0 || a.x > 1000 || a.y < 0 || a.y > 1000) {
        return { ok: false, reason: `click_point coordinates (${a.x}, ${a.y}) must be normalized within [0, 1000]` };
      }
      return { ok: true, action: { kind: "click_point", x: a.x, y: a.y } };
    case "click_label":
      if (typeof a.label !== "string" || a.label.trim() === "") {
        return { ok: false, reason: "click_label requires non-empty label" };
      }
      if (a.role !== undefined && typeof a.role !== "string") {
        return { ok: false, reason: "click_label role must be a string when present" };
      }
      return {
        ok: true,
        action: a.role !== undefined ? { kind: "click_label", role: a.role, label: a.label } : { kind: "click_label", label: a.label },
      };
    case "type":
      if (typeof a.text !== "string") {
        return { ok: false, reason: "type requires string text" };
      }
      if (a.submit !== undefined && typeof a.submit !== "boolean") {
        return { ok: false, reason: "type submit must be boolean when present" };
      }
      return {
        ok: true,
        action: a.submit !== undefined ? { kind: "type", text: a.text, submit: a.submit } : { kind: "type", text: a.text },
      };
    case "press":
      if (typeof a.key !== "string" || a.key.trim() === "") {
        return { ok: false, reason: "press requires non-empty key" };
      }
      return { ok: true, action: { kind: "press", key: a.key } };
    case "scroll":
      if (typeof a.deltaY !== "number" || !Number.isFinite(a.deltaY)) {
        return { ok: false, reason: "scroll requires finite numeric deltaY" };
      }
      return { ok: true, action: { kind: "scroll", deltaY: a.deltaY } };
    case "reload":
      return { ok: true, action: { kind: "reload" } };
    case "wait":
      if (typeof a.reason !== "string" || a.reason.trim() === "") {
        return { ok: false, reason: "wait requires non-empty reason" };
      }
      return { ok: true, action: { kind: "wait", reason: a.reason } };
    case "note_friction":
      if (typeof a.summary !== "string" || a.summary.trim() === "") {
        return { ok: false, reason: "note_friction requires non-empty summary" };
      }
      return { ok: true, action: { kind: "note_friction", summary: a.summary } };
    case "finish":
      if (typeof a.achieved !== "boolean" || typeof a.summary !== "string" || a.summary.trim() === "") {
        return { ok: false, reason: "finish requires boolean achieved and non-empty summary" };
      }
      return { ok: true, action: { kind: "finish", achieved: a.achieved, summary: a.summary } };
    default:
      return { ok: false, reason: `unknown action kind: ${String(a.kind)}` };
  }
}

/**
 * Precondition: rawOutput is raw stdout returned by a blind-agent vendor CLI.
 * Postcondition: parses a valid BlindAgentTurnResponse or returns ok=false with a structured harness_noise reason without throwing.
 */
export function parseBlindActionResponse(rawOutput: string): ParsedBlindResponse {
  const candidate = extractJsonCandidate(rawOutput);
  if (candidate === null) {
    return {
      ok: false,
      noiseReason: rawOutput.trim() === "" ? "empty_vendor_output" : "non_json_vendor_output",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return { ok: false, noiseReason: "truncated_or_invalid_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, noiseReason: "response_not_json_object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.thought !== "string" || obj.thought.trim() === "") {
    return { ok: false, noiseReason: "missing_thought_field" };
  }
  let confusion: string | null = null;
  if (obj.confusion !== undefined && obj.confusion !== null) {
    if (typeof obj.confusion !== "string") {
      return { ok: false, noiseReason: "invalid_confusion_field" };
    }
    confusion = obj.confusion.trim() === "" ? null : obj.confusion.trim();
  }
  const actionResult = parseActionObject(obj.action);
  if (!actionResult.ok) {
    return { ok: false, noiseReason: `invalid_action: ${actionResult.reason}` };
  }
  return {
    ok: true,
    response: {
      thought: obj.thought.trim(),
      confusion,
      action: actionResult.action,
    },
  };
}

function formatTurnPrompt(
  systemPrompt: string,
  observation: BlindObservation,
  supportsImageInput: boolean,
): string {
  const journalBlock =
    observation.recentJournal.length > 0
      ? observation.recentJournal.map((entry, idx) => `${idx + 1}. ${entry}`).join("\n")
      : "(none yet)";
  const screenshotNote =
    supportsImageInput && existsSync(observation.screenshotPath)
      ? `Current screenshot image file (you may inspect it visually with read_file if available, do not read any other files): ${observation.screenshotPath}`
      : "Use the sanitized visible UI controls below.";

  return [
    systemPrompt,
    "",
    `Step: ${observation.stepIndex}`,
    `Mission: ${observation.missionId}`,
    `Viewport: ${observation.viewport.kind} (${observation.viewport.width}x${observation.viewport.height}); click_point uses normalized [0, 1000] coordinates`,
    `Current URL: ${observation.url}`,
    screenshotNote,
    "",
    "Recent actions and context:",
    journalBlock,
    "",
    "Visible UI controls (sanitized accessibility snapshot):",
    observation.a11yText || "(empty page)",
    "",
    "Choose your next single action as a new user and reply with ONLY the JSON object.",
  ].join("\n");
}

function trimTrailingSlashes(pathValue: string): string {
  return pathValue.replace(/[\\/]+$/, "");
}

function comparisonKey(pathValue: string, platform: NodeJS.Platform): string {
  const normalized = normalizePathForComparison(pathValue);
  return platform === "darwin" || platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertDistinctFromHostHome(
  blindHomeDir: string,
  baseEnv: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string {
  const hostHome = baseEnv.HOME?.trim() || baseEnv.USERPROFILE?.trim() || homedir();
  const realBlind = resolveRealPath(blindHomeDir, platform);
  const realHost = resolveRealPath(hostHome, platform);
  const blindKey = comparisonKey(realBlind, platform);
  const hostKey = comparisonKey(realHost, platform);
  if (blindKey === hostKey) {
    throw new Error(`Blind agent HOME (${blindHomeDir}) must be isolated from host HOME (${hostHome})`);
  }
  for (const rel of HOST_VENDOR_CONFIG_DIRS) {
    const vendorDir = resolveRealPath(join(realHost, rel), platform);
    const vendorDirKey = comparisonKey(vendorDir, platform);
    if (isPathInsideOrEqual(blindKey, vendorDirKey) || isPathInsideOrEqual(vendorDirKey, blindKey)) {
      throw new Error(`Blind agent HOME (${blindHomeDir}) overlaps host vendor config directory ${vendorDir}`);
    }
  }
  return realHost;
}

function buildVendorCliCommand(
  options: ResolveVendorAdapterOptions,
  prompt: string,
  observation: BlindObservation,
  hostHome: string,
  repoRoot: string,
): { readonly command: string; readonly args: readonly string[] } {
  const command = options.executablePath ?? vendorSpec(options.vendor).cli.command;
  const platform = options.platform ?? process.platform;
  switch (options.vendor) {
    case "agy": {
      const allowRules = existsSync(observation.screenshotPath)
        ? [`read_file(${resolveRealPath(observation.screenshotPath, platform)})`]
        : [];
      const blockedReadRoots = [
        ...new Set([trimTrailingSlashes(resolveRealPath(repoRoot, platform)), trimTrailingSlashes(hostHome)]),
      ].filter((p) => p.length > 0);
      const denyRules = [
        "write_file(*)",
        "command(*)",
        "read_url(*)",
        "mcp(*)",
        ...blockedReadRoots.flatMap((root) => [`read_file(${root})`, `read_file(${root}/*)`]),
      ];
      const agySettings = {
        enableTerminalSandbox: false,
        permissions: {
          allow: allowRules,
          deny: denyRules,
        },
      };
      const args: string[] = [
        "--output-format",
        "text",
        "--disable-slash-commands",
        "--settings",
        JSON.stringify(agySettings),
      ];
      if (options.model) args.push("--model", options.model);
      if (options.effort) args.push("--effort", options.effort);
      args.push("-p", prompt);
      return { command, args };
    }
    case "claude": {
      const args: string[] = [
        "-p",
        prompt,
        "--output-format",
        "text",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--settings",
        JSON.stringify({ disableAllHooks: true }),
        "--permission-mode",
        "dontAsk",
      ];
      if (existsSync(observation.screenshotPath)) {
        args.push(
          "--tools",
          "Read",
          "--allowedTools",
          `Read(${resolveRealPath(observation.screenshotPath, platform)})`,
          "--disallowedTools",
          "Bash,Edit,Write,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Agent,Task",
        );
      } else {
        args.push("--tools", "", "--disallowedTools", "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Agent,Task");
      }
      if (options.model) args.push("--model", options.model);
      return { command, args };
    }
    case "codex": {
      const args: string[] = [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-c",
        "features.shell_tool=false",
        "-C",
        options.blindCwd,
      ];
      if (existsSync(observation.screenshotPath)) args.push("-i", observation.screenshotPath);
      if (options.model) args.push("-m", options.model);
      args.push(prompt);
      return { command, args };
    }
    case "pi": {
      const args: string[] = [
        "--no-tools",
        "--no-mcp",
        "--no-session",
        "--no-context-files",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--exclude-tools",
        "bash,edit,write,read,grep,find,ls",
      ];
      if (options.model) args.push("--model", options.model);
      if (options.effort) args.push("--thinking", options.effort);
      args.push("-p", prompt);
      return { command, args };
    }
    default:
      throw new Error(`Blind walkthrough vendor ${options.vendor} has no verified isolated CLI command`);
  }
}

function runVendorProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) {
      reject(new Error(`Blind agent aborted before start: ${String(signal.reason ?? "aborted")}`));
      return;
    }
    const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const onAbort = () => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error(`Blind agent timed out or aborted: ${String(signal.reason ?? "aborted")}`));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        reject(new Error(`Blind vendor CLI spawn error (${command}): ${error.message}`));
      }
    });
    child.once("exit", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`Blind vendor CLI exited with code ${String(code)}: ${stderr.slice(-400)}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

/**
 * Precondition: options.vendor is a registered AgentVendor and options.blindCwd is an isolated empty directory.
 * Postcondition: returns a headless BlindAgentAdapter with an immutable system prompt, or throws when the vendor is unsupported.
 */
export function resolveBlindVendorAdapter(options: ResolveVendorAdapterOptions): BlindAgentAdapter {
  const support = BLIND_VENDOR_MATRIX[options.vendor];
  if (!support || support.mode === "unsupported") {
    throw new Error(`Blind walkthrough vendor ${options.vendor} is unsupported: ${support?.reason ?? "unknown vendor"}`);
  }
  const platform = options.platform ?? process.platform;
  const baseEnv = options.baseEnv ?? process.env;
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  assertIsolatedWorkspace(options.blindCwd, { env: baseEnv, platform });
  assertIsolatedWorkspace(options.blindHomeDir, { env: baseEnv, platform });
  const hostHome = assertDistinctFromHostHome(options.blindHomeDir, baseEnv, platform);

  const env = buildBlindAgentEnv(
    baseEnv,
    options.blindHomeDir,
    platform,
    collectVendorCredentialEnvKeys(options.vendor, baseEnv),
  );
  const configHome = vendorSpec(options.vendor).home.configHome;
  if (configHome) {
    env[configHome.env] = join(options.blindHomeDir, configHome.rel);
  }
  if (options.vendor === "agy") {
    Object.assign(env, agyIsolatedHomeEnv({ platform, env, userHome: options.blindHomeDir, exists: existsSync }));
  } else if (options.vendor === "claude") {
    env.CLAUDE_CONFIG_DIR = join(options.blindHomeDir, ".claude");
  }
  const fixedSystemPrompt = options.systemPrompt;

  return {
    id: options.vendor,
    systemPrompt: fixedSystemPrompt,
    async decideNext(observation, signal) {
      const prompt = formatTurnPrompt(fixedSystemPrompt, observation, support.supportsImageInput);
      assertBlindPromptClean(prompt, { repoRoot });
      const { command, args } = buildVendorCliCommand(options, prompt, observation, hostHome, repoRoot);
      const rawOutput = await runVendorProcess(command, args, options.blindCwd, env, signal);
      const parsed = parseBlindActionResponse(rawOutput);
      if (!parsed.ok) {
        throw new Error(`blind_vendor_parse_error(${parsed.noiseReason}): ${rawOutput.slice(0, 200)}`);
      }
      return parsed.response;
    },
  };
}

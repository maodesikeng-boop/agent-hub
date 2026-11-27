// Invariant: BlindVendorMatrix exhaustively covers every AgentVendor registered in src/shared/vendors.ts.
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import type { AgentVendor } from "../../src/shared/vendors.ts";
import { assertIsolatedWorkspace, buildBlindAgentEnv } from "./context-barrier.ts";
import type {
  BlindAction,
  BlindAgentAdapter,
  BlindAgentTurnResponse,
  BlindObservation,
  BlindVendorMatrix,
} from "./types.ts";

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
  readonly useHostAuthHome?: boolean;
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
    reason: "Runs headless text turns over sanitized accessibility snapshots.",
    supportsImageInput: false,
  },
  deepseek: {
    vendor: "deepseek",
    mode: "a11y_cli",
    reason: "Runs headless text turns over sanitized accessibility snapshots.",
    supportsImageInput: false,
  },
  cursor: {
    vendor: "cursor",
    mode: "a11y_cli",
    reason: "Runs headless text turns over sanitized accessibility snapshots.",
    supportsImageInput: false,
  },
  opencode: {
    vendor: "opencode",
    mode: "a11y_cli",
    reason: "Runs headless text turns over sanitized accessibility snapshots.",
    supportsImageInput: false,
  },
  kimi: {
    vendor: "kimi",
    mode: "a11y_cli",
    reason: "Runs headless text turns over sanitized accessibility snapshots.",
    supportsImageInput: false,
  },
};

const ALLOWED_MODEL_ENV_KEYS: Readonly<Record<AgentVendor, readonly string[]>> = {
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  agy: ["GEMINI_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  pi: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  cursor: ["CURSOR_API_KEY"],
  opencode: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"],
  kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
};

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
    `Viewport: ${observation.viewport.kind} (${observation.viewport.width}x${observation.viewport.height})`,
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

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function buildVendorCliCommand(
  options: ResolveVendorAdapterOptions,
  prompt: string,
  observation: BlindObservation,
): { readonly command: string; readonly args: readonly string[] } {
  const command = options.executablePath ?? options.vendor;
  switch (options.vendor) {
    case "agy": {
      const allowRules = existsSync(observation.screenshotPath) ? [`read_file(${realpathOrSelf(observation.screenshotPath)})`] : [];
      const agySettings = {
        enableTerminalSandbox: false,
        permissions: {
          allow: allowRules,
          deny: ["write_file(*)", "command(*)", "read_url(*)", "mcp(*)"],
        },
      };
      const args: string[] = [
        "--mode",
        "plan",
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
      const args: string[] = ["-p", prompt, "--output-format", "text"];
      if (options.model) args.push("--model", options.model);
      return { command, args };
    }
    case "codex": {
      const args: string[] = ["exec", "--skip-git-repo-check"];
      if (existsSync(observation.screenshotPath)) args.push("-i", observation.screenshotPath);
      if (options.model) args.push("-m", options.model);
      args.push(prompt);
      return { command, args };
    }
    default:
      return { command, args: ["-p", prompt] };
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
  assertIsolatedWorkspace(options.blindCwd, { env: options.baseEnv, platform: options.platform });
  assertIsolatedWorkspace(options.blindHomeDir, { env: options.baseEnv, platform: options.platform });

  const baseEnv = options.baseEnv ?? process.env;
  const env = buildBlindAgentEnv(
    baseEnv,
    options.blindHomeDir,
    options.platform ?? process.platform,
    ALLOWED_MODEL_ENV_KEYS[options.vendor],
  );
  // Some CLIs (such as macOS agy) read Google OAuth from the host keychain under HOME; preserve only HOME when explicitly opted in while keeping cwd empty and Bellwood/GH/SSH env scrubbed.
  if (options.useHostAuthHome && baseEnv.HOME) {
    env.HOME = baseEnv.HOME;
    env.USERPROFILE = baseEnv.USERPROFILE ?? baseEnv.HOME;
  }
  const fixedSystemPrompt = options.systemPrompt;

  return {
    id: options.vendor,
    systemPrompt: fixedSystemPrompt,
    async decideNext(observation, signal) {
      const prompt = formatTurnPrompt(fixedSystemPrompt, observation, support.supportsImageInput);
      const { command, args } = buildVendorCliCommand(options, prompt, observation);
      const rawOutput = await runVendorProcess(command, args, options.blindCwd, env, signal);
      const parsed = parseBlindActionResponse(rawOutput);
      if (!parsed.ok) {
        throw new Error(`blind_vendor_parse_error(${parsed.noiseReason}): ${rawOutput.slice(0, 200)}`);
      }
      return parsed.response;
    },
  };
}

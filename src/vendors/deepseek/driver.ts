import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentSessionRow, Driver, LaunchFiles } from "../../shared/index.ts";
import { DEEPSEEK_PROFILE_INIT_TIMEOUT_MS } from "../../shared/limits.ts";
import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import {
  createAcpDriver,
  defaultClassifyAcpTurnError,
  defaultIsAcpSessionNotFoundError,
  flattenConfigSelectOptions,
  type AcpDriverConfig,
  type AcpDriverOptions,
  type AcpLaunchContext,
} from "../_common/acp/index.ts";
import { resolveDeepSeekHome } from "./paths.ts";
import { loadDeepSeekAcpMcpServers } from "./sync.ts";
import { resolveSpawn } from "../../daemon/platform/index.ts";
import { deepseekSkillFilesystemConfig, filterDeepSeekMcpServers } from "./capabilities.ts";

export interface DeepSeekCordisPatchEntry {
  id: string;
  config: Record<string, unknown>;
}

// dsh's own Seatbelt/bwrap sandbox cannot nest (exit 71 on macOS, userns conflicts on Linux).
export const DEEPSEEK_SANDBOX_PATCH_ENTRIES: readonly DeepSeekCordisPatchEntry[] = [
  { id: "sandbox-policy", config: { mode: "danger-full-access" } },
  { id: "approval", config: { policy: "never" } },
  { id: "permission", config: { defaultPreset: "danger-full-access" } },
];

export const DEEPSEEK_DEFAULT_PROVIDER = "deepseek-official";

const DEEPSEEK_PROFILE = "acp";

// profiles/ and storages/ hold code later PM or Worker runs execute, so they stay read-only.
export const DEEPSEEK_READONLY_RUNTIME_SUBDIRS: readonly string[] = ["llm-deepseek"];

// dsh rewrites the profile root config on every start.
const DEEPSEEK_READONLY_RUNTIME_FILES: readonly string[] = [`profiles/${DEEPSEEK_PROFILE}/cordis.yml`, ".anonymous-user-id"];

const DEEPSEEK_SELF_CREDENTIAL_FILES: readonly string[] = [".credentials.yaml", ".env"];

const READONLY_STATE_DIR = "dsh-readonly-state";

export const DEEPSEEK_WRITE_TOOL_NAMES: readonly string[] = [
  "write",
  "edit",
  "apply_patch",
  "str_replace_editor",
  "todo_write",
  "create_goal",
  "update_goal",
  "working_directory",
  "create_worktree",
  "schedule_create",
  "schedule_edit",
  "terminal_open",
  "terminal_send",
  "pwsh",
];

// --patch replaces the whole line config (applyPatches does not merge), so the default personaPrefix is copied here.
export const DEEPSEEK_DEFAULT_PERSONA_PREFIX = "You are a coding agent powered by the {{model}} model.";

// dsh templates have no escaping and fail on unknown {{...}}; break them with a zero-width space (lossy).
export function escapeDshPromptTemplate(text: string): string {
  return text.replace(/\{(?=\{)/g, "{\u200b");
}

// personaSuffix lands in the system message, which dsh compaction keeps.
export function buildDeepSeekSystemPromptPatch(prompt: string): readonly DeepSeekCordisPatchEntry[] | null {
  const text = prompt.trim();
  if (text === "") return null;
  return [
    {
      id: "system-prompt",
      config: { personaPrefix: DEEPSEEK_DEFAULT_PERSONA_PREFIX, personaSuffix: escapeDshPromptTemplate(text) },
    },
  ];
}

// dsh-tool-skill lists customSkillDirs to the model before the first request (dsh 0.2.2-rc.1).
export function buildDeepSeekSkillsPatch(skillsDir: string): readonly DeepSeekCordisPatchEntry[] {
  return [{ id: "skill-filesystem", config: { customSkillDirs: [skillsDir] } }];
}

export function buildDeepSeekPatchSettings(): string {
  return `${JSON.stringify(DEEPSEEK_SANDBOX_PATCH_ENTRIES, null, 2)}\n`;
}

export function parseDeepSeekModelSpec(rawModel: string): { provider: string; model: string; explicitProvider: boolean } {
  const trimmed = rawModel.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        typeof parsed[0] === "string" &&
        parsed[0].trim() !== "" &&
        typeof parsed[1] === "string" &&
        parsed[1].trim() !== ""
      ) {
        return { provider: parsed[0].trim(), model: parsed[1].trim(), explicitProvider: true };
      }
    } catch {
    }
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash + 1 < trimmed.length) {
    return {
      provider: trimmed.slice(0, slash).trim(),
      model: trimmed.slice(slash + 1).trim(),
      explicitProvider: true,
    };
  }
  return { provider: DEEPSEEK_DEFAULT_PROVIDER, model: trimmed, explicitProvider: false };
}

function parseTupleChoice(raw: string): [string, string] | null {
  if (!raw.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
  }
  return null;
}

export function resolveDeepSeekModelOptionValue(
  requestedModel: string,
  option: SessionConfigOption | null,
): string | null {
  const trimmed = requestedModel.trim();
  if (!trimmed || !option) return null;
  const choices = flattenConfigSelectOptions(option);
  if (choices.length === 0) return null;

  const exact = choices.find((c) => c.value === trimmed);
  if (exact) return exact.value;

  const spec = parseDeepSeekModelSpec(trimmed);
  const tupleChoices = choices
    .map((c) => ({ raw: c.value, tuple: parseTupleChoice(c.value) }))
    .filter((entry): entry is { raw: string; tuple: [string, string] } => entry.tuple !== null);

  if (tupleChoices.length > 0) {
    if (spec.explicitProvider) {
      const exactPair = tupleChoices.find(
        ({ tuple }) => tuple[0] === spec.provider && tuple[1] === spec.model,
      );
      if (exactPair) return exactPair.raw;
      const lowerPair = tupleChoices.find(
        ({ tuple }) =>
          tuple[0].toLowerCase() === spec.provider.toLowerCase() &&
          tuple[1].toLowerCase() === spec.model.toLowerCase(),
      );
      return lowerPair?.raw ?? null;
    }

    const officialExact = tupleChoices.find(
      ({ tuple }) => tuple[0] === DEEPSEEK_DEFAULT_PROVIDER && tuple[1] === spec.model,
    );
    if (officialExact) return officialExact.raw;
    const anyExact = tupleChoices.find(({ tuple }) => tuple[1] === spec.model);
    if (anyExact) return anyExact.raw;
    const officialLower = tupleChoices.find(
      ({ tuple }) =>
        tuple[0] === DEEPSEEK_DEFAULT_PROVIDER && tuple[1].toLowerCase() === spec.model.toLowerCase(),
    );
    if (officialLower) return officialLower.raw;
    const anyLower = tupleChoices.find(
      ({ tuple }) => tuple[1].toLowerCase() === spec.model.toLowerCase(),
    );
    return anyLower?.raw ?? null;
  }

  const lower = choices.find((c) => c.value.toLowerCase() === trimmed.toLowerCase());
  return lower ? lower.value : trimmed;
}

export function resolveDeepSeekEffortOptionValue(
  requestedEffort: string,
  option: SessionConfigOption | null,
): string | null {
  const trimmed = requestedEffort.trim();
  if (!trimmed || !option) return null;
  const choices = flattenConfigSelectOptions(option);
  if (choices.length === 0) return null;
  const exact = choices.find((c) => c.value === trimmed);
  if (exact) return exact.value;
  const lower = choices.find((c) => c.value.toLowerCase() === trimmed.toLowerCase());
  return lower ? lower.value : null;
}

const ALREADY_QUOTA_RE = /quota[_ ]?exceeded|rate[_ ]?limit|usage[_ ]?limit(?:_reached)?|resource_exhausted|\b429\b|credit balance|quota/i;
const ALREADY_AUTH_RE = /not logged in|unauthenticated|sign in|\b401\b|invalid_api_key/i;
const DEEPSEEK_BALANCE_RE = /insufficient[_ ]balance|\b402\b[\s:.-]*(?:insufficient|payment|balance)?|\bbalance\b[^.\n]*\binsufficient\b/i;
const DEEPSEEK_AUTH_RE =
  /\bno api key\b|\bmissing api key\b|\bDEEPSEEK_API_KEY\b|authentication[_ ]?(?:fails|failed|error)|account_token_invalid|account_sign_in_required|\bunauthorized\b/i;

export function classifyDeepSeekTurnError(error: unknown): { subtype: string; message: string } {
  const base = defaultClassifyAcpTurnError(error);
  const msg = base.message;
  if (DEEPSEEK_BALANCE_RE.test(msg) && !ALREADY_QUOTA_RE.test(msg)) {
    return { subtype: "quota_exceeded", message: `${msg} (quota_exceeded)` };
  }
  if (DEEPSEEK_AUTH_RE.test(msg) && !ALREADY_AUTH_RE.test(msg)) {
    return { subtype: "auth_required", message: `${msg} (invalid_api_key)` };
  }
  return base;
}

export function isDeepSeekSessionNotFoundError(error: unknown): boolean {
  if (defaultIsAcpSessionNotFoundError(error)) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /\bsession is not resumable\b/i.test(msg);
}

function launchDirOf(files: LaunchFiles): string {
  return dirname(files.settingsFile ?? files.promptFile);
}

function readPromptFile(promptFile: string): string {
  try {
    return readFileSync(promptFile, "utf8");
  } catch {
    return "";
  }
}

function buildDeepSeekLaunchArgs(ctx: AcpLaunchContext): string[] {
  const launchDir = launchDirOf(ctx.files);
  let sandboxPatchPath = ctx.files.settingsFile;
  if (!sandboxPatchPath) {
    sandboxPatchPath = join(launchDir, "dsh-sandbox.patch.json");
    writeFileSync(sandboxPatchPath, buildDeepSeekPatchSettings(), "utf8");
  }
  const args = ["--profile", DEEPSEEK_PROFILE, "--patch", sandboxPatchPath];
  const promptPatch = buildDeepSeekSystemPromptPatch(readPromptFile(ctx.files.promptFile));
  const promptPatchPath = join(launchDir, "dsh-system-prompt.patch.json");
  if (promptPatch !== null) {
    writeFileSync(promptPatchPath, `${JSON.stringify(promptPatch, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    args.push("--patch", promptPatchPath);
  } else {
    rmSync(promptPatchPath, { force: true });
  }
  const skillsPatchPath = join(launchDir, "dsh-skills.patch.json");
  const capSkillsCfg = ctx.files.capabilities
    ? deepseekSkillFilesystemConfig(ctx.files.capabilities, ctx.files.skillsDir)
    : null;
  if (capSkillsCfg !== null) {
    const entries: readonly DeepSeekCordisPatchEntry[] = [{ id: "skill-filesystem", config: capSkillsCfg }];
    writeFileSync(skillsPatchPath, `${JSON.stringify(entries, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    args.push("--patch", skillsPatchPath);
  } else if (ctx.files.skillsDir) {
    writeFileSync(skillsPatchPath, `${JSON.stringify(buildDeepSeekSkillsPatch(ctx.files.skillsDir), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    args.push("--patch", skillsPatchPath);
  } else {
    rmSync(skillsPatchPath, { force: true });
  }
  const rawModel = ctx.row.model?.trim() ?? "";
  if (rawModel !== "") {
    const { provider, model } = parseDeepSeekModelSpec(rawModel);
    const modelPatchPath = join(launchDir, "dsh-model.patch.json");
    const modelPatch: readonly DeepSeekCordisPatchEntry[] = [
      { id: "acp", config: { provider, model } },
    ];
    writeFileSync(modelPatchPath, `${JSON.stringify(modelPatch, null, 2)}\n`, "utf8");
    args.push("--patch", modelPatchPath);
  }
  return args;
}

function readonlyStatePatch(stateDir: string): readonly DeepSeekCordisPatchEntry[] {
  return [
    { id: "session-persistence-jsonl", config: { root: join(stateDir, "sessions") } },
    { id: "storage-json", config: { root: join(stateDir, "storages") } },
    { id: "attachment-local", config: { dshHome: stateDir } },
  ];
}

// With profiles/ read-only, dsh cannot initialize inside the sandbox; run --dump-config outside first.
export function ensureDeepSeekProfile(executablePath: string, dshHome: string, env: NodeJS.ProcessEnv, cwd: string): void {
  if (existsSync(join(dshHome, "profiles", DEEPSEEK_PROFILE, "package.json"))) return;
  try {
    if (process.platform === "win32") {
      const resolved = resolveSpawn(
        {
          program: executablePath,
          args: ["--profile", DEEPSEEK_PROFILE, "--dump-config"],
          cwd,
          env,
          stdio: "ignore",
        },
        "win32",
      );
      spawnSync(resolved.file, resolved.args, {
        ...resolved.options,
        timeout: DEEPSEEK_PROFILE_INIT_TIMEOUT_MS,
      });
    } else {
      execFileSync(executablePath, ["--profile", DEEPSEEK_PROFILE, "--dump-config"], { cwd, env, stdio: "ignore", timeout: DEEPSEEK_PROFILE_INIT_TIMEOUT_MS });
    }
  } catch {
  }
}

export function matchesDeepSeekStaleProcess(
  psArgs: string,
  row: AgentSessionRow,
  executablePath: string,
): boolean {
  const exeBase = basename(executablePath);
  const hasBinary =
    psArgs.includes(executablePath) ||
    (exeBase !== "" && psArgs.includes(exeBase)) ||
    /\bdsh\b/.test(psArgs);
  if (!hasBinary) return false;
  if (!/(?:^|\s)--profile\s+acp(?:\s|$)/.test(psArgs)) return false;
  // Only match this session's --patch path; never kill a dsh the user started.
  return /\/launch\/(\d+)\//.exec(psArgs)?.[1] === String(row.id);
}

export function createDeepSeekDriver(options: AcpDriverOptions): Driver {
  const env = { ...process.env, ...options.env };
  // The sandbox compares real paths (/tmp -> /private/tmp).
  const dshHomeOf = (homeDir: string) => {
    const dshHome = resolveDeepSeekHome(homeDir, env);
    try {
      return realpathSync(dshHome);
    } catch {
      return dshHome;
    }
  };

  const launchArgs = (ctx: AcpLaunchContext): string[] => {
    const args = buildDeepSeekLaunchArgs(ctx);
    if (ctx.files.readonly) {
      const launchDir = launchDirOf(ctx.files);
      ensureDeepSeekProfile(ctx.executablePath, resolveDeepSeekHome(undefined, env), env, launchDir);
      const stateDir = join(launchDir, READONLY_STATE_DIR);
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const patchPath = join(launchDir, "dsh-readonly.patch.json");
      writeFileSync(patchPath, `${JSON.stringify(readonlyStatePatch(stateDir), null, 2)}\n`, "utf8");
      args.push("--patch", patchPath);
    }
    return args;
  };

  const config: AcpDriverConfig = {
    vendor: "deepseek",
    launchArgs,
    authenticate: { enabled: false },
    continuation: {
      mode: "resume",
      fallbackToNewOnFailure: true,
      rebakesPersonaOnResume: true,
    },
    session: {
      mcpServers: (ctx) => {
        if (ctx.files.readonly) return [];
        const servers = loadDeepSeekAcpMcpServers(resolveDeepSeekHome(undefined, env));
        return ctx.files.capabilities ? filterDeepSeekMcpServers(servers, ctx.files.capabilities) : servers;
      },
    },
    configOptions: {
      modelOptionIds: ["model"],
      effortOptionIds: ["reasoning_effort"],
      resolveModelValue: (requested, option) => resolveDeepSeekModelOptionValue(requested, option),
      resolveEffortValue: (requested, option) => resolveDeepSeekEffortOptionValue(requested, option),
    },
    permissions: {
      allowOptionKinds: ["allow_always", "allow_once"],
      rejectOptionKinds: ["reject_once", "reject_always"],
      writeToolNames: DEEPSEEK_WRITE_TOOL_NAMES,
    },
    readonlySandbox: {
      writableDirs: (homeDir, _cwd, launch) => {
        const dshHome = dshHomeOf(homeDir);
        const dirs = DEEPSEEK_READONLY_RUNTIME_SUBDIRS.map((sub) => join(dshHome, sub));
        for (const dir of dirs) mkdirSync(dir, { recursive: true, mode: 0o700 });
        return [...dirs, join(launchDirOf(launch.files), READONLY_STATE_DIR)];
      },
      writableFileGlobs: (homeDir) => DEEPSEEK_READONLY_RUNTIME_FILES.map((f) => join(dshHomeOf(homeDir), f)),
      readableFiles: (homeDir) => DEEPSEEK_SELF_CREDENTIAL_FILES.map((f) => join(dshHomeOf(homeDir), f)),
    },
    errors: {
      classifyTurnError: classifyDeepSeekTurnError,
      isSessionNotFoundError: isDeepSeekSessionNotFoundError,
    },
    staleProcess: {
      matchesCommand: matchesDeepSeekStaleProcess,
    },
  };

  return createAcpDriver(config, options);
}

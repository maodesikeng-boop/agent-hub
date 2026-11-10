// DeepSeek Harness（`dsh --profile acp`）会话驱动：基于通用 ACP 驱动底座（src/vendors/_common/acp/）的薄封装。
// 核实细节与出处见 docs/vendors/deepseek.md。
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  scanSecretGlobs,
  wrapInReadonlyOsSandbox,
  type ReadonlySandboxInput,
} from "../../daemon/driver/write-scope.ts";
import type { AgentSessionRow, Driver, SessionId, SessionStore } from "../../shared/index.ts";
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

/** Cordis loader overlay patch 单项。 */
export interface DeepSeekCordisPatchEntry {
  id: string;
  config: Record<string, unknown>;
}

/**
 * 关闭 dsh 自带的 Seatbelt / bwrap 沙箱与交互式审批，交由外层 write-scope / 只读 OS 沙箱统一接管，
 * 避免 macOS sandbox-exec 嵌套 exit 71 与 Linux bwrap userns 嵌套冲突。
 */
export const DEEPSEEK_SANDBOX_PATCH_ENTRIES: readonly DeepSeekCordisPatchEntry[] = [
  { id: "sandbox-policy", config: { mode: "danger-full-access" } },
  { id: "approval", config: { policy: "never" } },
  { id: "permission", config: { defaultPreset: "danger-full-access" } },
];

/** dsh 默认官方 API 路由名（@deepseek-ai/dsh-acp 默认 provider）。 */
export const DEEPSEEK_DEFAULT_PROVIDER = "deepseek-official";

/** 只读 Worker 下 dsh --profile acp 运行时需可写的非敏感子目录（相对 $DSH_HOME，不含根目录与凭据文件）。 */
export const DEEPSEEK_READONLY_RUNTIME_SUBDIRS: readonly string[] = [
  "profiles",
  "sessions",
  "storages",
  "cache",
  "spill",
  "jobs",
  "attachments",
  "llm-deepseek",
];

/** 只读 Worker 下额外拒绝的 dsh 内置写/变更类工具名。 */
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

/** 生成供 daemon.ts launchFiles 写入 settings.json 的 Cordis patch JSON。 */
export function buildDeepSeekPatchSettings(): string {
  return `${JSON.stringify(DEEPSEEK_SANDBOX_PATCH_ENTRIES, null, 2)}\n`;
}

/**
 * 解析会话模型标识为 dsh 的 { provider, model }：
 * - JSON 二元组字符串 `["provider","model"]` -> 原样取出；
 * - 含 `/` 的 `<provider>/<model>` -> 按首个 `/` 拆分；
 * - 裸模型名（如 `deepseek-v4-pro`） -> 默认路由 `deepseek-official`。
 */
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
      // 非法 JSON 按普通模型名继续解析
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
    // 非 JSON 二元组
  }
  return null;
}

/**
 * 将 AgentSessionRow.model 映射为 ACP configOptions(id="model") 的合法 option.value。
 * 兼容 dsh-acp 的 `["provider","model"]` JSON 二元组与通用假 ACP 程序的裸字符串候选。
 */
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

/** 将思考程度映射为 dsh reasoning_effort 选项值；目标模型不支持该档位时返回 null 跳过。 */
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

/**
 * 归一化 dsh / DeepSeek API 的认证缺失与余额不足报错，确保 shared/vendors.ts 的 vendorFailureOf
 * 能精准识别出 auth（缺失/无效 DEEPSEEK_API_KEY、账号令牌失效）与 quota（HTTP 402 Insufficient Balance / 429）。
 */
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

/** 识别 dsh-acp 会话不存在错误（含 -32602 `session is not resumable: <id>`）。 */
export function isDeepSeekSessionNotFoundError(error: unknown): boolean {
  if (defaultIsAcpSessionNotFoundError(error)) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /\bsession is not resumable\b/i.test(msg);
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function trimSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

function buildDeepSeekLaunchArgs(ctx: AcpLaunchContext): string[] {
  const launchDir = dirname(ctx.files.settingsFile ?? ctx.files.promptFile);
  let sandboxPatchPath = ctx.files.settingsFile;
  if (!sandboxPatchPath) {
    sandboxPatchPath = join(launchDir, "dsh-sandbox.patch.json");
    writeFileSync(sandboxPatchPath, buildDeepSeekPatchSettings(), "utf8");
  }
  const args = ["--profile", "acp", "--patch", sandboxPatchPath];
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

/**
 * 适配 dsh-acp 对 `additionalDirectories` 返回 -32602 的限制：
 * 对 ACP 会话层屏蔽 addDirs（以 WeakMap 按原对象缓存，保证引用稳定、零内存泄漏）。
 */
function wrapStoreWithoutAddDirs(store: SessionStore): SessionStore {
  const strippedCache = new WeakMap<AgentSessionRow, AgentSessionRow>();
  const strip = (row: AgentSessionRow | null): AgentSessionRow | null => {
    if (row === null || row.addDirs.length === 0) return row;
    const hit = strippedCache.get(row);
    if (hit) return hit;
    const next: AgentSessionRow = { ...row, addDirs: [] };
    strippedCache.set(row, next);
    return next;
  };
  return {
    get(id: SessionId) {
      return strip(store.get(id));
    },
    update(id, patch) {
      return strip(store.update(id, patch))!;
    },
    listWithProcess() {
      return store.listWithProcess().map((row) => strip(row)!);
    },
  };
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
  const launchMatch = /\/launch\/(\d+)\//.exec(psArgs);
  if (launchMatch && launchMatch[1] !== String(row.id)) return false;
  return true;
}

export function createDeepSeekDriver(options: AcpDriverOptions): Driver {
  const originalStore = options.store;
  const baseReadonlySpawn = options.readonlySpawn ?? wrapInReadonlyOsSandbox;

  const ensureDshRuntimeDirs = (homeDir: string): readonly string[] => {
    const dshHome = resolveDeepSeekHome(homeDir, options.env ?? process.env);
    const dirs: string[] = [];
    for (const sub of DEEPSEEK_READONLY_RUNTIME_SUBDIRS) {
      const target = join(dshHome, sub);
      if (!existsSync(target)) {
        try {
          mkdirSync(target, { recursive: true, mode: 0o700 });
        } catch {
          // 宿主目录只读或无权限时忽略，由外层 existsSync 过滤
        }
      }
      dirs.push(target);
    }
    return dirs;
  };

  const wrappedReadonlySpawn: NonNullable<AcpDriverOptions["readonlySpawn"]> = (base, input) => {
    const homeDir = realpathOrSelf(homedir());
    const dshHome = realpathOrSelf(resolveDeepSeekHome(homeDir, options.env ?? process.env));
    // dsh-credentials-local 启动期会 stat + readFile 自身的 .credentials.yaml（禁读会抛 EPERM / mode 0666 终止启动），
    // 同 agy 放开自身 Keychain 读取一样，对 deepseek 自身只读沙箱放开读、写仍由外层只读沙箱完全禁止。
    const ownCredentialsYaml = trimSlash(realpathOrSelf(join(dshHome, ".credentials.yaml")));
    let secretPaths = input.secretPaths.filter((p) => trimSlash(p) !== ownCredentialsYaml);

    if (process.platform === "linux") {
      // 补扫被 wrapStoreWithoutAddDirs 隐去的原始 addDirs 下的敏感文件通配
      const extraDirs = new Set<string>();
      for (const arg of base.args) {
        const m = /\/launch\/(\d+)\//.exec(arg);
        if (m) {
          const orig = originalStore.get(Number(m[1]) as SessionId);
          for (const d of orig?.addDirs ?? []) extraDirs.add(realpathOrSelf(d));
        }
      }
      if (extraDirs.size > 0) {
        secretPaths = [
          ...new Set([...secretPaths, ...scanSecretGlobs([...extraDirs], input.secretGlobs)]),
        ];
      }
    }

    const adjustedInput: ReadonlySandboxInput = {
      ...input,
      secretPaths,
    };
    return baseReadonlySpawn(base, adjustedInput);
  };

  const config: AcpDriverConfig = {
    vendor: "deepseek",
    launchArgs: buildDeepSeekLaunchArgs,
    authenticate: { enabled: false },
    continuation: {
      mode: "resume",
      fallbackToNewOnFailure: true,
    },
    session: {
      systemPromptInjection: "first_turn_new_session",
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
      writableDirs: (homeDir) => ensureDshRuntimeDirs(homeDir),
      writableFileGlobs: (homeDir) => {
        const dshHome = realpathOrSelf(resolveDeepSeekHome(homeDir, options.env ?? process.env));
        return [join(dshHome, ".anonymous-user-id")];
      },
    },
    errors: {
      classifyTurnError: classifyDeepSeekTurnError,
      isSessionNotFoundError: isDeepSeekSessionNotFoundError,
    },
    staleProcess: {
      matchesCommand: matchesDeepSeekStaleProcess,
    },
  };

  return createAcpDriver(config, {
    ...options,
    store: wrapStoreWithoutAddDirs(originalStore),
    readonlySpawn: wrappedReadonlySpawn,
  });
}

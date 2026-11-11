// DeepSeek Harness（`dsh --profile acp`）会话驱动：基于通用 ACP 驱动底座（src/vendors/_common/acp/）的薄封装。
// 核实细节与出处见 docs/vendors/deepseek.md。
import { execFileSync } from "node:child_process";
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

/** 驱动起的 dsh profile（$DSH_HOME/profiles/acp）。 */
const DEEPSEEK_PROFILE = "acp";

/**
 * 只读 Worker 在共享 $DSH_HOME 下能写的子目录：只有图片上传索引（llm-deepseek/files-v3.json，纯数据）。
 * profiles/（cordis.patch.yml 可写 !!js、node_modules 是插件）和 storages/（别的 profile 的定时任务存在这）不放，
 * 不然只读 Worker 改了它们，下次项目经理或普通 Worker 起 dsh 时就会执行；会话记录和 KV 存储改到会话私有目录（readonlyStatePatch）。
 * jobs、spill 在 TMPDIR 下（会话私有临时目录），不用放。
 */
export const DEEPSEEK_READONLY_RUNTIME_SUBDIRS: readonly string[] = ["llm-deepseek"];

/** 只读 Worker 在共享 $DSH_HOME 下能写的单个文件：dsh 每次启动都把 profile 的根配置重写成空列表；匿名用户 ID。 */
const DEEPSEEK_READONLY_RUNTIME_FILES: readonly string[] = [`profiles/${DEEPSEEK_PROFILE}/cordis.yml`, ".anonymous-user-id"];

/** dsh 启动要读的自身凭据（相对 $DSH_HOME，dsh-credentials-local、dsh-app-boot 的 loadLayeredEnv）：只读 Worker 放行读，仍不可写。 */
const DEEPSEEK_SELF_CREDENTIAL_FILES: readonly string[] = [".credentials.yaml", ".env"];

/** 只读 Worker 的会话私有状态目录（会话的启动目录下，恢复会话要用，所以不放 TMPDIR）。 */
const READONLY_STATE_DIR = "dsh-readonly-state";

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

/**
 * dsh-acp-app 给 system-prompt 行的默认 personaPrefix（`dsh --profile acp --dump-config`，@deepseek-ai/dsh@0.2.2-rc.1，
 * 版本钉死见 paths.ts 的 installCommand）。--patch 改一行时整个 config 被替换（dsh-app-boot 的 applyPatches 不合并），
 * 只写 personaSuffix 会把它丢掉，所以照抄一份。升级 dsh 时用 --dump-config 核对。
 */
export const DEEPSEEK_DEFAULT_PERSONA_PREFIX = "You are a coding agent powered by the {{model}} model.";

/**
 * dsh 的提示词模板没有转义写法：personaSuffix 里每个 `{{…}}` 都当变量查，不认识就整个启动失败（dsh-system-prompt 的 interpolate）。
 * 产品提示词里的 `{{`（代码示例、性格设定里用户写的）在两个 `{` 之间插一个零宽空格，dsh 不再当变量。注意：这会改变代码示例的字节，不是无损转义（见 docs/system-prompt-channels.md）。
 */
export function escapeDshPromptTemplate(text: string): string {
  return text.replace(/\{(?=\{)/g, "{\u200b");
}

/**
 * 产品提示词的常驻通道（spec 的 capabilities.systemPrompt 是 "resident"，docs/system-prompt-channels.md 第 3 节）：
 * system-prompt 行的 personaSuffix 进 dsh 的 system 消息（会话第 0 个节点），dsh 压缩只换掉历史，不动它。
 * 提示词空白返回 null（不加这个补丁，保持 dsh 默认）。
 */
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
 * 只读 Worker 的会话记录、KV 存储、附件改写到会话私有目录（dsh-base 里这几行的 root / dshHome 配置），
 * 不碰共享 $DSH_HOME 下别的会话和别的 profile 的数据。
 */
function readonlyStatePatch(stateDir: string): readonly DeepSeekCordisPatchEntry[] {
  return [
    { id: "session-persistence-jsonl", config: { root: join(stateDir, "sessions") } },
    { id: "storage-json", config: { root: join(stateDir, "storages") } },
    { id: "attachment-local", config: { dshHome: stateDir } },
  ];
}

/**
 * 只读沙箱里 profile 目录不可写，第一次起不了 dsh 自己的初始化（写 package.json 等）：
 * 先在沙箱外跑 `dsh --profile acp --dump-config`（只建 profile、打印配置就退出，不起会话、不读工作区 .env）。
 */
export function ensureDeepSeekProfile(executablePath: string, dshHome: string, env: NodeJS.ProcessEnv, cwd: string): void {
  if (existsSync(join(dshHome, "profiles", DEEPSEEK_PROFILE, "package.json"))) return;
  try {
    execFileSync(executablePath, ["--profile", DEEPSEEK_PROFILE, "--dump-config"], { cwd, env, stdio: "ignore", timeout: DEEPSEEK_PROFILE_INIT_TIMEOUT_MS });
  } catch {
    // 初始化失败照常起，dsh 在沙箱里自己报错
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
  // 只认这个会话的启动目录（--patch <launchDir>/<id>/settings.json），用户自己在终端开的 dsh 不能杀
  return /\/launch\/(\d+)\//.exec(psArgs)?.[1] === String(row.id);
}

export function createDeepSeekDriver(options: AcpDriverOptions): Driver {
  const env = { ...process.env, ...options.env };
  // 沙箱按真实路径比对（/tmp → /private/tmp），白名单要用 realpath 过的 $DSH_HOME
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
      // 提示词（含性格设定）在每次起进程的 --patch 里，恢复会话也是新进程读的新补丁
      rebakesPersonaOnResume: true,
    },
    session: {
      mcpServers: (ctx) => (ctx.files.readonly ? [] : loadDeepSeekAcpMcpServers(resolveDeepSeekHome(undefined, env))),
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

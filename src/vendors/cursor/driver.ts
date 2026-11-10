// Cursor 常驻 ACP 会话驱动：薄封装通用 createAcpDriver（严禁重复实现 JSON-RPC / ACP 通信层）。
// 仅配置 Cursor 专属参数：
// - 启动参数：`--trust --approve-mcps [--model <id>] acp`（沙箱包裹时由底座自动前置 ownSandboxOffArgs `--sandbox disabled`）；
// - 免 authenticate 直连 `session/new`（省去 6～8s 认证往返）；
// - `session/load` 续接并吞掉重放历史，兼容 Cursor `-32602` `data.message` 形式的会话不存在错误；
// - 模型 `configOptions` 安全映射（CLI 模型 ID -> 候选集合法参数化条目）与 `explicitDefaultModel` 默认模型；
// - 拦截 `cursor/ask_question`、`cursor/create_plan` 等私有阻塞请求立即返回双层 `{ outcome: { outcome: ... } }`，防常驻进程挂死；
// - 只读 Worker OS 沙箱补充 `~/.cursor` 下必需可写的临时会话/缓存目录。
import { basename, join } from "node:path";
import { RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import {
  vendorFailureOf,
  type AgentSessionRow,
  type Driver,
} from "../../shared/index.ts";
import {
  createAcpDriver,
  defaultClassifyAcpTurnError,
  defaultExtractAcpToolUse,
  defaultIsAcpSessionNotFoundError,
  flattenConfigSelectOptions,
  resolveModelConfigUpdate,
  type AcpDriverConfig,
  type AcpDriverOptions,
  type AcpExtensionRequestContext,
  type AcpTrackedToolCall,
} from "../_common/acp/index.ts";
import type { VendorDriverDeps } from "../daemon-types.ts";
import { cursorComposerBase, ensureCursorCompactCommand } from "./composer.ts";
import cursorSpec from "./spec.ts";
import {
  CURSOR_INTERRUPT_GRACE_MS,
  CURSOR_SHUTDOWN_GRACE_MS,
  CURSOR_START_TIMEOUT_MS,
} from "./limits.ts";

const MODEL_VARIANT_SUFFIX_RE = /-(?:fast|thinking|extra-high|xhigh|high|medium|low|max|minimal|none|1m)$/iu;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 将 CLI 模型名归一化为 ACP configOptions 的基础模型键（如 claude-opus-5-5-high -> claude-opus-5-5，claude-4.6-sonnet -> claude-sonnet-4-6）。 */
export function normalizeCursorBaseModel(raw: string): string {
  let base = raw
    .trim()
    .replace(/\[.*\]$/u, "")
    .toLowerCase()
    .replace(/^cursor-/u, "");

  for (let i = 0; i < 4; i++) {
    const next = base.replace(MODEL_VARIANT_SUFFIX_RE, "");
    if (next === base || next === "") break;
    base = next;
  }

  // 兼容 CLI 的 claude-4.6-sonnet / claude-4-sonnet 与 ACP 的 claude-sonnet-4-6 / claude-sonnet-4 命名差异
  const legacyClaude = /^claude-(\d+)(?:\.(\d+))?-(opus|sonnet|haiku|fable)$/iu.exec(base);
  if (legacyClaude) {
    const major = legacyClaude[1]!;
    const minor = legacyClaude[2];
    const family = legacyClaude[3]!.toLowerCase();
    return minor ? `claude-${family}-${major}-${minor}` : `claude-${family}-${major}`;
  }

  return base;
}

/**
 * 将会话请求的模型名解析为 ACP `model` 配置项可接受的候选 `value`：
 * - 实测 `cursor-agent acp` 的 `session/set_config_option` 仅接受 `options[].value` 中精确存在的字符串；
 * - 若候选集非空且未命中任何条目（如用户自定义新模型），返回 null 交由 CLI `--model` 生效，避免 `-32602` 导致握手失败。
 */
export function resolveCursorModelValue(
  requestedModel: string,
  option: SessionConfigOption | null,
): string | null {
  const trimmed = requestedModel.trim();
  if (trimmed === "") return null;
  if (!option || option.type !== "select") return null;

  const choices = flattenConfigSelectOptions(option);
  if (choices.length === 0) return null;

  const exact = choices.find((c) => c.value === trimmed);
  if (exact) return exact.value;

  const lower = trimmed.toLowerCase();
  const ciValue = choices.find((c) => c.value.toLowerCase() === lower);
  if (ciValue) return ciValue.value;

  if (lower === "auto" || lower === "default" || lower === "default[]") {
    const autoHit =
      choices.find((c) => c.value === "default[]") ??
      choices.find((c) => c.value.toLowerCase() === "auto") ??
      choices.find((c) => c.name.trim().toLowerCase() === "auto") ??
      choices.find((c) => c.value.toLowerCase().startsWith("default["));
    return autoHit?.value ?? null;
  }

  const ciName = choices.find((c) => c.name.trim().toLowerCase() === lower);
  if (ciName) return ciName.value;

  const targetBase = normalizeCursorBaseModel(trimmed);
  const byFamily = choices.find((c) => {
    const choiceName = c.name.trim().toLowerCase();
    const choiceHead = c.value.split("[", 1)[0]!.trim().toLowerCase();
    return choiceName === targetBase || choiceHead === targetBase || normalizeCursorBaseModel(choiceHead) === targetBase;
  });
  return byFamily?.value ?? null;
}

/** 提取 Cursor JSON-RPC 错误详情（含嵌套在 `error.data.message` 中的信息）。 */
export function extractCursorErrorDetail(error: unknown): string {
  if (error instanceof RequestError) {
    const dataObj = asRecord(error.data);
    const nested =
      typeof error.data === "string"
        ? error.data.trim()
        : typeof dataObj?.message === "string"
          ? dataObj.message.trim()
          : typeof dataObj?.error === "string"
            ? dataObj.error.trim()
            : "";
    if (nested !== "" && !error.message.includes(nested)) {
      return `${error.message}: ${nested}`;
    }
    return error.message;
  }
  const obj = asRecord(error);
  if (obj) {
    const msg = typeof obj.message === "string" ? obj.message : "";
    const dataObj = asRecord(obj.data);
    const nested = typeof dataObj?.message === "string" ? dataObj.message : "";
    if (msg && nested && !msg.includes(nested)) return `${msg}: ${nested}`;
    if (nested) return nested;
    if (msg) return msg;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 识别 Cursor 会话缺失错误（兼容 `-32602 Invalid params` + `data.message: 'Session "..." not found'`）。 */
export function isCursorSessionNotFoundError(error: unknown): boolean {
  if (defaultIsAcpSessionNotFoundError(error)) return true;
  const detail = extractCursorErrorDetail(error).toLowerCase();
  return (
    detail.includes("not found") ||
    detail.includes("no such session") ||
    detail.includes("unknown session") ||
    detail.includes("session does not exist")
  );
}

/** 将 Cursor 轮次错误归类为账本可读结构，保留 `data.message` 中的认证/额度原文。 */
export function classifyCursorTurnError(error: unknown): { subtype: string; message: string } {
  const detail = extractCursorErrorDetail(error);
  const sign = vendorFailureOf(detail, "cursor");
  if (sign?.kind === "auth") return { subtype: "auth_required", message: detail };
  if (sign?.kind === "quota") return { subtype: "quota_exceeded", message: detail };
  if (isCursorSessionNotFoundError(error)) return { subtype: "session_not_found", message: detail };
  const fallback = defaultClassifyAcpTurnError(error);
  return { subtype: fallback.subtype, message: detail || fallback.message };
}

/**
 * 拦截 Cursor 私有阻塞请求并立即返回双层 `{ outcome: { outcome: ... } }` 结构：
 * - `cursor/ask_question`：取消交互提问，让智能体直接在文本汇报中说明；
 * - `cursor/create_plan`：拒绝交互式计划审批卡片，防止后台无人值守子进程永久挂死；
 * - 其余 `cursor/*` 扩展请求统一返回 `cancelled`；非 `cursor/*` 返回 `undefined` 交由底座回 `-32601`。
 */
export function handleCursorBlockingRequest(ctx: AcpExtensionRequestContext): unknown {
  if (ctx.method === "cursor/ask_question") {
    return { outcome: { outcome: "cancelled" } };
  }
  if (ctx.method === "cursor/create_plan") {
    if (ctx.signal.aborted) {
      return { outcome: { outcome: "cancelled" } };
    }
    return {
      outcome: {
        outcome: "rejected",
        reason: "Interactive plan approval is disabled in unattended Fusa sessions.",
      },
    };
  }
  if (ctx.method.startsWith("cursor/")) {
    return { outcome: { outcome: "cancelled" } };
  }
  return undefined;
}

/**
 * 提取 Cursor ACP 工具调用的规范工具名与参数：
 * - 若事件自带明确 `name` / `_meta.toolName` 或 `title` 本身就是已登记的静态工具名（或 `mcp__` 前缀），直接保留；
 * - 若标准 ACP `tool_call` 仅提供人类可读句子 `title`（如 `"Terminal: pnpm test"`）而未带 `name`，回退到 `kind`（`execute`/`read`/`edit` 等），
 *   确保网页状态行与 `hub worker log --stats` 按通用动作准确分类。
 */
export const extractCursorToolUse: NonNullable<AcpDriverConfig["extractToolUse"]> = (
  toolCall,
  previous?: AcpTrackedToolCall,
) => {
  const base = defaultExtractAcpToolUse(toolCall, previous);
  const actions = cursorSpec.tools?.actions ?? {};
  if (Object.hasOwn(actions, base.name) || base.name.startsWith("mcp__")) {
    return base;
  }
  const meta = asRecord(toolCall._meta);
  const hasExplicitName =
    (typeof toolCall.name === "string" && toolCall.name.trim() !== "") ||
    (typeof meta?.toolName === "string" && meta.toolName.trim() !== "") ||
    (typeof meta?.name === "string" && meta.name.trim() !== "");
  if (hasExplicitName) return base;

  const kind = typeof toolCall.kind === "string" ? toolCall.kind : (previous?.kind ?? null);
  if (kind && Object.hasOwn(actions, kind)) {
    return { name: kind, input: base.input };
  }
  return base;
};

export interface CursorDriverOptions extends VendorDriverDeps {
  readonlySpawn?: AcpDriverOptions["readonlySpawn"];
}

export function buildCursorAcpConfig(getDefaultModel: () => string | null): AcpDriverConfig {
  return {
    vendor: "cursor",
    launchArgs: ({ row }) => {
      const explicitModel = row.model && row.model.trim() !== "" ? row.model.trim() : getDefaultModel();
      return explicitModel
        ? ["--trust", "--approve-mcps", "--model", explicitModel, "acp"]
        : ["--trust", "--approve-mcps", "acp"];
    },
    // 实测已登录状态下无需调耗时 6～8s 的 authenticate，可直接调 session/new。
    authenticate: {
      enabled: false,
    },
    continuation: {
      mode: "load",
      swallowReplayOnLoad: true,
      fallbackToNewOnFailure: true,
    },
    configOptions: {
      resolveModelValue: (requested, option) => resolveCursorModelValue(requested, option),
      // Cursor 思考程度已编码在模型 ID 中，不单独发思考档位 set_config_option；未选模型时默认映射 Auto（default[]）。
      combineModelAndEffort: ({ model, options }) => {
        const target =
          model && model.trim() !== "" ? model.trim() : (getDefaultModel() ?? "auto");
        const update = resolveModelConfigUpdate(target, options, {
          resolveModelValue: (req, opt) => resolveCursorModelValue(req, opt),
        });
        return update ? [update] : [];
      },
    },
    extensions: {
      onBlockingRequest: handleCursorBlockingRequest,
      onNotification: ({ method }) => {
        // cursor/update_todos、cursor/task、cursor/generate_image 等单向扩展通知安全忽略，不累积内存状态。
        void method;
      },
    },
    extractToolUse: extractCursorToolUse,
    readonlySandbox: {
      writableDirs: (homeDir) => [
        join(homeDir, ".cursor", "acp-sessions"),
        join(homeDir, ".cursor", "chats"),
        join(homeDir, ".cursor", "projects"),
        join(homeDir, ".cursor", "ai-tracking"),
        join(homeDir, ".cursor", "logs"),
      ],
      writableFileGlobs: (homeDir) => [join(homeDir, ".cursor", "statsig-cache.json")],
    },
    timeouts: {
      startTimeoutMs: CURSOR_START_TIMEOUT_MS,
      shutdownGraceMs: CURSOR_SHUTDOWN_GRACE_MS,
      interruptGraceMs: CURSOR_INTERRUPT_GRACE_MS,
    },
    errors: {
      isSessionNotFoundError: isCursorSessionNotFoundError,
      classifyTurnError: classifyCursorTurnError,
    },
    staleProcess: {
      matchesCommand: (psArgs, _row, executablePath) => {
        const exeBase = basename(executablePath);
        const hasBinary =
          psArgs.includes(executablePath) ||
          (exeBase !== "" && psArgs.includes(exeBase)) ||
          psArgs.includes("cursor-agent");
        return hasBinary && /(?:^|\s)acp(?:\s|$)/u.test(psArgs);
      },
    },
  };
}

export function createCursorDriver(deps: CursorDriverOptions): Driver {
  const { defaultModel, prepareLaunch: rawPrepareLaunch, composer, ...rest } = deps;
  let lastDefaultModel: string | null = null;

  const prepareLaunch = defaultModel
    ? async (row: AgentSessionRow) => {
        const [files, resolvedDefault] = await Promise.all([
          rawPrepareLaunch(row),
          row.model === null ? defaultModel().catch(() => null) : Promise.resolve(null),
        ]);
        if (row.model === null) {
          lastDefaultModel =
            typeof resolvedDefault === "string" && resolvedDefault.trim() !== ""
              ? resolvedDefault.trim()
              : null;
        }
        return files;
      }
    : rawPrepareLaunch;

  const acpDriver = createAcpDriver(buildCursorAcpConfig(() => lastDefaultModel), {
    ...rest,
    prepareLaunch,
    composer: composer ?? cursorComposerBase,
  });

  const origOnEvent = acpDriver.onEvent.bind(acpDriver);
  const origQueryCommands = acpDriver.queryCommands.bind(acpDriver);

  acpDriver.onEvent = (listener) =>
    origOnEvent((sessionId, event) => {
      if (event.type === "commands.changed") {
        listener(sessionId, { ...event, commands: ensureCursorCompactCommand(event.commands) });
        return;
      }
      listener(sessionId, event);
    });

  acpDriver.queryCommands = async (sessionId) => {
    const cmds = await origQueryCommands(sessionId);
    return cmds === null ? null : ensureCursorCompactCommand(cmds);
  };

  return acpDriver;
}

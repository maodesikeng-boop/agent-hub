// Cursor 常驻 ACP 会话驱动：薄封装通用 createAcpDriver（严禁重复实现 JSON-RPC / ACP 通信层）。
// 仅配置 Cursor 专属参数：
// - 启动参数：`--trust --approve-mcps acp`（沙箱包裹时由底座自动前置 ownSandboxOffArgs `--sandbox disabled`）；
//   不带 `--model`：实测 ACP 会话不认它（session/new 的 currentValue 照旧取 ~/.cursor/acp-config.json），还会改写用户的 ~/.cursor/cli-config.json；
// - 免 authenticate 直连 `session/new`（省去 6～8s 认证往返）；
// - `session/load` 续接并吞掉重放历史，兼容 Cursor `-32602` `data.message` 形式的会话不存在错误；
// - 模型只经 `session/set_config_option` 选（家族名 -> options[] 里的预设值，未选模型用 Auto），每次新建/续接都显式设；
// - 拦截 `cursor/ask_question`、`cursor/create_plan` 等私有阻塞请求立即返回双层 `{ outcome: { outcome: ... } }`，防常驻进程挂死；
// - 只读 Worker OS 沙箱补充 `~/.cursor` 下必需可写的临时会话/缓存目录。
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import { vendorFailureOf, type Driver, type DriverOptions } from "../../shared/index.ts";
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
import type { VendorComposerBase } from "../../daemon/vendors/types.ts";
import { CURSOR_AUTO_MODEL, cursorModelFamily } from "./catalog.ts";
import { cursorComposerBase, ensureCursorCompactCommand } from "./composer.ts";
import cursorSpec from "./spec.ts";
import {
  CURSOR_INTERRUPT_GRACE_MS,
  CURSOR_SHUTDOWN_GRACE_MS,
  CURSOR_START_TIMEOUT_MS,
} from "./limits.ts";

const LAUNCH_ARGS = ["--trust", "--approve-mcps", "acp"] as const;
/** 只读 Worker 里 ~/.cursor 下放行可写的运行时子目录（cli-config.json、mcp.json、hooks.json、auth.json 不放行）。 */
const CURSOR_READONLY_RUNTIME_SUBDIRS = ["acp-sessions", "chats", "projects", "ai-tracking", "logs"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 把会话的模型名解析成 ACP `model` 配置项的 `value`：精确 value -> 忽略大小写 -> auto/default -> 家族名（options[].name）。
 * 实测 set_config_option 只收 options[].value 里原样存在的字符串，档位变体（claude-opus-5-5-high）只能落到该家族的预设值。
 * 认不出的原样返回：交给 set_config_option 报 `Invalid model value`，不静默跑在别的会话留下的全局模型上。
 */
export function resolveCursorModelValue(requestedModel: string, option: SessionConfigOption | null): string | null {
  const trimmed = requestedModel.trim();
  if (trimmed === "" || option?.type !== "select") return null;
  const choices = flattenConfigSelectOptions(option);
  const lower = trimmed.toLowerCase();
  const byValue = choices.find((c) => c.value === trimmed) ?? choices.find((c) => c.value.toLowerCase() === lower);
  if (byValue) return byValue.value;
  if (lower === CURSOR_AUTO_MODEL || lower === "default") {
    return choices.find((c) => c.value === "default[]")?.value ?? trimmed;
  }
  const family = cursorModelFamily(trimmed);
  return choices.find((c) => cursorModelFamily(c.name) === family)?.value ?? trimmed;
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

export interface CursorDriverOptions extends DriverOptions {
  composer?: VendorComposerBase;
  readonlySpawn?: AcpDriverOptions["readonlySpawn"];
}

/**
 * ps 里那一行是不是 Fusa 起的 cursor-agent ACP 进程：要有 cursor-agent（或配置的可执行文件），带 --trust 和 --approve-mcps，
 * 且最后一个参数是 acp。启动脚本 `exec -a "$0" node index.js …` 保留了调用路径和参数顺序；Linux 包一层 bwrap 时末尾也还是 acp。
 * 用户自己在终端或 IDE 跑的 `cursor-agent acp` 不带这两个标志，旧 PID 被它复用时不误杀。
 */
export function isFusaCursorAcpCommand(psArgs: string, executablePath: string): boolean {
  const tokens = psArgs.trim().split(/\s+/u);
  const exeBase = basename(executablePath);
  const hasBinary = tokens.some((t) => t === executablePath || basename(t) === exeBase || basename(t) === cursorSpec.cli.command);
  return hasBinary && tokens.at(-1) === "acp" && tokens.includes("--trust") && tokens.includes("--approve-mcps");
}

const cursorAcpConfig: AcpDriverConfig = {
  vendor: "cursor",
  launchArgs: LAUNCH_ARGS,
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
    // ACP 新会话的初始模型是全局 ~/.cursor/acp-config.json 里上一次 set 的值（任何会话都会改它），所以没选模型也显式设 Auto。
    combineModelAndEffort: ({ model, options }) => {
      const update = resolveModelConfigUpdate(model?.trim() || CURSOR_AUTO_MODEL, options, {
        resolveModelValue: resolveCursorModelValue,
      });
      return update ? [update] : [];
    },
  },
  extensions: {
    onBlockingRequest: handleCursorBlockingRequest,
    // cursor/update_todos、cursor/task、cursor/generate_image 等单向扩展通知安全忽略，不累积内存状态。
    onNotification: () => {},
  },
  extractToolUse: extractCursorToolUse,
  readonlySandbox: {
    // cursor-agent 启动就往 projects/ 写，~/.cursor 本身只读时缺了它直接退出（实测）；底座只放行已存在的目录，所以先建好。
    writableDirs: (homeDir) => {
      const dirs = CURSOR_READONLY_RUNTIME_SUBDIRS.map((sub) => join(homeDir, ".cursor", sub));
      for (const dir of dirs) mkdirSync(dir, { recursive: true });
      return dirs;
    },
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
    matchesCommand: (psArgs, _row, executablePath) => isFusaCursorAcpCommand(psArgs, executablePath),
  },
};

export function createCursorDriver({ composer, ...rest }: CursorDriverOptions): Driver {
  const acpDriver = createAcpDriver(cursorAcpConfig, { ...rest, composer: composer ?? cursorComposerBase });

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

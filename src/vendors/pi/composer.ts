// Pi 的输入框命令实现（docs/vendors/pi.md 第 3.1、4 节）：
// - 运行中的会话直接通过 RPC `get_commands` 获取扩展命令、提示词模板与技能命令（如 `skill:<name>`）；
// - 空闲会话由本模块短暂起 `pi --mode rpc --no-session --offline --no-mcp`（显式带 `--skill <dir>/.agents/skills`，不传 `--approve`）查询 `get_commands`；
// - 额外补入内置压缩命令 `/compact`（驱动层将其映射为 RPC `compact` 命令）。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  COMMANDS_QUERY_TIMEOUT_MS,
  KILL_WAIT_MS,
  MAX_COMMANDS,
  MAX_COMMAND_DESCRIPTION_CHARS,
  MAX_COMMAND_HINT_CHARS,
  truncateChars,
  type ComposerCommand,
} from "../../shared/index.ts";
import { STDERR_TAIL_CHARS, killThenSettle } from "../../daemon/driver/model-catalog.ts";
import { forceKill, termGroupAfterExit } from "../../daemon/driver/process.ts";
import { buildChildEnv, userContent } from "../../daemon/driver/protocol.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import type { CommandsTarget, VendorComposer, VendorComposerBase } from "../../daemon/vendors/types.ts";
import { createSpecComposerBase } from "../_common/composer.ts";
import { MAX_PI_PROBE_STDOUT_CHARS } from "./limits.ts";

/** Pi 网页端暴露的内置斜杠命令（其余 TUI 专属命令已在 spec.ts 的 blockedCommands 拦截）。 */
export const PI_BUILTIN_COMMANDS: readonly ComposerCommand[] = [
  { name: "compact", description: "压缩当前对话上下文", builtin: true },
];

/** 收集工作目录及附加目录下已存在的 `.agents/skills` 目录，生成 `--skill <path>` 参数列表（不传 `--approve`）。 */
export function buildPiSkillArgs(cwd: string, addDirs: readonly string[] = []): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  for (const root of [cwd, ...addDirs]) {
    if (!root) continue;
    const skillDir = join(root, ".agents", "skills");
    if (seen.has(skillDir) || !existsSync(skillDir)) continue;
    seen.add(skillDir);
    args.push("--skill", skillDir);
  }
  return args;
}

function extractPiCommandsList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as {
    commands?: unknown;
    data?: { commands?: unknown };
    result?: { commands?: unknown };
  };
  if (Array.isArray(obj.commands)) return obj.commands;
  if (Array.isArray(obj.data?.commands)) return obj.data.commands;
  if (Array.isArray(obj.result?.commands)) return obj.result.commands;
  return null;
}

/** 将 RPC `get_commands` 的回应解析为通用 ComposerCommand[]，并补入内置 `compact`。 */
export function parsePiCommands(raw: unknown): ComposerCommand[] | null {
  const list = extractPiCommandsList(raw);
  if (list === null) return null;
  const out: ComposerCommand[] = [];
  const seen = new Set<string>();

  const append = (item: unknown) => {
    if (out.length >= MAX_COMMANDS) return;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return;
    const entry = item as Record<string, unknown>;
    const rawName = typeof entry.name === "string" ? entry.name.trim().replace(/^\/+/u, "") : "";
    if (rawName === "" || /\s/u.test(rawName) || seen.has(rawName)) return;
    seen.add(rawName);

    const rawDesc = typeof entry.description === "string" ? entry.description.trim() : "";
    const description = rawDesc === "" ? "" : truncateChars(rawDesc, MAX_COMMAND_DESCRIPTION_CHARS);
    const hint = typeof entry.argumentHint === "string" ? entry.argumentHint.trim() : "";
    out.push({
      name: rawName,
      description,
      ...(hint === "" ? {} : { argumentHint: truncateChars(hint, MAX_COMMAND_HINT_CHARS) }),
      ...(entry.builtin === true ? { builtin: true as const } : {}),
    });
  };

  for (const item of list) append(item);
  for (const builtin of PI_BUILTIN_COMMANDS) append(builtin);
  return out;
}

export interface PiCommandsQueryOptions {
  piPath: string;
  cwd: string;
  addDirs?: readonly string[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/** 短暂启动 `pi --mode rpc --no-session --offline --no-mcp` 发送 `get_commands`，严格按 `\n` 切分 JSONL。 */
export function queryPiRpcCommands(options: PiCommandsQueryOptions): Promise<unknown> {
  const { piPath, cwd, addDirs = [], timeoutMs = COMMANDS_QUERY_TIMEOUT_MS, signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const args = ["--mode", "rpc", "--no-session", "--offline", "--no-mcp", ...buildPiSkillArgs(cwd, addDirs)];
    const child = spawn(piPath, args, {
      cwd,
      env: buildChildEnv(options.env ?? process.env, undefined),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    trackChild(child, "probe:pi-commands", { detached: true });

    let buffer = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const exited = () => child.exitCode !== null || child.signalCode !== null;

    const finish = (error: Error | null, data?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        killThenSettle(child, () => reject(error));
        return;
      }
      child.stdin.end();
      if (!exited()) {
        killTimer = setTimeout(() => void forceKill(child), KILL_WAIT_MS);
        killTimer.unref();
        child.once("exit", () => clearTimeout(killTimer));
      }
      resolve(data);
    };

    const onAbort = () => finish(new Error("cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => finish(new Error(`pi 超时（${timeoutMs} ms 没回 get_commands）`)),
      timeoutMs,
    );

    child.once("error", (error) => finish(new Error(`${piPath}: ${error.message}`)));
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_PI_PROBE_STDOUT_CHARS && !buffer.includes("\n")) {
        finish(new Error("pi get_commands 单行输出超过上限"));
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (rawLine.trim() === "") continue;
        let obj: unknown;
        try {
          obj = JSON.parse(rawLine);
        } catch {
          continue;
        }
        if (typeof obj !== "object" || obj === null) continue;
        const msg = obj as { id?: unknown; type?: unknown; command?: unknown; success?: unknown; data?: unknown; error?: unknown };
        if (msg.type === "response" && msg.id === "1" && msg.command === "get_commands") {
          if (msg.success === false) {
            finish(new Error(`pi get_commands 失败：${typeof msg.error === "string" ? msg.error : "未知错误"}`));
          } else {
            finish(null, msg.data ?? { commands: [] });
          }
          return;
        }
      }
    });
    child.once("exit", (code, sig) => {
      termGroupAfterExit(child);
      setTimeout(
        () =>
          finish(
            new Error(
              `pi 没回 get_commands 就退出了（${sig ?? `退出码 ${code}`}）${stderr.trim() ? `：${stderr.trim()}` : ""}`,
            ),
          ),
        50,
      );
    });

    child.stdin.write(`${JSON.stringify({ id: "1", type: "get_commands" })}\n`);
  });
}

const specBase = createSpecComposerBase("pi");

export const piComposerBase: VendorComposerBase = {
  ...specBase,
  parseCommands: parsePiCommands,
  mention: (path) => (/[\s"]/u.test(path) ? `@"${path}"` : `@${path}`),
  buildUserContent: (prefixes, text) => userContent(prefixes, text),
};

export interface PiComposerOptions {
  executablePath?: string;
  queryCommandsRpc?: (options: PiCommandsQueryOptions) => Promise<unknown>;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function createPiComposer(options?: PiComposerOptions): VendorComposer {
  return {
    ...piComposerBase,
    async queryCommands(target: CommandsTarget, signal: AbortSignal) {
      if (!options?.queryCommandsRpc && !options?.executablePath) {
        return [...PI_BUILTIN_COMMANDS];
      }
      const query = options.queryCommandsRpc ?? queryPiRpcCommands;
      const raw = await query({
        piPath: options.executablePath ?? "pi",
        cwd: target.cwd,
        addDirs: target.addDirs,
        timeoutMs: options.timeoutMs ?? COMMANDS_QUERY_TIMEOUT_MS,
        signal,
        ...(options.env ? { env: options.env } : {}),
      });
      const commands = parsePiCommands(raw);
      if (commands === null) throw new Error("pi get_commands 回应里没有可识别的列表");
      return commands;
    },
  };
}

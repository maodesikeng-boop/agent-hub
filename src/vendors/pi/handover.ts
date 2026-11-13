// Pi 复制会话后台写交接（docs/vendors/pi.md 第 5 节）：
// - `fork(src)` 生成全局唯一 UUID 作为复制会话编号（不常驻额外进程，零内存驻留）；
// - `write(src, fork, prompt, signal)` 在剥离 HUB_* 环境变量后启动一次性 `pi --mode rpc --fork <原会话文件或ID> --session-id <forkId>`，
//   附加 `--append-system-prompt <promptFile> --exclude-tools edit,write,bash,powershell --no-mcp --no-approve` 及项目技能与模型参数，
//   发送交接提示词，等待 `agent_settled` 后查询 `get_session_stats` 拿到精确上下文大小并关闭标准输入，等进程退出（超时强制结束）再交回；
//   取消、出错时连同进程组强制结束；
//   若原会话未落盘（报 `No session found`），抛出 ForkUnsupportedError 由上层自动退回本会话内写交接；
// - `remove(fork)` 清理复制出的会话 JSONL 文件（含进程崩溃或守护进程重启后的残留文件）。
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { TokenUsage } from "../../shared/domain.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../../shared/hub.ts";
import { KILL_WAIT_MS } from "../../shared/limits.ts";
import { agentLaunchArgs } from "../../shared/vendors.ts";
import { forceKill, killFreshGroup, termGroupAfterExit } from "../../daemon/driver/process.ts";
import { buildChildEnv } from "../../daemon/driver/protocol.ts";
import { spawnOwnedProcess } from "../../daemon/platform/index.ts";
import { ForkUnsupportedError, withoutHubEnv } from "../../daemon/handover/forker.ts";
import type { ForkHandle, ForkSource, ForkWriteResult, SessionForker } from "../../daemon/handover/forker.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import { PI_NO_PROJECT_TRUST_ARGS, buildPiSkillArgs } from "./composer.ts";
import { MAX_PI_PROBE_STDOUT_CHARS, PI_SESSION_STATS_TIMEOUT_MS } from "./limits.ts";
import {
  addPiTokenCounts,
  buildBlockingExtensionUiCancelLine,
  buildGetSessionStatsLine,
  buildGetStateLine,
  buildPromptLine,
  extractPiAssistantBlocks,
  isValidPiSessionId,
  parsePiSessionStats,
  parsePiTokenCounts,
  type PiRawTokenCounts,
} from "./protocol.ts";
import { piSessionFiles, piTranscriptPath } from "./transcript.ts";

/** fork_ref 里的唯一标识（契约测试 S9 跨厂商唯一）。 */
export const PI_NATIVE_FORKER_ID = "pi-native";

const STDERR_TAIL_CHARS = 2_000;
const NO_SESSION_RE = /no session found|session file not found|cannot find session/i;

export interface PiForkerOptions {
  /** 测试可注入自定义起进程函数。 */
  spawnProcess?: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ) => ChildProcess;
  /** 测试可指定用户主目录与环境变量以定位/清理会话文件。 */
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

function buildPiForkArgs(src: ForkSource, forkId: string, forkTarget: string): string[] {
  const args: string[] = ["--mode", "rpc", "--fork", forkTarget, "--session-id", forkId];
  if (src.launch.promptFile.trim() !== "") {
    args.push("--append-system-prompt", src.launch.promptFile);
  }
  args.push(...PI_NO_PROJECT_TRUST_ARGS, ...buildPiSkillArgs(src.cwd, src.addDirs));
  if (src.launch.skillsDir) args.push("--skill", src.launch.skillsDir);
  args.push(...agentLaunchArgs({ vendor: src.vendor, model: src.model, effort: src.effort }));
  // 写交接禁止一切文件修改、命令执行与外部 MCP 调用
  args.push("--exclude-tools", "edit,write,bash,powershell", "--no-mcp");
  return args;
}

export function createPiForker(options: PiForkerOptions = {}): SessionForker {
  const spawnProcess =
    options.spawnProcess ??
    ((command, args, opts) => {
      const spawned = spawnOwnedProcess(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const { child, detached } = spawned;
      trackChild(child, "handover:pi", { detached });
      return child;
    });

  return {
    id: PI_NATIVE_FORKER_ID,
    kind: "native",

    async fork(src: ForkSource, signal: AbortSignal): Promise<ForkHandle> {
      if (signal.aborted) throw new Error("复制被取消");
      if (!src.vendorSessionId.trim()) {
        throw new ForkUnsupportedError("原会话没有 pi 会话编号");
      }
      return {
        forkId: randomUUID(),
        extra: { cwd: src.cwd },
      };
    },

    async write(src: ForkSource, fork: ForkHandle, prompt: string, signal: AbortSignal): Promise<ForkWriteResult> {
      if (!src.vendorSessionId.trim()) {
        throw new ForkUnsupportedError("原会话没有 pi 会话编号");
      }
      if (signal.aborted) throw new Error("aborted");

      const cleanLaunch = withoutHubEnv(src.launch);
      const { [ENV_HUB_TOKEN]: _t, [ENV_HUB_SOCK]: _s, ...baseEnv } = options.env ?? process.env;
      const childEnv = withoutHubEnv({ ...cleanLaunch, env: buildChildEnv(baseEnv, cleanLaunch.env) }).env;

      const transcript = piTranscriptPath(
        { vendor: "pi", cwd: src.cwd, vendorSessionId: src.vendorSessionId },
        { home: options.homeDir, env: childEnv },
      );
      // 找不到会话文件时按编号复制：编号要是 pi 认的样子（字母或数字开头），免得被当成命令行参数
      if (transcript === null && !isValidPiSessionId(src.vendorSessionId)) {
        throw new ForkUnsupportedError(`pi 会话编号不合法：${src.vendorSessionId}`);
      }
      const forkTarget = transcript ?? src.vendorSessionId;
      const args = buildPiForkArgs(src, fork.forkId, forkTarget);
      const child = spawnProcess(src.executablePath, args, { cwd: src.cwd, env: childEnv });
      child.once("exit", () => termGroupAfterExit(child));

      return new Promise<ForkWriteResult>((resolve, reject) => {
        let buffer = "";
        let stderr = "";
        let settled = false;
        let statsTimer: NodeJS.Timeout | undefined;
        const texts: string[] = [];
        let turnCounts: PiRawTokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
        let lastAssistantContext = 0;
        let turnError: string | null = null;
        let waitingStats = false;

        const exited = () => child.exitCode !== null || child.signalCode !== null;
        /** 连同进程组和换了组的后代一起强制结束（取消、出错时；pi 可能还在跑这一轮、调模型）。 */
        const stopChild = () => {
          if (exited()) return;
          if (child.pid === undefined) {
            child.kill("SIGKILL");
            return;
          }
          const killable = child as Parameters<typeof forceKill>[0];
          killFreshGroup(killable);
          void forceKill(killable);
        };

        const finish = (err: Error | null, result?: ForkWriteResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(statsTimer);
          signal.removeEventListener("abort", onAbort);
          child.stdin?.end();
          if (err) {
            stopChild();
            reject(err);
            return;
          }
          // 关标准输入让它自己收尾退出；等它真退了再交回，免得接手的新会话起来时它还在写复制出的会话文件。KILL_WAIT_MS 内没退就强制结束
          if (exited()) {
            resolve(result!);
            return;
          }
          const killTimer = setTimeout(stopChild, KILL_WAIT_MS);
          child.once("exit", () => {
            clearTimeout(killTimer);
            resolve(result!);
          });
        };

        const finalizeWithStats = (contextOverride: number | null) => {
          if (turnError !== null) {
            finish(new Error(`pi 写交接出错：${turnError}`));
            return;
          }
          const usage: TokenUsage = {
            input: turnCounts.input,
            cacheRead: turnCounts.cacheRead,
            cacheWrite: turnCounts.cacheWrite,
            output: turnCounts.output,
            context: contextOverride ?? lastAssistantContext,
          };
          finish(null, { text: texts.join("\n\n"), usage });
        };

        const onAbort = () => finish(new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });

        child.stdin?.on("error", () => {});
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
        });
        child.once("error", (err) => {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            finish(new ForkUnsupportedError(`找不到 pi：${src.executablePath}`));
            return;
          }
          finish(new Error(`${src.executablePath}: ${err.message}`));
        });

        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer.length > MAX_PI_PROBE_STDOUT_CHARS && !buffer.includes("\n")) {
            finish(new Error("pi 写交接单行输出超过上限"));
            return;
          }
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const rawLine = buffer.slice(0, idx).replace(/\r$/, "");
            buffer = buffer.slice(idx + 1);
            if (rawLine.trim() === "") continue;
            let obj: Record<string, unknown>;
            try {
              obj = JSON.parse(rawLine) as Record<string, unknown>;
            } catch {
              continue;
            }

            const cancelUi = buildBlockingExtensionUiCancelLine(obj);
            if (cancelUi !== null) {
              child.stdin?.write(`${cancelUi}\n`);
              continue;
            }

            if (obj.type === "response") {
              if (obj.id === "1" && obj.command === "get_state") {
                if (obj.success === false) {
                  const msg = typeof obj.error === "string" ? obj.error : "get_state failed";
                  finish(
                    NO_SESSION_RE.test(msg)
                      ? new ForkUnsupportedError(`pi 找不到要复制的原会话：${msg}`)
                      : new Error(`pi get_state 失败：${msg}`),
                  );
                  return;
                }
                const data =
                  typeof obj.data === "object" && obj.data !== null ? (obj.data as Record<string, unknown>) : null;
                if (typeof data?.sessionFile === "string" && data.sessionFile !== "" && fork.extra) {
                  fork.extra.sessionFile = data.sessionFile;
                }
                continue;
              }
              if (obj.id === "2" && obj.command === "prompt" && obj.success === false) {
                const msg = typeof obj.error === "string" ? obj.error : "prompt failed";
                finish(new Error(`pi prompt 失败：${msg}`));
                return;
              }
              if (obj.id === "3" && obj.command === "get_session_stats") {
                const stats = obj.success === false ? { contextTokens: null } : parsePiSessionStats(obj.data);
                finalizeWithStats(stats.contextTokens);
                return;
              }
              continue;
            }

            if (obj.type === "message_end") {
              const message =
                typeof obj.message === "object" && obj.message !== null
                  ? (obj.message as Record<string, unknown>)
                  : null;
              if (message?.role === "assistant") {
                const blocks = extractPiAssistantBlocks(message);
                for (const t of blocks.texts) texts.push(t.text);
                const counts = parsePiTokenCounts(message.usage);
                if (counts) {
                  turnCounts = addPiTokenCounts(turnCounts, counts);
                  lastAssistantContext = counts.input + counts.cacheRead + counts.cacheWrite;
                }
                if (message.stopReason === "error") {
                  turnError =
                    typeof message.errorMessage === "string" && message.errorMessage !== ""
                      ? message.errorMessage
                      : "assistant error";
                }
              }
              continue;
            }

            if (obj.type === "agent_settled" && !waitingStats) {
              waitingStats = true;
              if (obj.aborted === true && turnError === null) {
                turnError = "aborted";
              }
              child.stdin?.write(`${buildGetSessionStatsLine("3")}\n`);
              statsTimer = setTimeout(() => finalizeWithStats(null), PI_SESSION_STATS_TIMEOUT_MS);
            }
          }
        });

        child.once("close", (code, sig) => {
          if (settled) return;
          if (waitingStats) {
            finalizeWithStats(null);
            return;
          }
          const trimmedErr = stderr.trim();
          if (NO_SESSION_RE.test(trimmedErr)) {
            finish(new ForkUnsupportedError(`pi 找不到要复制的原会话：${trimmedErr}`));
            return;
          }
          finish(new Error(`pi 复制会话提前退出（${sig ?? `code ${code}`}）${trimmedErr ? `：${trimmedErr}` : ""}`));
        });

        child.stdin?.write(`${buildGetStateLine("1")}\n`);
        child.stdin?.write(`${buildPromptLine("2", prompt)}\n`);
      });
    },

    async remove(fork: ForkHandle): Promise<void> {
      const files = new Set<string>();
      if (typeof fork.extra?.sessionFile === "string" && fork.extra.sessionFile !== "") {
        files.add(fork.extra.sessionFile);
      }
      const cwd = fork.extra?.cwd ?? "";
      for (const f of piSessionFiles(
        { vendor: "pi", cwd, vendorSessionId: fork.forkId },
        { home: options.homeDir, env: options.env ?? process.env },
      )) {
        files.add(f);
      }
      await Promise.all([...files].map((file) => rm(file, { force: true })));
    },
  };
}

export const PI_FORKERS: readonly SessionForker[] = [createPiForker()];

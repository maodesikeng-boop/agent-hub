// claude 复制会话去后台写交接的办法（docs/background-handover-design.md 第 2.3、2.6 节）：
// write 时直接 `claude -p --resume <原编号> --fork-session --no-session-persistence --session-id <复制那份的编号>`，
// 模型、思考程度、--append-system-prompt-file、--add-dir 照项目经理的来（前缀不变才吃得到缓存）；
// --settings 是项目经理的设置叠上禁写三层（shared/policy.ts 的 buildForkSettings：拦所有工具的钩子、dontAsk、Edit(//**) 拒绝），整段 JSON 传，
// 只动权限和钩子、不动工具清单，实测缓存不掉。不落盘所以没有要删的文件，remove 只是保险。fork 本身什么都不跑，只定编号。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenUsage } from "../../shared/domain.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../../shared/hub.ts";
import { buildForkSettings } from "../../shared/policy.ts";
import { agentLaunchArgs } from "../../shared/vendors.ts";
import { assistantContext, buildChildEnv, parseUsage } from "../../daemon/driver/protocol.ts";
import { killFreshGroup, termGroupAfterExit } from "../../daemon/driver/process.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import { ForkUnsupportedError } from "../../daemon/handover/forker.ts";
import type { ForkHandle, ForkSource, ForkWriteResult, SessionForker } from "../../daemon/handover/forker.ts";

/** 这个办法在 fork_ref 里的名字，发布后不改。 */
const CLAUDE_FORKER_ID = "claude-native";

/** 固定的启动参数：-p 一次性、stream-json 才拿得到每个请求的上下文大小（--verbose 是它的前提）。提示词走标准输入，不进参数。 */
const CLAUDE_FORK_FIXED_ARGS: readonly string[] = ["-p", "--output-format", "stream-json", "--verbose"];
/** 复制那份不落盘（用户的 claude --resume 列表里不会多出一条）。 */
const NO_PERSISTENCE_ARG = "--no-session-persistence";
/** 标准错误只留最后这么多字符进报错。 */
const STDERR_TAIL_CHARS = 2000;

export interface ClaudeForkerOptions {
  /** true 时不加 --no-session-persistence（排查用，之后靠 remove 删）。 */
  persist?: boolean;
  /** claude 的配置目录（remove 找 projects/ 用），默认 CLAUDE_CONFIG_DIR 或 ~/.claude。 */
  configDir?: string;
}

/** claude 把工作目录映射成 projects/ 下的目录名：路径里非字母数字都换成 -。 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** 复制那份的命令行参数。launch.env 里已经没有 HUB_*（forkSourceOf 去掉了）。settings 是 forkSettingsJson 的结果。 */
function buildClaudeForkArgs(src: ForkSource, forkId: string, persist: boolean, settings: string): string[] {
  const args = [...CLAUDE_FORK_FIXED_ARGS, "--resume", src.vendorSessionId, "--fork-session", "--session-id", forkId];
  if (!persist) args.push(NO_PERSISTENCE_ARG);
  args.push(...agentLaunchArgs({ vendor: src.vendor, model: src.model, effort: src.effort }));
  args.push("--append-system-prompt-file", src.launch.promptFile, "--settings", settings);
  for (const dir of src.addDirs) args.push("--add-dir", dir);
  return args;
}

/** 读项目经理的设置文件（没有就当空），叠上禁写三层，转成 --settings 的 JSON。读不了、不是 JSON 对象就抛：不能不带禁写就跑。 */
async function forkSettingsJson(settingsFile: string | undefined): Promise<string> {
  if (!settingsFile) return JSON.stringify(buildForkSettings({}));
  let base: unknown;
  try {
    base = JSON.parse(await readFile(settingsFile, "utf8"));
  } catch (error) {
    throw new Error(`读不了项目经理的设置文件 ${settingsFile}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof base !== "object" || base === null || Array.isArray(base)) throw new Error(`项目经理的设置文件不是 JSON 对象：${settingsFile}`);
  return JSON.stringify(buildForkSettings(base));
}

/** 解析 stream-json：result 的文字和用量；context 取最后一个主线 assistant 请求（复制那份读到的上文大小）。 */
function parseOutput(stdout: string): ForkWriteResult {
  let context = 0;
  let result: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === "assistant") context = assistantContext(obj) ?? context;
    else if (obj.type === "result") result = obj;
  }
  if (!result) throw new Error("claude 没有输出 result");
  const text = typeof result.result === "string" ? result.result : "";
  if (result.is_error === true) throw new Error(`claude 这一轮出错：${text || String(result.subtype ?? "")}`);
  const usage: TokenUsage = { ...parseUsage(result.usage), context };
  return { text, usage };
}

export function createClaudeForker(options: ClaudeForkerOptions = {}): SessionForker {
  const persist = options.persist ?? false;
  const configDir = (): string => options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

  return {
    id: CLAUDE_FORKER_ID,
    kind: "native",

    async fork(src: ForkSource): Promise<ForkHandle> {
      return { forkId: randomUUID(), extra: { cwd: src.cwd } };
    },

    async write(src: ForkSource, fork: ForkHandle, prompt: string, signal: AbortSignal): Promise<ForkWriteResult> {
      if (!src.vendorSessionId) throw new ForkUnsupportedError("原会话没有 claude 会话编号");
      const settings = await forkSettingsJson(src.launch.settingsFile);
      if (signal.aborted) throw new Error("aborted");
      // 守护进程自己环境里的 HUB_* 也不能漏给复制那份；launch.env 已经去掉了
      const { [ENV_HUB_TOKEN]: _t, [ENV_HUB_SOCK]: _s, ...base } = process.env;
      const child = spawn(src.executablePath, buildClaudeForkArgs(src, fork.forkId, persist, settings), {
        cwd: src.cwd,
        env: buildChildEnv(base, src.launch.env),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      trackChild(child, "handover:claude", { detached: true });
      return new Promise<ForkWriteResult>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          fn();
        };
        const onAbort = (): void => {
          killFreshGroup(child);
          finish(() => reject(new Error("aborted")));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
        child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr = (stderr + c).slice(-STDERR_TAIL_CHARS)));
        child.stdin.on("error", () => {});
        child.once("error", (error) => finish(() => reject(new Error(`${src.executablePath}: ${error.message}`))));
        child.once("close", (code, sig) => {
          termGroupAfterExit(child);
          finish(() => {
            if (code !== 0) return reject(new Error(`claude exit code ${code ?? sig}: ${stderr.trim()}`));
            try {
              resolve(parseOutput(stdout));
            } catch (error) {
              reject(error);
            }
          });
        });
        child.stdin.end(prompt);
      });
    },

    async remove(fork: ForkHandle): Promise<void> {
      const cwd = fork.extra?.cwd;
      if (!cwd || !/^[A-Za-z0-9_-]+$/.test(fork.forkId)) return;
      const base = join(configDir(), "projects", claudeProjectDirName(cwd), fork.forkId);
      await rm(`${base}.jsonl`, { force: true });
      await rm(base, { recursive: true, force: true });
    },
  };
}

export const CLAUDE_FORKERS: readonly SessionForker[] = [createClaudeForker()];

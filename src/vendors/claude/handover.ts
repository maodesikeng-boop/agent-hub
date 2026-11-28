import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenUsage } from "../../shared/domain.ts";
import { buildForkSettings } from "./settings.ts";
import { agentLaunchArgs } from "../../shared/vendors.ts";
import { assistantContext } from "../../daemon/driver/usage.ts";
import { buildChildEnv, parseUsage } from "../../daemon/driver/protocol.ts";
import { killChildAndWait, termGroupAfterExit } from "../../daemon/driver/process.ts";
import { spawnOwnedProcess } from "../../daemon/platform/index.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import { ForkUnsupportedError } from "../../daemon/handover/forker.ts";
import { ensureClaudeSkillPlugin } from "./skills.ts";
import type { ForkHandle, ForkSource, ForkWriteResult, SessionForker } from "../../daemon/handover/forker.ts";

const CLAUDE_FORKER_ID = "claude-native";

// stream-json reports per-request context size and requires --verbose.
const CLAUDE_FORK_FIXED_ARGS: readonly string[] = ["-p", "--output-format", "stream-json", "--verbose"];
const NO_PERSISTENCE_ARG = "--no-session-persistence";
const STDERR_TAIL_CHARS = 2000;

export interface ClaudeForkerOptions {
  persist?: boolean;
  configDir?: string;
}

// claude maps cwd to a projects/ dir by replacing non-alphanumerics with -.
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function buildClaudeForkArgs(src: ForkSource, forkId: string, persist: boolean, settings: string): string[] {
  const args = [...CLAUDE_FORK_FIXED_ARGS, "--resume", src.vendorSessionId, "--fork-session", "--session-id", forkId];
  if (!persist) args.push(NO_PERSISTENCE_ARG);
  args.push(...agentLaunchArgs({ vendor: src.vendor, model: src.model, effort: src.effort }));
  args.push("--append-system-prompt-file", src.launch.promptFile, "--settings", settings);
  if (src.launch.skillsDir) args.push("--plugin-dir", ensureClaudeSkillPlugin(src.launch.skillsDir));
  for (const dir of src.addDirs) args.push("--add-dir", dir);
  return args;
}

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
      const spawned = spawnOwnedProcess(src.executablePath, buildClaudeForkArgs(src, fork.forkId, persist, settings), {
        cwd: src.cwd,
        env: buildChildEnv(process.env, src.launch.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const child: ChildProcessWithoutNullStreams = spawned.child;
      trackChild(child, "handover:claude", { detached: spawned.detached });
      child.once("exit", () => termGroupAfterExit(child));
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
          finish(() => {
            void killChildAndWait(child).finally(() => reject(new Error("aborted")));
          });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
        child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr = (stderr + c).slice(-STDERR_TAIL_CHARS)));
        child.stdin.on("error", () => {});
        child.once("error", (error) => finish(() => reject(new Error(`${src.executablePath}: ${error.message}`))));
        child.once("close", (code, sig) => {
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

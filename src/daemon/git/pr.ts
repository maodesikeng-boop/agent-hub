import { execFile } from "node:child_process";
import type { WorkerPr, WorkerPrProbeResult } from "../../shared/hub.ts";
import { GH_MAX_BUFFER_BYTES, WORKER_PR_PROBE_TIMEOUT_MS } from "../../shared/limits.ts";
import { findExecutable } from "../../shared/paths.ts";
import { firstEnvKey, resolveSpawn } from "../platform/index.ts";

const PR_FIELDS = "number,state,url";

function toPr(raw: unknown): WorkerPr | null {
  const pr = raw as { number?: unknown; state?: unknown; url?: unknown } | null | undefined;
  if (pr === null || pr === undefined || typeof pr.number !== "number" || typeof pr.state !== "string" || typeof pr.url !== "string") return null;
  return { number: pr.number, state: pr.state, url: pr.url };
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export function parsePrList(stdout: string): WorkerPr | null {
  const list = parseJson(stdout);
  return Array.isArray(list) ? toPr(list[0]) : null;
}

export function parsePrView(stdout: string): WorkerPr | null {
  return toPr(parseJson(stdout));
}

export function describeGhError(
  error: { code?: string | number | null; killed?: boolean; signal?: NodeJS.Signals | null },
  stderr: string = "",
): string {
  if (error.killed || error.signal === "SIGTERM" || error.signal === "SIGKILL" || error.code === "ETIMEDOUT") {
    return "gh 超时";
  }
  if (error.code === "ENOENT") {
    return "gh 没装";
  }
  if (/auth|login|logged in|token|credential|forbidden|permission|401|403/i.test(stderr)) {
    return "gh 未登录或无权限";
  }
  if (/network|connect|timed? out|dns|resolve|enotfound|econnrefused|tls|ssl/i.test(stderr)) {
    return "gh 网络错误";
  }
  return "gh 未登录或无权限";
}

function runGh(cwd: string, args: string[], parse: (stdout: string) => WorkerPr | null, timeoutMs: number): Promise<WorkerPrProbeResult> {
  return new Promise((done) => {
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
      let file = "gh";
      let finalArgs = args;
      let windowsVerbatimArguments: boolean | undefined;
      if (process.platform === "win32") {
        const pathKey = firstEnvKey(env, "PATH");
        const pathExtKey = firstEnvKey(env, "PATHEXT");
        const found = findExecutable("gh", pathKey ? env[pathKey] : undefined, [], {
          platform: "win32",
          pathExt: pathExtKey ? env[pathExtKey] : undefined,
        });
        if (found !== null) {
          const spawned = resolveSpawn({ program: found, args, cwd, env }, "win32");
          file = spawned.file;
          finalArgs = spawned.args;
          windowsVerbatimArguments = spawned.options.windowsVerbatimArguments;
        }
      }
      execFile(
        file,
        finalArgs,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: GH_MAX_BUFFER_BYTES,
          env,
          windowsHide: true,
          ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        },
        (error, stdout, stderr) =>
          done(error === null ? parse(stdout) : { unavailable: describeGhError(error, stderr) }),
      );
    } catch {
      done(null); // execFile throws errors like EPERM synchronously instead of via the callback.
    }
  });
}

export function probePr(cwd: string, branch: string, timeoutMs: number = WORKER_PR_PROBE_TIMEOUT_MS): Promise<WorkerPrProbeResult> {
  return runGh(cwd, ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", PR_FIELDS], parsePrList, timeoutMs);
}

export function probePrByUrl(cwd: string, url: string, timeoutMs: number = WORKER_PR_PROBE_TIMEOUT_MS): Promise<WorkerPrProbeResult> {
  if (!/^https?:\/\/\S+$/iu.test(url)) return Promise.resolve(null);
  return runGh(cwd, ["pr", "view", url, "--json", PR_FIELDS], parsePrView, timeoutMs);
}

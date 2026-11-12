// 查 Worker 分支上的 PR（hub worker show、hub graph finish 用）：gh pr list --head <分支>；手工补记的 PR 网址用 gh pr view <网址>。只取编号、状态、网址三样；
// 没有 PR（gh 退出码 0、输出 []）返回 null；gh 没装、没登录、没网、超时或报错返回 { unavailable: 原因 }，不抛错。
// 用守护进程自己的 gh 登录，不传令牌、不输出别的。
import { execFile } from "node:child_process";
import type { WorkerPr, WorkerPrProbeResult } from "../../shared/hub.ts";
import { GH_MAX_BUFFER_BYTES, WORKER_PR_PROBE_TIMEOUT_MS } from "../../shared/limits.ts";

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

/** 同一个分支开过几次 PR 取最近的一个（gh 按创建时间倒序）。 */
export function parsePrList(stdout: string): WorkerPr | null {
  const list = parseJson(stdout);
  return Array.isArray(list) ? toPr(list[0]) : null;
}

/** gh pr view --json 输出的是单个对象。 */
export function parsePrView(stdout: string): WorkerPr | null {
  return toPr(parseJson(stdout));
}

/** 把 gh 执行失败的错误和 stderr 归类成简短中文原因。 */
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
      execFile(
        "gh",
        args,
        { cwd, timeout: timeoutMs, maxBuffer: GH_MAX_BUFFER_BYTES, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } },
        (error, stdout, stderr) =>
          done(error === null ? parse(stdout) : { unavailable: describeGhError(error, stderr) }),
      );
    } catch {
      done(null); // EPERM 这类错误 execFile 是同步抛的，不走回调
    }
  });
}

export function probePr(cwd: string, branch: string, timeoutMs: number = WORKER_PR_PROBE_TIMEOUT_MS): Promise<WorkerPrProbeResult> {
  return runGh(cwd, ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", PR_FIELDS], parsePrList, timeoutMs);
}

/**
 * 按网址查一个 PR（hub graph done --pr 手工补记的，节点上没有分支可查）：gh pr view <网址>。
 * 只接 http(s) 网址，别的（含以 - 开头、会被 gh 当参数的）直接 null；不是 GitHub 的网址 gh 会报错，按 unavailable 处理、不拦。
 */
export function probePrByUrl(cwd: string, url: string, timeoutMs: number = WORKER_PR_PROBE_TIMEOUT_MS): Promise<WorkerPrProbeResult> {
  if (!/^https?:\/\/\S+$/iu.test(url)) return Promise.resolve(null);
  return runGh(cwd, ["pr", "view", url, "--json", PR_FIELDS], parsePrView, timeoutMs);
}

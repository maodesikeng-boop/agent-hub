// 查 Worker 分支上的 PR（hub worker show 用）：gh pr list --head <分支>。只取编号、状态、网址三样；
// 没有 PR（gh 退出码 0、输出 []）返回 null；gh 没装、没登录、没网、超时或报错返回 { unavailable: 原因 }，不抛错。
// 用守护进程自己的 gh 登录，不传令牌、不输出别的。
import { execFile } from "node:child_process";
import type { WorkerPr, WorkerPrProbeResult } from "../../shared/hub.ts";
import { GH_MAX_BUFFER_BYTES, WORKER_PR_PROBE_TIMEOUT_MS } from "../../shared/limits.ts";

const PR_FIELDS = "number,state,url";

/** 同一个分支开过几次 PR 取最近的一个（gh 按创建时间倒序）。 */
export function parsePrList(stdout: string): WorkerPr | null {
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const first = list[0] as { number?: unknown; state?: unknown; url?: unknown } | undefined;
  if (first === undefined || typeof first.number !== "number" || typeof first.state !== "string" || typeof first.url !== "string") return null;
  return { number: first.number, state: first.state, url: first.url };
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

export function probePr(cwd: string, branch: string, timeoutMs: number = WORKER_PR_PROBE_TIMEOUT_MS): Promise<WorkerPrProbeResult> {
  return new Promise((done) => {
    try {
      execFile(
        "gh",
        ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", PR_FIELDS],
        { cwd, timeout: timeoutMs, maxBuffer: GH_MAX_BUFFER_BYTES, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } },
        (error, stdout, stderr) =>
          done(error === null ? parsePrList(stdout) : { unavailable: describeGhError(error, stderr) }),
      );
    } catch {
      done(null); // EPERM 这类错误 execFile 是同步抛的，不走回调
    }
  });
}

// 查 Worker 分支上的 PR（hub worker show 用）：gh pr list --head <分支>。只取编号、状态、网址三样；
// gh 没装、没登录、没网、超时、没有 PR 都当没有（返回 null），不抛错。用守护进程自己的 gh 登录，不传令牌、不输出别的。
import { execFile } from "node:child_process";
import type { WorkerPr } from "../../shared/hub.ts";
import { WORKER_PR_PROBE_TIMEOUT_MS } from "../../shared/limits.ts";

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

export function probePr(cwd: string, branch: string, timeoutMs: number = WORKER_PR_PROBE_TIMEOUT_MS): Promise<WorkerPr | null> {
  return new Promise((done) => {
    try {
      execFile(
        "gh",
        ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", PR_FIELDS],
        { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } },
        (error, stdout) => done(error === null ? parsePrList(stdout) : null),
      );
    } catch {
      done(null); // EPERM 这类错误 execFile 是同步抛的，不走回调
    }
  });
}

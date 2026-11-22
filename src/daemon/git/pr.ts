import type { WorkerPr, WorkerPrProbeResult } from "../../shared/hub.ts";
import { WORKER_PR_PROBE_TIMEOUT_MS } from "../../shared/limits.ts";
import { execGh, type GhRunResult } from "./gh.ts";

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

export function describeGhError(failure: Pick<Extract<GhRunResult, { kind: "failed" }>, "timedOut" | "missing" | "stderr">): string {
  if (failure.timedOut) return "gh 超时";
  if (failure.missing) return "gh 没装";
  if (/auth|login|logged in|token|credential|forbidden|permission|401|403/i.test(failure.stderr)) {
    return "gh 未登录或无权限";
  }
  if (/network|connect|timed? out|dns|resolve|enotfound|econnrefused|tls|ssl/i.test(failure.stderr)) {
    return "gh 网络错误";
  }
  return "gh 未登录或无权限";
}

async function runGhPr(cwd: string, args: string[], parse: (stdout: string) => WorkerPr | null, timeoutMs: number): Promise<WorkerPrProbeResult> {
  const result = await execGh(cwd, args, { timeoutMs });
  if (result.kind === "ok") return parse(result.stdout);
  // gh could not be launched at all (EPERM, EACCES in a sandbox): report no PR, as the probe did before execGh existed.
  if (typeof result.code === "string" && !result.missing && !result.timedOut) return null;
  return { unavailable: describeGhError(result) };
}

export function probePr(cwd: string, branch: string, timeoutMs: number = WORKER_PR_PROBE_TIMEOUT_MS): Promise<WorkerPrProbeResult> {
  return runGhPr(cwd, ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", PR_FIELDS], parsePrList, timeoutMs);
}

export function probePrByUrl(cwd: string, url: string, timeoutMs: number = WORKER_PR_PROBE_TIMEOUT_MS): Promise<WorkerPrProbeResult> {
  if (!/^https?:\/\/\S+$/iu.test(url)) return Promise.resolve(null);
  return runGhPr(cwd, ["pr", "view", url, "--json", PR_FIELDS], parsePrView, timeoutMs);
}

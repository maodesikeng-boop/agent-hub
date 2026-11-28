// Scans GitHub Actions workflow configs and verifies recorded CI runs against live or injected run/job metadata.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { isAgentVendor, type AgentVendor } from "../src/shared/vendors.ts";
import {
  commitsAlign,
  redactText,
  type MatrixValidationProblem,
  type VerificationMatrix,
  type VerificationPlatform,
  type WorkflowRealCliPlatformMap,
} from "./verification-matrix-model.ts";

export interface GitHubWorkflowJobMetadata {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  labels: readonly string[];
}

export interface GitHubWorkflowRunMetadata {
  id: number;
  head_sha: string;
  path: string;
  status: string;
  conclusion: string | null;
  jobs: readonly GitHubWorkflowJobMetadata[];
}

export interface GitHubRunRef {
  owner: string;
  repo: string;
  runId: string;
  jobId?: string;
}

export type GitHubRunFetcher = (ref: GitHubRunRef) => Promise<GitHubWorkflowRunMetadata>;

const GITHUB_RUN_URL_CAPTURE_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?$/;
const MAX_JOB_PAGES = 5;

export function platformsFromRunsOn(runsOn: string | string[] | undefined): VerificationPlatform[] {
  const labels = Array.isArray(runsOn) ? runsOn : typeof runsOn === "string" ? [runsOn] : [];
  const found = new Set<VerificationPlatform>();
  for (const label of labels) {
    const lower = label.toLowerCase();
    if (lower.startsWith("ubuntu") || lower.includes("linux")) found.add("linux");
    else if (lower.startsWith("windows")) found.add("windows");
    else if (lower.startsWith("macos")) found.add("macos");
  }
  return [...found].sort();
}

interface ParsedWorkflowJob {
  "runs-on"?: string | string[];
  env?: Record<string, unknown>;
  steps?: Array<{ env?: Record<string, unknown> }>;
}

interface ParsedWorkflow {
  env?: Record<string, unknown>;
  jobs?: Record<string, ParsedWorkflowJob>;
}

function collectEnvRealCli(env: Record<string, unknown> | undefined, target: Set<AgentVendor>, file: string): void {
  const raw = env?.["BELLWOOD_REQUIRE_REAL_CLI"];
  if (typeof raw !== "string" || raw.trim() === "") return;
  for (const part of raw.split(",")) {
    const vendor = part.trim();
    if (vendor === "") continue;
    if (!isAgentVendor(vendor)) {
      throw new Error(`Workflow ${file} declares unknown vendor "${vendor}" in BELLWOOD_REQUIRE_REAL_CLI`);
    }
    target.add(vendor);
  }
}

export function scanWorkflows(workflowsDir: string): {
  realCliVendors: Record<string, readonly AgentVendor[]>;
  platforms: Record<string, readonly VerificationPlatform[]>;
  realCliPlatforms: Record<string, Partial<Record<VerificationPlatform, readonly AgentVendor[]>>>;
} {
  const realCliVendors: Record<string, readonly AgentVendor[]> = {};
  const platforms: Record<string, readonly VerificationPlatform[]> = {};
  const realCliPlatforms: Record<string, Partial<Record<VerificationPlatform, readonly AgentVendor[]>>> = {};
  const files = readdirSync(workflowsDir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml")).sort();
  for (const file of files) {
    const parsed = parseYaml(readFileSync(join(workflowsDir, file), "utf8")) as ParsedWorkflow | null;
    if (!parsed || typeof parsed !== "object") continue;
    const wfVendors = new Set<AgentVendor>();
    const wfPlatforms = new Set<VerificationPlatform>();
    const byPlatform: Partial<Record<VerificationPlatform, Set<AgentVendor>>> = {};
    const topEnvVendors = new Set<AgentVendor>();
    collectEnvRealCli(parsed.env, topEnvVendors, file);
    for (const v of topEnvVendors) wfVendors.add(v);

    for (const job of Object.values(parsed.jobs ?? {})) {
      if (!job || typeof job !== "object") continue;
      const jobPlatforms = platformsFromRunsOn(job["runs-on"]);
      for (const p of jobPlatforms) wfPlatforms.add(p);
      const jobVendors = new Set<AgentVendor>(topEnvVendors);
      collectEnvRealCli(job.env, jobVendors, file);
      for (const step of job.steps ?? []) collectEnvRealCli(step?.env, jobVendors, file);
      for (const v of jobVendors) wfVendors.add(v);
      if (jobVendors.size > 0) {
        for (const p of jobPlatforms) {
          byPlatform[p] ??= new Set<AgentVendor>();
          for (const v of jobVendors) byPlatform[p]!.add(v);
        }
      }
    }
    if (wfPlatforms.size > 0) platforms[file] = [...wfPlatforms].sort();
    if (wfVendors.size > 0) realCliVendors[file] = [...wfVendors].sort();
    const mapped = Object.fromEntries(
      Object.entries(byPlatform).map(([p, set]) => [p, [...set!].sort()]),
    ) as Partial<Record<VerificationPlatform, readonly AgentVendor[]>>;
    if (Object.keys(mapped).length > 0) realCliPlatforms[file] = mapped;
  }
  return { realCliVendors, platforms, realCliPlatforms };
}

export function readWorkflowRealCliVendors(workflowsDir: string): Readonly<Record<string, readonly AgentVendor[]>> {
  return scanWorkflows(workflowsDir).realCliVendors;
}

export function readWorkflowPlatforms(workflowsDir: string): Readonly<Record<string, readonly VerificationPlatform[]>> {
  return scanWorkflows(workflowsDir).platforms;
}

export function readWorkflowRealCliPlatforms(workflowsDir: string): WorkflowRealCliPlatformMap {
  return scanWorkflows(workflowsDir).realCliPlatforms;
}

export function parseGitHubRunUrl(url: string): GitHubRunRef | null {
  const match = GITHUB_RUN_URL_CAPTURE_RE.exec(url.trim());
  if (!match) return null;
  return {
    owner: match[1]!,
    repo: match[2]!,
    runId: match[3]!,
    ...(match[4] ? { jobId: match[4] } : {}),
  };
}

async function fetchGitHubJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${url} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function defaultGitHubRunFetcher(ref: GitHubRunRef): Promise<GitHubWorkflowRunMetadata> {
  const token = process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"];
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "bellwood-verification-matrix",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const baseUrl = `https://api.github.com/repos/${ref.owner}/${ref.repo}/actions/runs/${ref.runId}`;
  const runData = await fetchGitHubJson<{
    id: number;
    head_sha: string;
    path: string;
    status: string;
    conclusion: string | null;
  }>(baseUrl, headers);

  const jobs: GitHubWorkflowJobMetadata[] = [];
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const pageData = await fetchGitHubJson<{
      total_count?: number;
      jobs?: GitHubWorkflowJobMetadata[];
    }>(`${baseUrl}/jobs?per_page=100&page=${page}`, headers);
    const pageJobs = Array.isArray(pageData.jobs) ? pageData.jobs : [];
    jobs.push(...pageJobs);
    if (pageJobs.length < 100 || (typeof pageData.total_count === "number" && jobs.length >= pageData.total_count)) {
      break;
    }
  }

  return {
    id: runData.id,
    head_sha: runData.head_sha,
    path: runData.path,
    status: runData.status,
    conclusion: runData.conclusion,
    jobs,
  };
}

export async function verifyRecordedRunsOnline(
  matrix: VerificationMatrix,
  opts?: { fetcher?: GitHubRunFetcher; expectedRepo?: string },
): Promise<MatrixValidationProblem[]> {
  const fetcher = opts?.fetcher ?? defaultGitHubRunFetcher;
  const expectedRepo = opts?.expectedRepo?.trim().toLowerCase();
  const problems: MatrixValidationProblem[] = [];
  const cache = new Map<string, Promise<GitHubWorkflowRunMetadata>>();

  const loadRun = (ref: GitHubRunRef): Promise<GitHubWorkflowRunMetadata> => {
    const key = `${ref.owner}/${ref.repo}/${ref.runId}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = fetcher({ owner: ref.owner, repo: ref.repo, runId: ref.runId });
      cache.set(key, pending);
    }
    return pending;
  };

  for (let idx = 0; idx < matrix.recordedRuns.length; idx += 1) {
    const run = matrix.recordedRuns[idx]!;
    const path = `recordedRuns[${idx}]`;
    const isWorkflowSource = /\.ya?ml$/i.test(run.source.trim());
    const ref = parseGitHubRunUrl(run.urlOrRef);
    if (!isWorkflowSource && !ref) continue;
    if (!ref) {
      problems.push({
        path: `${path}.urlOrRef`,
        code: "unverified_run_evidence",
        message: `Recorded workflow run "${run.id}" does not have a verifiable GitHub Actions run URL`,
      });
      continue;
    }
    if (expectedRepo && `${ref.owner}/${ref.repo}`.toLowerCase() !== expectedRepo) {
      problems.push({
        path: `${path}.urlOrRef`,
        code: "unverified_run_evidence",
        message: `Actions run ${ref.runId} belongs to "${ref.owner}/${ref.repo}", not expected repository "${opts?.expectedRepo}"`,
      });
      continue;
    }

    let meta: GitHubWorkflowRunMetadata;
    try {
      meta = await loadRun(ref);
    } catch (error) {
      problems.push({
        path: `${path}.urlOrRef`,
        code: "unverified_run_evidence",
        message: `Failed to verify Actions run ${ref.runId}: ${redactText(error instanceof Error ? error.message : String(error))}`,
      });
      continue;
    }

    if (!commitsAlign(meta.head_sha, matrix.commit) || !commitsAlign(meta.head_sha, run.commit)) {
      problems.push({
        path: `${path}.commit`,
        code: "unverified_run_evidence",
        message: `Actions run ${ref.runId} head_sha "${meta.head_sha}" does not match recorded commit "${run.commit}" and matrix commit "${matrix.commit}"`,
      });
    }

    const actualWorkflow = basename(meta.path.replace(/\\/g, "/"));
    if (isWorkflowSource && actualWorkflow !== run.source) {
      problems.push({
        path: `${path}.source`,
        code: "workflow_mismatch",
        message: `Actions run ${ref.runId} ran workflow "${actualWorkflow}", not declared source "${run.source}"`,
      });
    }

    if (ref.jobId) {
      const job = meta.jobs.find((item) => String(item.id) === ref.jobId);
      if (!job) {
        problems.push({
          path: `${path}.urlOrRef`,
          code: "unverified_run_evidence",
          message: `Actions run ${ref.runId} does not contain job ${ref.jobId}`,
        });
      } else if (job.status !== "completed" || job.conclusion !== "success") {
        problems.push({
          path: `${path}.urlOrRef`,
          code: "unverified_run_evidence",
          message: `Actions job ${ref.jobId} (${job.name}) did not succeed (status=${job.status}, conclusion=${String(job.conclusion)})`,
        });
      } else {
        const jobPlatforms = platformsFromRunsOn([...job.labels]);
        if (!jobPlatforms.includes(run.platform)) {
          problems.push({
            path: `${path}.platform`,
            code: "platform_mismatch",
            message: `Actions job ${ref.jobId} (${job.name}) ran on [${jobPlatforms.join(", ") || "unknown"}], not "${run.platform}"`,
          });
        }
      }
      continue;
    }

    if (meta.status !== "completed" || meta.conclusion !== "success") {
      problems.push({
        path: `${path}.urlOrRef`,
        code: "unverified_run_evidence",
        message: `Actions run ${ref.runId} did not succeed (status=${meta.status}, conclusion=${String(meta.conclusion)})`,
      });
    }

    const passingPlatforms = new Set<VerificationPlatform>();
    for (const job of meta.jobs) {
      if (job.status !== "completed" || job.conclusion !== "success") continue;
      for (const platform of platformsFromRunsOn([...job.labels])) passingPlatforms.add(platform);
    }
    if (!passingPlatforms.has(run.platform)) {
      problems.push({
        path: `${path}.platform`,
        code: "platform_mismatch",
        message: `Actions run ${ref.runId} has no passing job on "${run.platform}" (passing job platforms: [${[...passingPlatforms].sort().join(", ") || "none"}])`,
      });
    }
  }

  return problems;
}

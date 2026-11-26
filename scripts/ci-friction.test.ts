import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PR_BODY_TAG_PREFIX } from "./pr-body-sync.ts";
import { REPO_ROOT } from "./stage-runtime-common.ts";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  "timeout-minutes"?: number;
}

interface Job {
  name?: string;
  if?: string;
  permissions?: Record<string, string>;
  "timeout-minutes"?: number;
  steps?: Step[];
}

interface PushFilter {
  branches?: string[];
  tags?: string[];
}

interface Workflow {
  on: { push?: PushFilter | null } & Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

interface CompositeAction {
  runs: { using: string; steps: Step[] };
}

const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");
const APT_ACTION = join(REPO_ROOT, ".github", "actions", "apt-install", "action.yml");
const APT_ACTION_USES = "./.github/actions/apt-install";

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, wf: parse(readFileSync(join(WORKFLOW_DIR, name), "utf8")) as Workflow }));

function workflow(name: string): Workflow {
  const hit = workflows.find((w) => w.name === name);
  if (!hit) throw new Error(`missing workflow ${name}`);
  return hit.wf;
}

function job(wf: string, id: string): Job {
  const hit = workflow(wf).jobs[id];
  if (!hit) throw new Error(`missing job ${id} in ${wf}`);
  return hit;
}

function aptStep(j: Job): Step | undefined {
  return j.steps?.find((step) => step.uses === APT_ACTION_USES);
}

/** Minimal glob for GitHub push filters: `*` matches inside one segment, `**` across segments. */
function filterMatches(pattern: string, ref: string): boolean {
  const re = pattern
    .split("**")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*"))
    .join(".*");
  return new RegExp(`^${re}$`, "u").test(ref);
}

describe("apt packages on CI runners", () => {
  it("never install Playwright system packages with a bare --with-deps, which hits the apt mirror on every run", () => {
    for (const { name, wf } of workflows) {
      for (const [id, j] of Object.entries(wf.jobs)) {
        for (const step of j.steps ?? []) expect(step.run ?? "", `${name} ${id}`).not.toMatch(/--with-deps\b/u);
      }
    }
  });

  it("install apt packages through one composite action with cached debs, a timeout on every apt call, and the archive.ubuntu.com fallback", () => {
    expect(existsSync(APT_ACTION)).toBe(true);
    const action = parse(readFileSync(APT_ACTION, "utf8")) as CompositeAction;
    expect(action.runs.using).toBe("composite");
    expect(action.runs.steps.some((step) => step.uses?.startsWith("actions/cache@"))).toBe(true);
    const scripts = action.runs.steps.map((step) => step.run ?? "").join("\n");
    expect(scripts).toContain("archive.ubuntu.com");
    const installCommands = scripts.split("\n").map((line) => line.trim()).filter(
      (line) => !line.startsWith("#") && /\$(?:INSTALL\b|\{INSTALL\})/u.test(line),
    );
    expect(installCommands.length, "the action must execute its install input").toBeGreaterThan(0);
    for (const command of installCommands) {
      expect(command).toMatch(/^sudo timeout(?: --kill-after=\d+s)? \d+ (?:env [^;&|]+ )?bash (?:-e )?-c "\$INSTALL"$/u);
    }
  });

  it("use that action in the check sandbox job, the verify smoke job, and the release smoke job, each with a step timeout below the job's", () => {
    for (const [wf, id] of [
      ["check.yml", "check"],
      ["check.yml", "verify-smoke"],
      ["release.yml", "smoke"],
    ] as const) {
      const j = job(wf, id);
      const step = aptStep(j);
      expect(step, `${wf} ${id}`).toBeDefined();
      expect(step?.["timeout-minutes"], `${wf} ${id}`).toBeLessThan(j["timeout-minutes"] ?? 360);
    }
  });

  it("probe Playwright's packages with install-deps --dry-run before installing them in the verify smoke job", () => {
    const step = aptStep(job("check.yml", "verify-smoke"));
    expect(step?.with?.probe).toMatch(/playwright install-deps --dry-run chromium webkit/u);
    expect(step?.with?.install).toMatch(/playwright install-deps chromium webkit/u);
  });
});

describe("pr-body.yml", () => {
  it("runs only on pushes of pr-body/* tags", () => {
    const push = workflow("pr-body.yml").on.push;
    expect(push?.tags).toEqual([`${PR_BODY_TAG_PREFIX}*`]);
    expect(push?.branches).toBeUndefined();
    expect(Object.keys(workflow("pr-body.yml").on)).toEqual(["push"]);
  });

  it("grants only pull-requests write and contents write, and posts no status", () => {
    const wf = workflow("pr-body.yml");
    expect(wf.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    for (const j of Object.values(wf.jobs)) expect(j.permissions).toBeUndefined();
    expect(JSON.stringify(wf)).not.toMatch(/statuses/u);
  });

  it("runs scripts/pr-body-sync.ts with the workflow token", () => {
    const steps = Object.values(workflow("pr-body.yml").jobs).flatMap((j) => j.steps ?? []);
    const sync = steps.find((step) => step.run?.startsWith("node scripts/pr-body-sync.ts"));
    expect(sync?.env?.GH_TOKEN).toBe("${{ github.token }}");
  });

  it("is the only workflow a pr-body tag push starts", () => {
    const tagRef = `${PR_BODY_TAG_PREFIX}452`;
    for (const { name, wf } of workflows) {
      if (name === "pr-body.yml" || !("push" in wf.on)) continue;
      const push = wf.on.push ?? {};
      expect(push.branches !== undefined || push.tags !== undefined, `${name} push has no branch or tag filter`).toBe(true);
      expect((push.tags ?? []).some((pattern) => filterMatches(pattern, tagRef)), name).toBe(false);
    }
  });
});

describe("migration-claims job", () => {
  it("runs in check.yml on every pull request with a read-only pull-requests token", () => {
    const j = job("check.yml", "migration-claims");
    expect(j.name).toBe("migration-claims");
    expect(j.if).toBeUndefined();
    expect(j.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(j.steps?.some((step) => /^node scripts\/migration-claims\.ts --pr\b/u.test(step.run ?? ""))).toBe(true);
  });
});

describe("review-stamp.yml", () => {
  it("passes the previous head so the gate can carry a stamp across a base-only update", () => {
    const steps = Object.values(workflow("review-stamp.yml").jobs).flatMap((j) => j.steps ?? []);
    const gate = steps.find((step) => step.run === "node scripts/review-stamp-gate.ts");
    expect(gate?.env?.BEFORE_SHA).toBe("${{ github.event.before }}");
  });
});

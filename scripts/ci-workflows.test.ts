import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPO_ROOT, STAGED_RUNTIME_INPUTS } from "./stage-runtime-common.ts";

interface TriggerFilter {
  branches?: string[];
  paths?: string[];
  "paths-ignore"?: string[];
}

interface Workflow {
  on: { push?: TriggerFilter; pull_request?: TriggerFilter; schedule?: Array<{ cron: string }> } & Record<string, unknown>;
  concurrency?: { group: string; "cancel-in-progress": string | boolean };
  jobs: Record<string, { uses?: string; "runs-on"?: string }>;
}

const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");
const WORKFLOWS = readdirSync(WORKFLOW_DIR)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, wf: parse(readFileSync(join(WORKFLOW_DIR, name), "utf8")) as Workflow }));

function workflow(name: string): Workflow {
  const hit = WORKFLOWS.find((w) => w.name === name);
  if (!hit) throw new Error(`missing workflow ${name}`);
  return hit.wf;
}

function runsOnMainPush(wf: Workflow): boolean {
  return wf.on.push?.branches?.includes("main") ?? false;
}

describe(".github/workflows", () => {
  it("never cancel or replace a run on main", () => {
    const onMain = WORKFLOWS.filter(({ wf }) => runsOnMainPush(wf));
    expect(onMain.map((w) => w.name).sort()).toEqual(["check.yml", "mac-desktop.yml", "windows-desktop.yml", "windows.yml"]);
    for (const { name, wf } of onMain) {
      expect(wf.concurrency?.["cancel-in-progress"], name).toBe("${{ github.event_name == 'pull_request' }}");
      // A shared group would still let a newer main run replace a pending one, so non-PR runs key on the commit.
      expect(wf.concurrency?.group, name).toContain("github.event_name == 'pull_request' && github.head_ref || github.sha");
    }
  });

  it("run the full suite on an unchanged main every night at 23:00 Beijing time without cancelling", () => {
    const nightly = workflow("nightly.yml");
    expect(nightly.on.schedule).toEqual([{ cron: "0 15 * * *" }]);
    expect(nightly.concurrency).toBeUndefined();
    const reused = Object.values(nightly.jobs).flatMap((job) => (job.uses ? [job.uses] : []));
    expect(reused.sort()).toEqual(["./.github/workflows/check.yml", "./.github/workflows/windows.yml"]);
    for (const path of reused) expect(workflow(path.split("/").at(-1)!).on).toHaveProperty("workflow_call");
    expect(Object.values(nightly.jobs).some((job) => job["runs-on"]?.startsWith("macos"))).toBe(true);
  });

  it("run check on every pull request so its required status checks always report", () => {
    const pr = workflow("check.yml").on.pull_request;
    expect(pr?.branches).toEqual(["main"]);
    expect(pr?.paths).toBeUndefined();
    expect(pr?.["paths-ignore"]).toBeUndefined();
  });

  it.each(["mac-desktop.yml", "windows-desktop.yml"])("%s rebuilds on main for every staged runtime input", (name) => {
    const paths = workflow(name).on.push?.paths ?? [];
    for (const input of STAGED_RUNTIME_INPUTS) {
      const covered = paths.includes(input) || paths.includes(`${input}/**`);
      expect(covered, `${name} push.paths misses ${input}`).toBe(true);
    }
  });

  it("run the release version check when SECURITY.md changes", () => {
    expect(workflow("release.yml").on.pull_request?.paths).toContain("SECURITY.md");
  });

  it("only filter on paths that exist", () => {
    for (const { name, wf } of WORKFLOWS) {
      for (const filter of [wf.on.push, wf.on.pull_request]) {
        for (const pattern of [...(filter?.paths ?? []), ...(filter?.["paths-ignore"] ?? [])]) {
          const literal = pattern.split("*")[0]!.replace(/\/$/, "");
          expect(existsSync(join(REPO_ROOT, literal)), `${name}: ${pattern}`).toBe(true);
        }
      }
    }
  });
});

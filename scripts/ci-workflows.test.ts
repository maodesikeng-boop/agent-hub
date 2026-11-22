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

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string>;
}

interface Job {
  uses?: string;
  "runs-on"?: string;
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  permissions?: Record<string, string>;
  on: { push?: TriggerFilter; pull_request?: TriggerFilter; schedule?: Array<{ cron: string }> } & Record<string, unknown>;
  concurrency?: { group: string; "cancel-in-progress": string | boolean };
  jobs: Record<string, Job>;
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

function needsOf(job: Job): string[] {
  return job.needs === undefined ? [] : [job.needs].flat();
}

function workflowText(name: string): string {
  return readFileSync(join(WORKFLOW_DIR, name), "utf8");
}

const BUILD_ONLY = "needs.plan.outputs.mode == 'build'";
const RELEASE_GATES = { check: "check.yml", windows: "windows.yml", macos: "macos.yml" } as const;

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
    expect(reused.sort()).toEqual(["./.github/workflows/check.yml", "./.github/workflows/macos.yml", "./.github/workflows/windows.yml"]);
    for (const path of reused) expect(workflow(path.split("/").at(-1)!).on).toHaveProperty("workflow_call");
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

  it("publish an rc only after check.yml, windows.yml, macos.yml, the pnpm verify smoke job, and both installer builds pass", () => {
    const { jobs } = workflow("release.yml");
    for (const [job, file] of Object.entries(RELEASE_GATES)) {
      expect(jobs[job]?.uses, job).toBe(`./.github/workflows/${file}`);
    }
    expect(jobs["windows-build"]?.uses).toBe("./.github/workflows/windows-desktop.yml");
    expect(jobs["mac-build"]?.uses).toBe("./.github/workflows/mac-desktop.yml");
    expect(jobs.smoke?.steps?.some((step) => step.run?.startsWith("pnpm verify"))).toBe(true);
    expect(needsOf(jobs.assemble!).sort()).toEqual(["check", "mac-build", "macos", "plan", "smoke", "windows", "windows-build"]);
    expect(needsOf(jobs.publish!).sort()).toEqual(["assemble", "check", "macos", "plan", "smoke", "windows"]);
    // Without its own if, publish keeps the implicit success() and is skipped unless every gate passed.
    expect(jobs.publish!.if).toBeUndefined();
  });

  it("publish only on tag pushes, so workflow_dispatch on any ref is a dry run", () => {
    const wf = workflow("release.yml");
    expect(wf.on.push).toEqual({ tags: ["v*"] });
    expect(wf.on).toHaveProperty("workflow_dispatch.inputs.tag.required", true);
    const writers = Object.entries(wf.jobs).filter(([, job]) => job.permissions?.contents === "write");
    expect(writers.map(([name]) => name).sort()).toEqual(["promote", "publish"]);
    for (const [name, job] of writers) {
      const runs = (job.steps ?? []).flatMap((step) => (step.run ? [step.run] : []));
      // release-assets.ts publish forces a dry run unless isTagPushOf(tag) holds.
      expect(runs.filter((run) => !run.startsWith("pnpm install")), name).toEqual([
        `node scripts/release-assets.ts publish --tag "$TAG" --expect-mode ${name === "publish" ? "build" : "promote"} --assets-dir ${name === "publish" ? "release-assets" : '"$RUNNER_TEMP/release-assets"'}`,
      ]);
    }
  });

  it("never pass --clobber or upload to an existing release in release.yml", () => {
    const text = workflowText("release.yml");
    expect(text).not.toContain("--clobber");
    expect(text).not.toMatch(/gh release (upload|edit|delete|create)/);
  });

  it("skip the test gates and builds when a formal tag promotes an rc", () => {
    const { jobs } = workflow("release.yml");
    for (const name of [...Object.keys(RELEASE_GATES), "smoke", "windows-build", "mac-build"]) {
      expect(needsOf(jobs[name]!), name).toEqual(["plan"]);
      expect(jobs[name]!.if, name).toBe(BUILD_ONLY);
    }
    expect(needsOf(jobs.promote!)).toEqual(["plan"]);
    expect(jobs.promote!.if).toBe("needs.plan.outputs.mode == 'promote'");
  });

  it("write the public provenance attestation only after every test gate and both installer builds pass", () => {
    const { jobs } = workflow("release.yml");
    const needs = needsOf(jobs.assemble!);
    for (const gate of [...Object.keys(RELEASE_GATES), "smoke", "windows-build", "mac-build"]) expect(needs, gate).toContain(gate);
    // Without its own if, assemble keeps the implicit success() and is skipped when any gate fails.
    expect(jobs.assemble!.if).toBeUndefined();
  });

  it("grant id-token and attestations write only to the job that attests the installers", () => {
    const { jobs } = workflow("release.yml");
    const attesting = Object.entries(jobs).filter(([, job]) => job.permissions?.["id-token"] === "write" || job.permissions?.attestations === "write");
    expect(attesting.map(([name]) => name)).toEqual(["assemble"]);
    expect(workflow("release.yml")).toHaveProperty("permissions", { contents: "read" });
    const attest = jobs.assemble!.steps!.filter((step) => step.uses?.startsWith("actions/attest-build-provenance@"));
    expect(attest).toHaveLength(1);
    expect(attest[0]!.if).toBe("github.event_name == 'push' && github.ref_type == 'tag'");
    expect(attest[0]!.with?.["subject-path"]?.trim().split("\n").sort()).toEqual([
      "release-assets/Bellwood-macos-arm64.dmg",
      "release-assets/Bellwood-windows-x64-setup.exe",
    ]);
  });

  it("build the Windows installer with the locked @tauri-apps/cli from node_modules, never pnpm dlx", () => {
    for (const { name } of WORKFLOWS) expect(workflowText(name), name).not.toMatch(/pnpm dlx|npx /);
    const steps = workflow("windows-desktop.yml").jobs["build-windows-nsis"]!.steps!;
    const build = steps.find((step) => step.run?.includes("--bundles nsis"));
    expect(build?.run).toContain('node_modules\\.bin\\tauri.cmd');
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies["@tauri-apps/cli"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8")).toContain(`'@tauri-apps/cli@${pkg.devDependencies["@tauri-apps/cli"]}':`);
  });

  it.each(["mac-desktop.yml", "windows-desktop.yml"])("%s checks that runtime-manifest.json gitCommit equals the built commit", (name) => {
    const steps = Object.values(workflow(name).jobs).flatMap((job) => job.steps ?? []);
    const verify = steps.find((step) => step.run?.includes("gitCommit"));
    expect(verify?.run).toContain("runtime-manifest.json");
    expect(verify?.run).toMatch(/GITHUB_SHA/);
    const upload = steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(steps.indexOf(verify!)).toBeLessThan(upload);
  });

  it("run the macOS suite from one reusable macos.yml that nightly.yml and release.yml both call", () => {
    expect(workflow("macos.yml").on).toHaveProperty("workflow_call");
    expect(workflow("nightly.yml").jobs.macos?.uses).toBe("./.github/workflows/macos.yml");
    expect(workflow("release.yml").jobs.macos?.uses).toBe("./.github/workflows/macos.yml");
    const macRunners = WORKFLOWS.filter(({ wf }) => Object.values(wf.jobs).some((job) => job.steps?.some((step) => step.run?.startsWith("pnpm test:ci")) && job["runs-on"]?.startsWith("macos")));
    expect(macRunners.map((w) => w.name)).toEqual(["macos.yml"]);
  });

  it("run the release checks on pull requests that change any release script or the changelog", () => {
    const wf = workflow("release.yml");
    const paths = wf.on.pull_request?.paths ?? [];
    const unitTests = wf.jobs.plan!.steps!.find((step) => step.run?.startsWith("pnpm exec vitest run"))!.run!.match(/scripts\/\S+\.test\.ts/g) ?? [];
    expect(unitTests.length).toBeGreaterThanOrEqual(3);
    for (const test of unitTests) {
      expect(paths, test).toContain(test);
      expect(paths, test).toContain(test.replace(/\.test\.ts$/, ".ts"));
    }
    expect(paths).toContain("CHANGELOG.md");
    expect(paths).toContain(".github/release-downloads.md");
  });

  it.each(["mac-desktop.yml", "windows-desktop.yml"])("%s rebuilds when the staged lockfile logic changes", (name) => {
    expect(workflow(name).on.pull_request?.paths).toContain("scripts/staged-lockfile.ts");
    expect(workflow(name).on.push?.paths).toContain("scripts/staged-lockfile.ts");
  });

  it("run review-stamp.yml on pull_request_target for every PR to main with no path filter, so the required status always reports", () => {
    const wf = workflow("review-stamp.yml");
    expect(Object.keys(wf.on)).toEqual(["pull_request_target"]);
    const trigger = wf.on.pull_request_target as TriggerFilter & { types?: string[] };
    expect(trigger.branches).toEqual(["main"]);
    expect(trigger.types).toEqual(["opened", "synchronize", "reopened"]);
    expect(trigger.paths).toBeUndefined();
    expect(trigger["paths-ignore"]).toBeUndefined();
    expect(Object.values(wf.jobs).every((job) => job.if === undefined)).toBe(true);
  });

  it("never check out the PR head or pass PR refs to a step in review-stamp.yml", () => {
    const raw = readFileSync(join(WORKFLOW_DIR, "review-stamp.yml"), "utf8");
    expect(raw).not.toMatch(/head\.ref|head\.repo|head_ref|merge_commit|refs\/pull/);
    for (const step of Object.values(workflow("review-stamp.yml").jobs).flatMap((job) => job.steps ?? [])) {
      if (step.uses?.startsWith("actions/checkout@")) {
        expect(step.with?.ref).toBeUndefined();
        expect(step.with?.repository).toBeUndefined();
        expect(String(step.with?.["persist-credentials"])).toBe("false");
      }
      expect(step.run ?? "").not.toContain("${{");
    }
  });

  it("grant review-stamp.yml only contents read, pull-requests read, and statuses write", () => {
    const wf = workflow("review-stamp.yml");
    expect(wf.permissions).toEqual({ contents: "read", "pull-requests": "read", statuses: "write" });
    expect(Object.values(wf.jobs).every((job) => job.permissions === undefined)).toBe(true);
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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MESH_DEFAULT_RELAY_URL } from "../src/shared/limits.ts";
import { matchStampPaths, parseStampPaths } from "./review-stamp-gate.ts";
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
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface Job {
  uses?: string;
  "runs-on"?: string;
  needs?: string | string[];
  if?: string;
  environment?: string | { name: string; url?: string };
  concurrency?: { group: string; "cancel-in-progress": string | boolean };
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
const SANDBOX_RUNTIME_SYMBOLS = new Set([
  "wrapInOsSandbox",
  "wrapInReadonlyOsSandbox",
  "prepareOsSandboxForLaunch",
  "spawnInWriteScope",
  "workerWriteScope",
  "dataDirReadScope",
  "buildReadonlyPolicy",
  "dataDirDenyList",
  "win32WorkerSandboxArgs",
  "wrapReadonlyWithWin32Mxc",
  "win32MxcReadonlyAvailable",
  "WRITE_SCOPE_ENFORCERS",
  "OS_SANDBOX_BACKENDS",
]);
const SANDBOX_SYMBOL_PREFILTER = new RegExp(`\\b(?:${[...SANDBOX_RUNTIME_SYMBOLS].join("|")})\\b`, "u");
const RUNTIME_TS_WRAPPERS = new Set(["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"]);

type AstNode = { type: string; [key: string]: unknown };
const isAstNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as AstNode).type === "string";

function referencesSandboxRuntimeSymbol(file: string, source: string): boolean {
  if (!SANDBOX_SYMBOL_PREFILTER.test(source)) return false;
  const { program, errors } = parseSync(file, source);
  if (errors.length > 0) throw new Error(`${file} does not parse: ${errors[0]!.message}`);
  let found = false;

  const visit = (node: unknown): void => {
    if (found) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "ImportDeclaration") {
      if (node.importKind === "type") return;
      for (const spec of (node.specifiers as AstNode[] | undefined) ?? []) {
        if (spec.type !== "ImportSpecifier" || spec.importKind === "type" || !isAstNode(spec.imported)) continue;
        const name = (spec.imported.name ?? spec.imported.value) as string | undefined;
        if (name && SANDBOX_RUNTIME_SYMBOLS.has(name)) {
          found = true;
          return;
        }
      }
      return;
    }
    if (node.type === "ExportNamedDeclaration") {
      if (node.exportKind === "type") return;
      for (const spec of (node.specifiers as AstNode[] | undefined) ?? []) {
        if (spec.exportKind === "type") continue;
        const local = isAstNode(spec.local) ? ((spec.local.name ?? spec.local.value) as string | undefined) : undefined;
        const exported = isAstNode(spec.exported) ? ((spec.exported.name ?? spec.exported.value) as string | undefined) : undefined;
        if ((local && SANDBOX_RUNTIME_SYMBOLS.has(local)) || (exported && SANDBOX_RUNTIME_SYMBOLS.has(exported))) {
          found = true;
          return;
        }
      }
      visit(node.declaration);
      return;
    }
    if (node.type === "ExportAllDeclaration") return;
    if (RUNTIME_TS_WRAPPERS.has(node.type)) {
      visit(node.expression);
      return;
    }
    if (node.type.startsWith("TS")) return;
    if (node.type === "Identifier" && SANDBOX_RUNTIME_SYMBOLS.has(node.name as string)) {
      found = true;
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "typeAnnotation" || key === "typeParameters" || key === "returnType") continue;
      visit(value);
    }
  };

  visit(program);
  return found;
}

function productionSrcFiles(): Map<string, string> {
  const srcRoot = join(REPO_ROOT, "src");
  const files = (readdirSync(srcRoot, { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/u.test(file) && !/\.test\.tsx?$/u.test(file) && !/(^|[\\/])(test-helpers|test-utils)\.tsx?$/u.test(file) && !file.includes("fixture"))
    .map((file) => relative(REPO_ROOT, join(srcRoot, file)).split("\\").join("/"))
    .sort();
  return new Map(files.map((file) => [file, readFileSync(join(REPO_ROOT, file), "utf8")]));
}

function findUncoveredSandboxCallers(
  sources: ReadonlyMap<string, string>,
  windowsPrPaths: readonly string[],
  windowsPushPaths: readonly string[],
  stampGlobs: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const [file, source] of sources) {
    if (!referencesSandboxRuntimeSymbol(file, source)) continue;
    if (matchStampPaths([file], windowsPrPaths).length === 0) problems.push(`windows.yml pull_request.paths missing ${file}`);
    if (matchStampPaths([file], windowsPushPaths).length === 0) problems.push(`windows.yml push.paths missing ${file}`);
    if (matchStampPaths([file], stampGlobs).length === 0) problems.push(`REVIEW.md stamp paths missing ${file}`);
  }
  return problems;
}

/** Repo-relative paths of `entries` and every relative module they import at runtime; type-only imports are erased before node runs. */
function runtimeImportClosure(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const m of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gmu)) {
      queue.push(relative(REPO_ROOT, join(REPO_ROOT, dirname(file), m[1]!)).split("\\").join("/"));
    }
  }
  return [...seen];
}
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
    expect(onMain.map((w) => w.name).sort()).toEqual(["check.yml", "mac-desktop.yml", "relay.yml", "windows-desktop.yml", "windows.yml"]);
    for (const { name, wf } of onMain) {
      expect(wf.concurrency?.["cancel-in-progress"], name).toBe("${{ github.event_name == 'pull_request' }}");
      // A shared group would still let a newer main run replace a pending one, so non-PR runs key on the commit.
      expect(wf.concurrency?.group, name).toContain("github.event_name == 'pull_request' && github.head_ref || github.sha");
    }
  });

  it("run the full suite on an unchanged main every night at 22:17 Beijing time (off the top of the hour) without cancelling", () => {
    const nightly = workflow("nightly.yml");
    expect(nightly.on.schedule).toEqual([{ cron: "17 14 * * *" }]);
    expect(nightly.on.schedule?.[0]?.cron.startsWith("0 ")).toBe(false);
    expect(nightly.concurrency).toBeUndefined();
    const reused = Object.values(nightly.jobs).flatMap((job) => (job.uses ? [job.uses] : []));
    expect(reused.sort()).toEqual(["./.github/workflows/check.yml", "./.github/workflows/macos.yml", "./.github/workflows/windows.yml"]);
    for (const path of reused) expect(workflow(path.split("/").at(-1)!).on).toHaveProperty("workflow_call");

    const realCliJob = nightly.jobs["real-cli-mock-llm"];
    expect(realCliJob).toBeDefined();
    const realCliSteps = realCliJob!.steps ?? [];
    expect(realCliSteps.some((step) => step.uses === "./.github/actions/apt-install" && step.with?.install?.includes("bubblewrap") && step.with?.install?.includes("socat"))).toBe(true);
    expect(realCliSteps.some((step) => step.run === "sudo bash scripts/linux-sandbox-setup.sh")).toBe(true);
    const schemaDriftStep = realCliSteps.find((step) => step.run?.includes("diffJsonSchemaTrees"));
    expect(schemaDriftStep?.run).toContain("evaluateJsonSchemaDrift");
    expect(schemaDriftStep?.run).toContain("process.exit(");
  });

  it("run check on every pull request so its required status checks always report", () => {
    const pr = workflow("check.yml").on.pull_request;
    expect(pr?.branches).toEqual(["main"]);
    expect(pr?.paths).toBeUndefined();
    expect(pr?.["paths-ignore"]).toBeUndefined();
  });

  it("run pnpm verify in check.yml on every pull request without artifact collisions in release.yml", () => {
    const check = workflow("check.yml");
    const verifyJob = check.jobs["verify-smoke"];
    expect(verifyJob).toBeDefined();
    expect(verifyJob!.if).toBeUndefined();
    expect(verifyJob!.steps?.some((step) => step.run?.startsWith("pnpm verify"))).toBe(true);
    expect(verifyJob!.steps?.some((step) => /playwright install .*\bwebkit\b/.test(step.run ?? ""))).toBe(true);
    expect(verifyJob!.steps?.some((step) => /^pnpm verify .*--composer-layout\b/.test(step.run ?? ""))).toBe(true);
    const verifyArtifacts = (verifyJob!.steps ?? [])
      .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
      .map((step) => step.with?.name);
    const releaseSmokeArtifacts = (workflow("release.yml").jobs.smoke?.steps ?? [])
      .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
      .map((step) => step.with?.name);
    for (const name of verifyArtifacts) expect(releaseSmokeArtifacts).not.toContain(name);
  });

  it("run TypeScript lint in check.yml and Rust fmt + clippy across the workspace in windows.yml", () => {
    const checkSteps = workflow("check.yml").jobs.check!.steps ?? [];
    expect(checkSteps.some((step) => step.run === "pnpm lint")).toBe(true);

    const winSteps = workflow("windows.yml").jobs["windows-helper-and-integration"]!.steps ?? [];
    const runs = winSteps.map((step) => step.run ?? "").join("\n");
    expect(runs).toContain("cargo fmt --manifest-path apps/windows/Cargo.toml --all -- --check");
    expect(runs).toContain("cargo clippy --manifest-path apps/windows/Cargo.toml --workspace --all-targets --locked -- -D warnings");
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

  it("list review-stamp.yml, REVIEW.md, and every module the gate runs under the stamp paths, so a PR cannot loosen the gate unreviewed", () => {
    const runs = Object.values(workflow("review-stamp.yml").jobs).flatMap((job) => (job.steps ?? []).map((step) => step.run ?? ""));
    const scripts = runs.flatMap((run) => [...run.matchAll(/\bnode\s+(\S+\.ts)\b/gu)].map((m) => m[1]!));
    expect(scripts).toEqual(["scripts/review-stamp-gate.ts"]);
    const gateFiles = [".github/workflows/review-stamp.yml", "REVIEW.md", ...runtimeImportClosure(scripts)];
    const globs = parseStampPaths(readFileSync(join(REPO_ROOT, "REVIEW.md"), "utf8"));
    expect(gateFiles.filter((file) => matchStampPaths([file], globs).length === 0)).toEqual([]);
  });

  it("cover every OS-sandbox launch module in windows.yml path filters and REVIEW.md stamp paths", () => {
    const win = workflow("windows.yml");
    const prPaths = win.on.pull_request?.paths ?? [];
    const pushPaths = win.on.push?.paths ?? [];
    const stampGlobs = parseStampPaths(readFileSync(join(REPO_ROOT, "REVIEW.md"), "utf8"));
    expect(findUncoveredSandboxCallers(productionSrcFiles(), prPaths, pushPaths, stampGlobs)).toEqual([]);
  });

  it("flag uncovered sandbox scope builders, parenthesis-less callback forwarding, and aliased imports while ignoring type-only imports", () => {
    const win = workflow("windows.yml");
    const prPaths = win.on.pull_request?.paths ?? [];
    const pushPaths = win.on.push?.paths ?? [];
    const stampGlobs = parseStampPaths(readFileSync(join(REPO_ROOT, "REVIEW.md"), "utf8"));
    const synthetic = new Map<string, string>([
      ["src/daemon/driver/write-scope.ts", "export function wrapInReadonlyOsSandbox() {}"],
      [
        "src/daemon/jobs/type-only.ts",
        'import type { wrapInReadonlyOsSandbox } from "../driver/write-scope.ts"; import { type dataDirDenyList } from "../driver/write-scope.ts"; export type Wrap = typeof wrapInReadonlyOsSandbox; export type Deny = typeof dataDirDenyList;',
      ],
      [
        "src/daemon/jobs/launch.ts",
        "await prepareOsSandboxForLaunch(prep, platform); wrapInReadonlyOsSandbox(base, input, platform);",
      ],
      [
        "src/daemon/jobs/scope.ts",
        'import { workerWriteScope } from "../../shared/index.ts"; export const build = () => workerWriteScope;',
      ],
      [
        "src/daemon/jobs/forward.ts",
        'import { wrapInReadonlyOsSandbox } from "../driver/write-scope.ts"; export const wrap = (deps: { fn?: typeof wrapInReadonlyOsSandbox }) => deps.fn ?? wrapInReadonlyOsSandbox;',
      ],
      [
        "src/daemon/jobs/alias.ts",
        'import { wrapInReadonlyOsSandbox as wrap } from "../driver/write-scope.ts"; export const run = () => wrap;',
      ],
    ]);
    expect(findUncoveredSandboxCallers(synthetic, prPaths, pushPaths, stampGlobs)).toEqual([
      "windows.yml pull_request.paths missing src/daemon/jobs/launch.ts",
      "windows.yml push.paths missing src/daemon/jobs/launch.ts",
      "REVIEW.md stamp paths missing src/daemon/jobs/launch.ts",
      "windows.yml pull_request.paths missing src/daemon/jobs/scope.ts",
      "windows.yml push.paths missing src/daemon/jobs/scope.ts",
      "REVIEW.md stamp paths missing src/daemon/jobs/scope.ts",
      "windows.yml pull_request.paths missing src/daemon/jobs/forward.ts",
      "windows.yml push.paths missing src/daemon/jobs/forward.ts",
      "REVIEW.md stamp paths missing src/daemon/jobs/forward.ts",
      "windows.yml pull_request.paths missing src/daemon/jobs/alias.ts",
      "windows.yml push.paths missing src/daemon/jobs/alias.ts",
      "REVIEW.md stamp paths missing src/daemon/jobs/alias.ts",
    ]);
  });

  it("never let actions/setup-node cache a package manager that no earlier step in the job installed", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { packageManager?: string };
    expect(pkg.packageManager, "package.json must declare packageManager").toBeDefined();
    const installers = (step: Step) => step.uses?.startsWith("pnpm/action-setup@") || /\bcorepack enable\b/u.test(step.run ?? "");
    const offenders: string[] = [];
    for (const { name, wf } of WORKFLOWS) {
      for (const [jobName, job] of Object.entries(wf.jobs)) {
        const steps = job.steps ?? [];
        steps.forEach((step, index) => {
          if (!step.uses?.startsWith("actions/setup-node@")) return;
          const cacheOptOut = String(step.with?.["package-manager-cache"]) === "false" && step.with?.cache === undefined;
          if (!cacheOptOut && !steps.slice(0, index).some(installers)) offenders.push(`${name}#${jobName}`);
        });
      }
    }
    expect(offenders).toEqual([]);
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

  it("gate relay staging and production deploys with dry-runs, smoke checks, main-only checks, and GitHub Environments", () => {
    const wf = workflow("relay.yml");
    expect(wf.permissions).toEqual({ contents: "read" });
    const requiredPaths = ["src/relay/**", "src/shared/api.ts", "src/shared/limits.ts", "src/shared/mesh.ts", "wrangler.toml", "scripts/relay-smoke.ts"];
    for (const path of requiredPaths) {
      expect(wf.on.pull_request?.paths, `PR paths missing ${path}`).toContain(path);
      expect(wf.on.push?.paths, `push paths missing ${path}`).toContain(path);
    }

    const checkRuns = (wf.jobs.check!.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(checkRuns).toContain("vitest run --project=cloudflare");
    expect(checkRuns).toContain("wrangler deploy --env=\"\" --dry-run");
    expect(checkRuns).toContain("wrangler deploy --env staging --dry-run");

    const staging = wf.jobs["deploy-staging"]!;
    expect(needsOf(staging)).toEqual(["check"]);
    expect(typeof staging.environment === "object" ? staging.environment.name : staging.environment).toBe("staging");
    expect(staging.if).not.toContain("pull_request");
    expect(staging.if).toContain("github.event_name == 'push'");
    expect(staging.concurrency?.["cancel-in-progress"]).toBe(false);
    const stagingRuns = (staging.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(stagingRuns).toContain("wrangler deploy --env staging");
    expect(stagingRuns).toContain("node scripts/relay-smoke.ts");

    const prod = wf.jobs["deploy-production"]!;
    expect(needsOf(prod).sort()).toEqual(["check", "deploy-staging"]);
    expect(typeof prod.environment === "object" ? prod.environment.name : prod.environment).toBe("production");
    expect(prod.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(prod.if).toContain("inputs.target == 'deploy-production'");
    expect(prod.if).toContain("github.ref == 'refs/heads/main'");
    expect(prod.concurrency?.["cancel-in-progress"]).toBe(false);
    const prodRuns = (prod.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(prodRuns).toContain("wrangler deploy --env=\"\"");
    expect(prodRuns).toContain("node scripts/relay-smoke.ts");

    const rollback = wf.jobs["rollback-production"]!;
    expect(needsOf(rollback)).toEqual(["check"]);
    expect(typeof rollback.environment === "object" ? rollback.environment.name : rollback.environment).toBe("production");
    expect(rollback.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(rollback.if).toContain("inputs.target == 'rollback-production'");
    expect(rollback.if).toContain("github.ref == 'refs/heads/main'");
    expect(rollback.concurrency?.["cancel-in-progress"]).toBe(false);
    for (const step of rollback.steps ?? []) {
      expect(step.run ?? "").not.toMatch(/\$\{\{\s*inputs\./);
    }
    const rollbackRuns = (rollback.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(rollbackRuns).toContain("wrangler rollback");
    expect(rollbackRuns).toContain("node scripts/relay-smoke.ts");
  });

  it("configure production and isolated staging environments in wrangler.toml", () => {
    const toml = readFileSync(join(REPO_ROOT, "wrangler.toml"), "utf8");
    expect(toml).toMatch(/^name\s*=\s*"bellwood-relay"/m);
    expect(toml).toContain(`PUBLIC_ORIGIN = "${MESH_DEFAULT_RELAY_URL}"`);
    expect(toml).toMatch(/^\[env\.staging\]/m);
    expect(toml).toMatch(/name\s*=\s*"bellwood-relay-staging"/);
    expect(toml).toContain('PUBLIC_ORIGIN = "https://bellwood-relay-staging.bellwood-mesh.workers.dev"');
    expect(toml).toMatch(/^\[version_metadata\]\s*\nbinding\s*=\s*"VERSION_METADATA"/m);
    expect(toml).toMatch(/^\[env\.staging\.version_metadata\]\s*\nbinding\s*=\s*"VERSION_METADATA"/m);
    expect(toml).toMatch(/^\[\[env\.staging\.durable_objects\.bindings\]\]/m);
  });
});

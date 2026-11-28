// Release helper called by .github/workflows/release.yml (also runnable locally):
//   check   - verifies every version source agrees and CHANGELOG.md has notes for the version;
//   prepare - copies the Windows and Mac build outputs to fixed file names and rewrites their .sha256 files;
//   plan    - decides whether a tag builds a candidate or promotes one, and refuses everything else;
//   publish - publishes a candidate or promotes one, and only runs dry unless the workflow was started by pushing that tag;
//   yank    - takes a bad formal release off releases/latest so the previous one serves downloads and update checks again.
// Fixed names keep https://github.com/<repo>/releases/latest/download/<name> pointing at the newest formal release
// and match what the in-app update check looks for, so they never carry a version or an unsigned-preview suffix.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { UPDATE_RELEASE_REPO } from "../src/shared/limits.ts";
import { RELEASE_INSTALLER_FILES } from "../src/shared/update.ts";
import { publishRelease, readReleaseFacts, yankRelease, type ReleaseContext } from "./release-github.ts";
import { planRelease, releaseNotesFor, type ReleasePlan } from "./release-plan.ts";
import { REPO_ROOT, readDesktopAppVersion, sha256FileHex } from "./stage-runtime-common.ts";
import { validateRepoVerificationMatrix } from "./verification-matrix.ts";

export interface ReleaseAssetSpec {
  platform: "windows" | "macos";
  /** Raw file name uploaded by the build workflow; the version is capture group 1. */
  sourcePattern: RegExp;
  fixedName: string;
}

export const RELEASE_ASSETS: readonly ReleaseAssetSpec[] = [
  {
    platform: "windows",
    sourcePattern: /^Bellwood_(\d+\.\d+\.\d+)_x64-setup-unsigned-preview\.exe$/,
    fixedName: RELEASE_INSTALLER_FILES["windows-x64"],
  },
  {
    platform: "macos",
    sourcePattern: /^Bellwood_(\d+\.\d+\.\d+)_arm64(?:-unsigned-preview)?\.dmg$/,
    fixedName: RELEASE_INSTALLER_FILES["macos-arm64"],
  },
];

/** package.json, tauri.conf.json, and the supported X.Y.x series in SECURITY.md must match the Cargo workspace version. */
export function assertVersionSourcesMatch(repoRoot: string, appVersion: string): void {
  const sources = [
    { label: "package.json", path: join(repoRoot, "package.json") },
    { label: "tauri.conf.json", path: join(repoRoot, "apps", "windows", "crates", "fusa-desktop", "tauri.conf.json") },
  ];
  for (const { label, path } of sources) {
    const { version } = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
    if (version !== appVersion) {
      throw new Error(`${label} version ${version} does not match apps/windows/Cargo.toml version ${appVersion}`);
    }
  }
  const majorMinor = /^(\d+\.\d+)\.\d+$/.exec(appVersion)?.[1];
  if (!majorMinor) {
    throw new Error(`Invalid app version "${appVersion}"; expected X.Y.Z`);
  }
  const expectedSeries = `${majorMinor}.x`;
  const securityDoc = readFileSync(join(repoRoot, "SECURITY.md"), "utf8");
  const declaredSeries = Array.from(securityDoc.matchAll(/`(\d+\.\d+\.x)`/g), (m) => m[1]!);
  if (declaredSeries.length < 2) {
    throw new Error(`SECURITY.md must list supported version ${expectedSeries} in both English and Chinese sections`);
  }
  const mismatched = declaredSeries.find((series) => series !== expectedSeries);
  if (mismatched) {
    throw new Error(`SECURITY.md supported version ${mismatched} does not match package.json version ${appVersion} (expected ${expectedSeries})`);
  }
}

function findSingleSource(dir: string, spec: ReleaseAssetSpec): { fileName: string; version: string } {
  if (!existsSync(dir)) {
    throw new Error(`${spec.platform} artifact directory does not exist: ${dir}`);
  }
  const hits = readdirSync(dir).filter((name) => spec.sourcePattern.test(name));
  if (hits.length !== 1) {
    throw new Error(`${spec.platform} artifact directory ${dir} must hold exactly 1 file matching ${spec.sourcePattern}, found ${hits.length}: ${hits.join(", ")}`);
  }
  const fileName = hits[0]!;
  return { fileName, version: spec.sourcePattern.exec(fileName)![1]! };
}

/** Copies each artifact to its fixed name, verifies the original .sha256, and rewrites it for the new name. */
export function prepareReleaseAssets(opts: {
  dirs: Record<ReleaseAssetSpec["platform"], string>;
  outDir: string;
  appVersion: string;
}): string[] {
  mkdirSync(opts.outDir, { recursive: true });
  const written: string[] = [];
  for (const spec of RELEASE_ASSETS) {
    const dir = opts.dirs[spec.platform];
    const { fileName, version } = findSingleSource(dir, spec);
    if (version !== opts.appVersion) {
      throw new Error(`${spec.platform} artifact ${fileName} has version ${version}, which does not match app version ${opts.appVersion}`);
    }
    const sourcePath = join(dir, fileName);
    const actualHash = sha256FileHex(sourcePath);
    const recorded = readFileSync(`${sourcePath}.sha256`, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
    if (recorded !== actualHash) {
      throw new Error(`SHA-256 of ${fileName} does not match the .sha256 recorded at build time (recorded ${recorded}, actual ${actualHash})`);
    }
    copyFileSync(sourcePath, join(opts.outDir, spec.fixedName));
    writeFileSync(join(opts.outDir, `${spec.fixedName}.sha256`), `${actualHash}  ${spec.fixedName}\n`);
    written.push(spec.fixedName, `${spec.fixedName}.sha256`);
  }
  return written;
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(arg.slice(2), "true");
    } else {
      flags.set(arg.slice(2), next);
      i += 1;
    }
  }
  return flags;
}

function setGithubOutput(key: string, value: string): void {
  if (process.env["GITHUB_OUTPUT"]) {
    appendFileSync(process.env["GITHUB_OUTPUT"], `${key}=${value}\n`);
  }
}

/** Only a run started by pushing exactly this tag may write to GitHub; every other run of publish is a dry run. */
export function isTagPushOf(tag: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env["GITHUB_EVENT_NAME"] === "push" && env["GITHUB_REF_TYPE"] === "tag" && env["GITHUB_REF_NAME"] === tag;
}

export function composeReleaseNotes(changelog: string, downloads: string, version: string): string {
  return `${releaseNotesFor(changelog, version)}\n\n${downloads.trim()}\n`;
}

function readChangelog(): string {
  return readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
}

function releaseContext(dryRun: boolean): ReleaseContext {
  return {
    repo: process.env["GITHUB_REPOSITORY"] || UPDATE_RELEASE_REPO,
    dryRun,
    log: (line) => console.log(line),
    run: (file, args) =>
      execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 }),
  };
}

function assertVerificationMatrixValid(repoRoot: string, appVersion: string): void {
  const problems = validateRepoVerificationMatrix(repoRoot, appVersion);
  if (problems.length > 0) {
    throw new Error(
      `Verification matrix check failed:\n${problems.map((p) => `- [${p.code}] ${p.path}: ${p.message}`).join("\n")}`,
    );
  }
}

function planTag(tag: string, ctx: ReleaseContext): ReleasePlan {
  const appVersion = readDesktopAppVersion();
  assertVersionSourcesMatch(REPO_ROOT, appVersion);
  assertVerificationMatrixValid(REPO_ROOT, appVersion);
  const facts = readReleaseFacts(tag, appVersion, ctx);
  const plan = planRelease(facts, { dryRun: ctx.dryRun });
  if (!ctx.dryRun && facts.commit !== process.env["GITHUB_SHA"]) {
    throw new Error(`${tag} now points at ${facts.commit}, but this run built ${process.env["GITHUB_SHA"]}`);
  }
  if (!facts.onMain) console.log(`::warning::Dry run: ${facts.commit} is not on main, so pushing ${tag} there would be refused`);
  releaseNotesFor(readChangelog(), plan.version);
  return plan;
}

function runPlan(flags: Map<string, string>): void {
  const tag = requireFlag(flags, "tag");
  const ctx = releaseContext(!isTagPushOf(tag));
  const plan = planTag(tag, ctx);
  console.log(`plan: ${JSON.stringify(plan)}${ctx.dryRun ? " (dry run: nothing will publish)" : ""}`);
  setGithubOutput("mode", plan.mode);
  setGithubOutput("version", plan.version);
  setGithubOutput("from-tag", plan.mode === "promote" ? plan.fromTag : "");
}

function runPublish(flags: Map<string, string>): void {
  const tag = requireFlag(flags, "tag");
  const ctx = releaseContext(!isTagPushOf(tag));
  const plan = planTag(tag, ctx);
  const expected = requireFlag(flags, "expect-mode");
  if (plan.mode !== expected) throw new Error(`${tag} now plans a ${plan.mode}, but this job publishes a ${expected}`);
  const notesDir = mkdtempSync(join(process.env["RUNNER_TEMP"] ?? tmpdir(), "release-notes-"));
  try {
    const notesFile = join(notesDir, "notes.md");
    const downloads = readFileSync(join(REPO_ROOT, ".github", "release-downloads.md"), "utf8");
    writeFileSync(notesFile, composeReleaseNotes(readChangelog(), downloads, plan.version));
    publishRelease(plan, { assetsDir: resolve(requireFlag(flags, "assets-dir")), notesFile }, ctx);
  } finally {
    rmSync(notesDir, { recursive: true, force: true });
  }
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

const USAGE = [
  "Usage: release-assets.ts check",
  "  | prepare --windows-dir D --mac-dir D --out-dir D",
  "  | plan --tag vX.Y.Z[-rc.N]",
  "  | publish --tag vX.Y.Z[-rc.N] --expect-mode build|promote --assets-dir D",
  "  | yank --tag vX.Y.Z [--dry-run]",
].join("\n");

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (command === "check") {
    const appVersion = readDesktopAppVersion();
    assertVersionSourcesMatch(REPO_ROOT, appVersion);
    releaseNotesFor(readChangelog(), appVersion);
    assertVerificationMatrixValid(REPO_ROOT, appVersion);
    console.log(`version=${appVersion}: version sources, CHANGELOG.md, and verification matrix agree`);
    setGithubOutput("version", appVersion);
    return;
  }
  if (command === "prepare") {
    const written = prepareReleaseAssets({
      dirs: { windows: resolve(flags.get("windows-dir") ?? ""), macos: resolve(flags.get("mac-dir") ?? "") },
      outDir: resolve(flags.get("out-dir") ?? ""),
      appVersion: readDesktopAppVersion(),
    });
    console.log(`prepared: ${written.join(", ")}`);
    return;
  }
  if (command === "plan") return runPlan(flags);
  if (command === "publish") return runPublish(flags);
  if (command === "yank") {
    yankRelease(requireFlag(flags, "tag"), releaseContext(flags.has("dry-run")));
    return;
  }
  throw new Error(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

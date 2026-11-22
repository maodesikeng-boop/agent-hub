// Reads release facts from git and GitHub, and carries out release plans with the gh CLI.
// Invariant: with dryRun set, nothing writes to GitHub; each command that would write is logged instead.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, parseVersion } from "../src/shared/update.ts";
import { REQUIRED_RELEASE_ASSETS, type ExistingRelease, type ReleaseFacts, type ReleasePlan } from "./release-plan.ts";
import { sha256FileHex } from "./stage-runtime-common.ts";

/** Runs a command and returns its stdout. Throws when the command exits non-zero. */
export type CommandRunner = (file: string, args: readonly string[]) => string;

export interface ReleaseContext {
  /** owner/name of the GitHub repository. */
  repo: string;
  run: CommandRunner;
  dryRun: boolean;
  log: (line: string) => void;
}

interface ListedRelease {
  tag: string;
  draft: boolean;
  prerelease: boolean;
  assets: string[];
}

function formatCommand(file: string, args: readonly string[]): string {
  return [file, ...args].map((arg) => (/[\s"'$]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

function write(ctx: ReleaseContext, file: string, args: readonly string[]): void {
  if (ctx.dryRun) {
    ctx.log(`[dry-run] ${formatCommand(file, args)}`);
    return;
  }
  ctx.log(`$ ${formatCommand(file, args)}`);
  ctx.run(file, args);
}

function listReleases(ctx: ReleaseContext): ListedRelease[] {
  const out = ctx.run("gh", [
    "api",
    "--paginate",
    `repos/${ctx.repo}/releases?per_page=100`,
    "--jq",
    ".[] | {tag: .tag_name, draft, prerelease, assets: [.assets[].name]} | @json",
  ]);
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ListedRelease);
}

/** Peeled commit of every remote tag; annotated tags report their target commit on the `^{}` line. */
function remoteTagCommits(ctx: ReleaseContext): Map<string, string> {
  const commits = new Map<string, string>();
  for (const line of ctx.run("git", ["ls-remote", "--tags", "origin"]).split("\n")) {
    const match = /^([0-9a-f]{40})\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (!match) continue;
    if (match[3] || !commits.has(match[2]!)) commits.set(match[2]!, match[1]!);
  }
  return commits;
}

function isOnMain(commit: string, ctx: ReleaseContext): boolean {
  ctx.run("git", ["rev-parse", "--verify", "--quiet", "origin/main"]);
  try {
    ctx.run("git", ["merge-base", "--is-ancestor", commit, "origin/main"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Postcondition: returns the facts planRelease needs for tag. Reads every release of repo, drafts included, and checks
 * whether origin/main contains the tag commit. When a dry run rehearses a tag that does not exist yet, uses HEAD.
 * Throws when a real publish finds no remote tag, such as one deleted while the gates ran.
 */
export function readReleaseFacts(tag: string, appVersion: string, ctx: ReleaseContext): ReleaseFacts {
  const tagCommits = remoteTagCommits(ctx);
  const tagged = tagCommits.get(tag);
  if (tagged === undefined && !ctx.dryRun) throw new Error(`Tag ${tag} does not exist on origin`);
  const commit = tagged ?? ctx.run("git", ["rev-parse", "HEAD"]).trim();
  const releases: ExistingRelease[] = listReleases(ctx).map((release) => ({
    ...release,
    commit: tagCommits.get(release.tag) ?? "",
  }));
  return { tag, commit, appVersion, onMain: isOnMain(commit, ctx), releases };
}

function assertChecksums(assetsDir: string): void {
  for (const name of REQUIRED_RELEASE_ASSETS.filter((asset) => !asset.endsWith(".sha256"))) {
    const file = join(assetsDir, name);
    if (!existsSync(file) || !existsSync(`${file}.sha256`)) throw new Error(`${assetsDir} lacks ${name} or ${name}.sha256`);
    const recorded = readFileSync(`${file}.sha256`, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
    const actual = sha256FileHex(file);
    if (recorded !== actual) throw new Error(`SHA-256 of ${name} is ${actual}, but ${name}.sha256 records ${recorded}`);
  }
}

function downloadAndVerifyCandidate(fromTag: string, commit: string, assetsDir: string, ctx: ReleaseContext): void {
  mkdirSync(assetsDir, { recursive: true });
  const patterns = REQUIRED_RELEASE_ASSETS.flatMap((name) => ["--pattern", name]);
  ctx.run("gh", ["release", "download", fromTag, "--repo", ctx.repo, "--dir", assetsDir, ...patterns]);
  assertChecksums(assetsDir);
  for (const name of REQUIRED_RELEASE_ASSETS.filter((asset) => !asset.endsWith(".sha256"))) {
    ctx.run("gh", [
      "attestation",
      "verify",
      join(assetsDir, name),
      "--repo",
      ctx.repo,
      "--signer-workflow",
      `${ctx.repo}/.github/workflows/release.yml`,
      "--source-ref",
      `refs/tags/${fromTag}`,
      // The ref alone would accept installers attested before fromTag was moved to another commit.
      "--source-digest",
      commit,
    ]);
    ctx.log(`verified ${name}: SHA-256 and build provenance from ${fromTag} at ${commit}`);
  }
}

/**
 * Precondition: plan came from planRelease for the same tag. For a build plan, assetsDir holds every REQUIRED_RELEASE_ASSETS file.
 * Postcondition: for a promote plan, first downloads fromTag's assets into assetsDir and checks each .sha256 and the
 * build provenance attestation signed by release.yml for fromTag at plan.commit. Then creates the release as a draft,
 * uploads every asset, and publishes it, as a prerelease for a build plan and as latest for a promote plan.
 * Never uploads to, edits, or deletes an existing release. Throws on the first failed check, before anything is published.
 */
export function publishRelease(plan: ReleasePlan, opts: { assetsDir: string; notesFile: string }, ctx: ReleaseContext): void {
  if (plan.mode === "promote") downloadAndVerifyCandidate(plan.fromTag, plan.commit, opts.assetsDir, ctx);
  else assertChecksums(opts.assetsDir);
  const files = REQUIRED_RELEASE_ASSETS.map((name) => join(opts.assetsDir, name));
  const kind = plan.mode === "build" ? ["--prerelease"] : [];
  write(ctx, "gh", [
    "release",
    "create",
    plan.tag,
    "--repo",
    ctx.repo,
    "--draft",
    "--verify-tag",
    "--title",
    `Bellwood ${plan.tag} (unsigned preview)`,
    "--notes-file",
    opts.notesFile,
    ...kind,
    ...files,
  ]);
  write(ctx, "gh", ["release", "edit", plan.tag, "--repo", ctx.repo, "--draft=false", ...(plan.mode === "build" ? [] : ["--latest"])]);
}

/**
 * Precondition: tag is a published formal release, and at least one other published formal release exists.
 * Postcondition: marks tag as a prerelease that is not latest, marks the highest remaining formal release as latest, and
 * confirms that the releases/latest API now returns that release. Leaves every asset and tag unchanged.
 * Returns the tag that is latest afterwards. Throws when no other formal release exists or the confirmation fails.
 */
export function yankRelease(tag: string, ctx: ReleaseContext): string {
  const releases = listReleases(ctx);
  const formal = (release: ListedRelease) =>
    !release.draft && !release.prerelease && release.tag.startsWith("v") && parseVersion(release.tag.slice(1)) !== null;
  const target = releases.find((release) => release.tag === tag);
  if (!target || !formal(target)) throw new Error(`${tag} is not a published formal release`);
  const previous = releases
    .filter((release) => release.tag !== tag && formal(release))
    .sort((a, b) => compareVersions(parseVersion(b.tag.slice(1))!, parseVersion(a.tag.slice(1))!))[0];
  if (!previous) throw new Error(`No other published formal release exists to fall back to from ${tag}`);

  write(ctx, "gh", ["release", "edit", tag, "--repo", ctx.repo, "--prerelease", "--latest=false"]);
  write(ctx, "gh", ["release", "edit", previous.tag, "--repo", ctx.repo, "--latest"]);
  if (ctx.dryRun) {
    ctx.log(`[dry-run] would confirm that repos/${ctx.repo}/releases/latest returns ${previous.tag}`);
    return previous.tag;
  }
  const latest = ctx.run("gh", ["api", `repos/${ctx.repo}/releases/latest`, "--jq", ".tag_name"]).trim();
  if (latest !== previous.tag) throw new Error(`releases/latest returns ${latest}, expected ${previous.tag} after yanking ${tag}`);
  ctx.log(`yanked ${tag}; releases/latest now returns ${latest}`);
  return latest;
}

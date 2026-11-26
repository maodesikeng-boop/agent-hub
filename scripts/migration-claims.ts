import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { GhRunOptions, GhRunResult } from "../src/daemon/git/gh.ts";
import { PR_FILES_API_MAX } from "./review-stamp-gate.ts";

/** One page of the open-PR list; more open PRs than this fails the check closed instead of skipping some. */
export const MIGRATION_CLAIMS_MAX_OPEN_PRS = 100;

/** Matches a migration path in a PR file list and captures its version. */
export const MIGRATION_PATH = /^migrations\/(\d+)_[^/\\\s]+\.sql$/u;

export interface MigrationClaim {
  pr: number;
  version: number;
  file: string;
}

export interface OpenPrMigrations {
  pr: number;
  files: readonly string[];
  /** True when GitHub stopped listing files at its cap, so the claim list may be incomplete. */
  filesTruncated: boolean;
}

export type MigrationClaimConflict =
  | { kind: "on-main"; version: number; file: string; mainLatest: number }
  | { kind: "claimed"; version: number; file: string; otherPr: number; otherFile: string };

export type ClaimCheckResult =
  | { kind: "ok"; claims: MigrationClaim[] }
  | { kind: "conflict"; conflicts: MigrationClaimConflict[]; next: number }
  | { kind: "incomplete"; reason: string };

export interface ClaimCheckInput {
  pr: number;
  files: readonly string[];
  filesTruncated: boolean;
  /** Text of migrations/manifest.sha256 on the current main, not on the PR's merge base. */
  mainManifest: string;
  openPrs: readonly OpenPrMigrations[];
  openPrsTruncated: boolean;
}

/**
 * Postcondition: returns one claim per path in files that matches MIGRATION_PATH, in input order; other paths,
 * including migrations/manifest.sha256, are ignored.
 */
export function migrationClaimsOf(pr: number, files: readonly string[]): MigrationClaim[] {
  return files.flatMap((file) => {
    const version = Number(MIGRATION_PATH.exec(file)?.[1]);
    return Number.isSafeInteger(version) ? [{ pr, version, file }] : [];
  });
}

/**
 * Postcondition: returns the highest version listed in the manifest, or 0 for an empty manifest.
 * Throws an error naming the line number (`line N`) when a non-empty line is not `<sha256>  <version>_<name>.sql`, so a broken manifest fails the check.
 */
export function latestManifestVersion(manifest: string): number {
  let latest = 0;
  for (const [index, line] of manifest.split(/\r?\n/u).entries()) {
    if (line.trim() === "") continue;
    const version = /^[0-9a-f]{64}  (\d+)_[^/\\\s]+\.sql$/u.exec(line)?.[1];
    const number = Number(version);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid migration manifest line ${index + 1}`);
    latest = Math.max(latest, number);
  }
  return latest;
}

/**
 * Postcondition: returns the smallest version above mainLatest that no claim in taken uses.
 */
export function nextFreeVersion(mainLatest: number, taken: readonly MigrationClaim[]): number {
  const occupied = new Set(taken.map(({ version }) => version));
  let next = mainLatest + 1;
  while (occupied.has(next)) next++;
  if (!Number.isSafeInteger(next)) throw new Error("Migration version exceeds the safe integer range");
  return next;
}

/**
 * Decides whether the PR in input may keep the migration numbers it adds.
 * - A version at or below main's latest is an `on-main` conflict.
 * - A version that an open PR with a lower number also adds is a `claimed` conflict; a higher-numbered PR never blocks this one.
 * - The PR's own entry in openPrs is ignored.
 * - A truncated file list for this PR or any open PR, or a truncated open-PR list, returns `incomplete`.
 * Postcondition: on `conflict`, next excludes versions on main, in this PR, and in other open PRs.
 */
export function checkMigrationClaims(input: ClaimCheckInput): ClaimCheckResult {
  if (input.filesTruncated) return { kind: "incomplete", reason: `PR #${input.pr} reached GitHub's ${PR_FILES_API_MAX}-file limit` };
  if (input.openPrsTruncated) return { kind: "incomplete", reason: `Open PR list reached the ${MIGRATION_CLAIMS_MAX_OPEN_PRS}-PR limit` };
  const truncated = input.openPrs.find((item) => item.filesTruncated);
  if (truncated) return { kind: "incomplete", reason: `PR #${truncated.pr} reached GitHub's ${PR_FILES_API_MAX}-file limit` };

  const mainLatest = latestManifestVersion(input.mainManifest);
  const claims = migrationClaimsOf(input.pr, input.files);
  const others = input.openPrs
    .filter(({ pr }) => pr !== input.pr)
    .flatMap(({ pr, files }) => migrationClaimsOf(pr, files));
  const firstClaimByVersion = new Map<number, MigrationClaim>();
  for (const claim of others) {
    const first = firstClaimByVersion.get(claim.version);
    if (first === undefined || claim.pr < first.pr) firstClaimByVersion.set(claim.version, claim);
  }
  const conflicts: MigrationClaimConflict[] = [];
  for (const { version, file } of claims) {
    const other = firstClaimByVersion.get(version);
    if (version <= mainLatest) conflicts.push({ kind: "on-main", version, file, mainLatest });
    else if (other && other.pr < input.pr) conflicts.push({ kind: "claimed", version, file, otherPr: other.pr, otherFile: other.file });
  }
  return conflicts.length === 0 ? { kind: "ok", claims } : { kind: "conflict", conflicts, next: nextFreeVersion(mainLatest, [...others, ...claims]) };
}

/** Postcondition: returns report lines that name each conflicting file, the other PR or main, and the number to take. */
export function formatClaimReport(pr: number, result: ClaimCheckResult): string[] {
  switch (result.kind) {
    case "ok":
      return [`PR #${pr}: no migration claim conflicts.`];
    case "incomplete":
      return [`PR #${pr}: could not check migration claims: ${result.reason}.`];
    case "conflict":
      return [...result.conflicts.map(formatClaimConflict), `Next free migration number: ${formatVersion(result.next)}.`];
  }
}

export function formatClaimConflict(conflict: MigrationClaimConflict): string {
  const number = formatVersion(conflict.version);
  return conflict.kind === "on-main"
    ? `${conflict.file}: ${number} is already on main (latest: ${formatVersion(conflict.mainLatest)}).`
    : `${conflict.file}: ${number} is also added by open PR #${conflict.otherPr} (${conflict.otherFile}).`;
}

function formatVersion(version: number): string {
  return String(version).padStart(4, "0");
}

export interface MigrationClaimsDeps {
  execGh: (cwd: string, args: readonly string[], options: GhRunOptions) => Promise<GhRunResult>;
  cwd: string;
  log: (line: string) => void;
}

const GH_TIMEOUT_MS = 30_000;

interface ClaimsSource {
  deps: MigrationClaimsDeps;
  repo: string;
}

async function ghApi(source: ClaimsSource, path: string, args: readonly string[] = []): Promise<string> {
  const result = await source.deps.execGh(source.deps.cwd, ["api", `repos/${source.repo}/${path}`, ...args], { timeoutMs: GH_TIMEOUT_MS });
  if (result.kind === "ok") return result.stdout;
  throw new Error(result.stderr.trim() || `gh api ${path} failed (${result.timedOut ? "timed out" : String(result.code)})`);
}

function validPrNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function readPrFiles(source: ClaimsSource, pr: number, claimsOnly = false): Promise<OpenPrMigrations> {
  const stdout = await ghApi(source, `pulls/${pr}/files?per_page=100`, ["--paginate", "--jq", ".[] | [ .status, .filename, .previous_filename ] | @json"]);
  const lines = stdout.trimEnd().split(/\r?\n/u).filter(Boolean);
  const files: string[] = [];
  for (const line of lines) {
    const row: unknown = JSON.parse(line);
    if (!Array.isArray(row) || row.length !== 3 || typeof row[0] !== "string" || typeof row[1] !== "string" ||
      (row[2] !== null && typeof row[2] !== "string")) throw new Error(`Invalid file list for PR #${pr}`);
    if (!claimsOnly || row[0] === "added" || row[0] === "renamed") {
      if (MIGRATION_PATH.test(row[1])) files.push(row[1]);
    }
    if (!claimsOnly && typeof row[2] === "string" && MIGRATION_PATH.test(row[2])) files.push(row[2]);
  }
  return { pr, files, filesTruncated: lines.length >= PR_FILES_API_MAX };
}

async function readOpenPrs(source: ClaimsSource, except: number | null): Promise<{ prs: OpenPrMigrations[]; truncated: boolean }> {
  const stdout = await ghApi(source, `pulls?state=open&base=main&per_page=${MIGRATION_CLAIMS_MAX_OPEN_PRS}`, ["--jq", "map(.number)"]);
  const numbers: unknown = JSON.parse(stdout);
  if (!Array.isArray(numbers) || !numbers.every(validPrNumber)) throw new Error("Invalid open PR list");
  if (numbers.length >= MIGRATION_CLAIMS_MAX_OPEN_PRS) return { prs: [], truncated: true };

  const candidates = numbers.filter((number) => number !== except);
  const prs: OpenPrMigrations[] = [];
  for (let offset = 0; offset < candidates.length; offset += 5) {
    prs.push(...await Promise.all(candidates.slice(offset, offset + 5).map((pr) => readPrFiles(source, pr, true))));
  }
  return { prs, truncated: false };
}

function readMainManifest(source: ClaimsSource): Promise<string> {
  return ghApi(source, "contents/migrations/manifest.sha256?ref=main", ["--header", "Accept: application/vnd.github.raw+json"]);
}

export async function verifyMigrationClaims(
  pr: number, deps: MigrationClaimsDeps, options: { repo?: string; expectedHead?: string } = {},
): Promise<ClaimCheckResult> {
  const source = { deps, repo: options.repo ?? "{owner}/{repo}" };
  try {
    const target = await readPrFiles(source, pr);
    if (target.filesTruncated) return { kind: "incomplete", reason: `GitHub's ${PR_FILES_API_MAX}-file limit was reached` };
    let result: ClaimCheckResult = { kind: "ok", claims: [] };
    if (target.files.length > 0) {
      const [mainManifest, open] = await Promise.all([readMainManifest(source), readOpenPrs(source, pr)]);
      result = checkMigrationClaims({ ...target, mainManifest, openPrs: open.prs, openPrsTruncated: open.truncated });
    }
    if (options.expectedHead !== undefined) {
      const current = await ghApi(source, `pulls/${pr}`, ["--jq", '[.state, .base.ref, .head.sha] | @tsv']);
      if (current.trim() !== `open\tmain\t${options.expectedHead}`) return { kind: "incomplete", reason: "The PR changed while its claims were checked" };
    }
    return result;
  } catch (error) {
    return { kind: "incomplete", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Prints the next free migration number or checks one PR, returning 1 if it cannot verify the result. */
export async function main(argv: readonly string[], deps: MigrationClaimsDeps): Promise<number> {
  if (argv[0] === "--pr" && argv.length === 2 && /^[1-9]\d*$/u.test(argv[1] ?? "") && validPrNumber(Number(argv[1]))) {
    const pr = Number(argv[1]);
    const result = await verifyMigrationClaims(pr, deps);
    for (const line of formatClaimReport(pr, result)) deps.log(line);
    return result.kind === "ok" ? 0 : 1;
  }
  if (argv[0] !== "--next" || argv.length !== 1) {
    deps.log("Usage: node scripts/migration-claims.ts --next | --pr <N>");
    return 1;
  }
  const source = { deps, repo: "{owner}/{repo}" };
  try {
    const [manifest, open] = await Promise.all([readMainManifest(source), readOpenPrs(source, null)]);
    if (open.truncated) throw new Error(`Open PR list reached the ${MIGRATION_CLAIMS_MAX_OPEN_PRS}-PR limit`);
    const truncated = open.prs.find(({ filesTruncated }) => filesTruncated);
    if (truncated) throw new Error(`PR #${truncated.pr} reached GitHub's ${PR_FILES_API_MAX}-file limit`);
    const claims = open.prs.flatMap(({ pr, files }) => migrationClaimsOf(pr, files));
    deps.log(formatVersion(nextFreeVersion(latestManifestVersion(manifest), claims)));
    return 0;
  } catch (error) {
    deps.log(`Could not choose a migration number: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { execGh } = await import("../src/daemon/git/gh.ts");
  process.exitCode = await main(process.argv.slice(2), { execGh, cwd: process.cwd(), log: (line) => console.log(line) });
}

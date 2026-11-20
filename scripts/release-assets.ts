// Release helper called by .github/workflows/release.yml (also runnable locally):
//   check   - verifies every version source agrees with the git tag and prints version / prerelease;
//   prepare - copies the Windows and Mac build outputs to fixed file names and rewrites their .sha256 files.
// Fixed names keep https://github.com/<repo>/releases/latest/download/<name> pointing at the newest formal release
// and match what the in-app update check looks for, so they never carry a version or an unsigned-preview suffix.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RELEASE_INSTALLER_FILES } from "../src/shared/update.ts";
import { REPO_ROOT, readDesktopAppVersion, sha256FileHex } from "./stage-runtime-common.ts";

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

const TAG_PATTERN = /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/;

export interface TagCheckResult {
  version: string;
  /** A suffixed tag such as -rc.1 is a prerelease, which GitHub excludes from releases/latest. */
  prerelease: boolean;
}

/** The X.Y.Z of tag vX.Y.Z[-suffix] must equal the app version shared by the Windows NSIS and Mac DMG builds. */
export function checkTagVersion(tag: string, appVersion: string): TagCheckResult {
  const match = TAG_PATTERN.exec(tag);
  if (!match) {
    throw new Error(`Tag "${tag}" is not vX.Y.Z or vX.Y.Z-suffix`);
  }
  if (match[1] !== appVersion) {
    throw new Error(`Tag ${tag} does not match app version ${appVersion} in apps/windows/Cargo.toml; bump the version before tagging`);
  }
  return { version: appVersion, prerelease: match[2] !== undefined };
}

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
    if (arg.startsWith("--")) {
      flags.set(arg.slice(2), argv[i + 1] ?? "");
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

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const appVersion = readDesktopAppVersion();
  assertVersionSourcesMatch(REPO_ROOT, appVersion);
  if (command === "check") {
    // Without --tag this is a dry run that only confirms the version sources agree.
    const tag = flags.get("tag");
    const result = tag ? checkTagVersion(tag, appVersion) : { version: appVersion, prerelease: false };
    console.log(`version=${result.version} prerelease=${result.prerelease}${tag ? ` tag=${tag}` : " (dry-run, no tag)"}`);
    setGithubOutput("version", result.version);
    setGithubOutput("prerelease", String(result.prerelease));
    return;
  }
  if (command === "prepare") {
    const written = prepareReleaseAssets({
      dirs: { windows: resolve(flags.get("windows-dir") ?? ""), macos: resolve(flags.get("mac-dir") ?? "") },
      outDir: resolve(flags.get("out-dir") ?? ""),
      appVersion,
    });
    console.log(`prepared: ${written.join(", ")}`);
    return;
  }
  throw new Error("Usage: release-assets.ts check [--tag vX.Y.Z] | prepare --windows-dir D --mac-dir D --out-dir D");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

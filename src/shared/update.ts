import { UPDATE_RELEASE_REPO } from "./limits.ts";

export type InstallKind = "bundled" | "source";
export type PlatformTarget = "macos-arm64" | "windows-x64" | "other";
export type InstallerTarget = Exclude<PlatformTarget, "other">;

export const RELEASE_INSTALLER_FILES: Readonly<Record<InstallerTarget, string>> = {
  "macos-arm64": "Bellwood-macos-arm64.dmg",
  "windows-x64": "Bellwood-windows-x64-setup.exe",
};

export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_RELEASE_REPO}/releases`;
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${UPDATE_RELEASE_REPO}/releases/latest`;

export interface UpdateInstaller {
  fileName: string;
  downloadUrl: string;
  sha256Url: string;
}

export interface UpdateBase {
  currentVersion: string;
  installKind: InstallKind;
  platformTarget: PlatformTarget;
  releaseUrl: string;
  checkedAt: number;
}

export interface UpdateAvailable extends UpdateBase {
  status: "update_available";
  latestVersion: string;
  tagName: string;
  publishedAt: string | null;
  installer: UpdateInstaller | null;
}

export type UpdateStatus = (UpdateBase & { status: "up_to_date" | "unavailable" }) | UpdateAvailable;

export interface LatestRelease {
  tagName: string;
  htmlUrl: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
  assets: readonly { name: string; url: string }[];
}

export interface ReleaseVersion {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(text: string): ReleaseVersion | null {
  const match = VERSION_CORE.exec(text);
  if (match === null) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  return [major, minor, patch].every(Number.isSafeInteger) ? { major, minor, patch } : null;
}

export function compareVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function formalReleaseVersion(release: Pick<LatestRelease, "tagName" | "draft" | "prerelease">): string | null {
  if (release.draft || release.prerelease || !release.tagName.startsWith("v")) return null;
  const version = release.tagName.slice(1);
  return parseVersion(version) === null ? null : version;
}

export function platformTargetOf(platform: string, arch: string): PlatformTarget {
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  return "other";
}

export function installerOf(assets: LatestRelease["assets"], target: PlatformTarget): UpdateInstaller | null {
  if (target === "other") return null;
  const fileName = RELEASE_INSTALLER_FILES[target];
  const download = assets.find((asset) => asset.name === fileName);
  const sha256 = assets.find((asset) => asset.name === `${fileName}.sha256`);
  return download === undefined || sha256 === undefined ? null : { fileName, downloadUrl: download.url, sha256Url: sha256.url };
}

export function evaluateRelease(base: UpdateBase, release: LatestRelease): UpdateStatus {
  const latest = formalReleaseVersion(release);
  const current = parseVersion(base.currentVersion);
  if (latest === null || current === null) return { ...base, status: "unavailable" };
  if (compareVersions(parseVersion(latest)!, current) <= 0) return { ...base, status: "up_to_date", releaseUrl: release.htmlUrl };
  return {
    ...base,
    status: "update_available",
    releaseUrl: release.htmlUrl,
    latestVersion: latest,
    tagName: release.tagName,
    publishedAt: release.publishedAt,
    installer: installerOf(release.assets, base.platformTarget),
  };
}

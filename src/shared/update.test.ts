import { describe, expect, it } from "vitest";
import {
  RELEASE_INSTALLER_FILES,
  compareVersions,
  evaluateRelease,
  formalReleaseVersion,
  installerOf,
  parseVersion,
  platformTargetOf,
  type LatestRelease,
  type UpdateBase,
} from "./index.ts";

const DOWNLOAD = "https://github.com/maodesikeng-boop/agent-hub/releases/download/v0.3.0";

function release(overrides: Partial<LatestRelease> = {}): LatestRelease {
  const assets = Object.values(RELEASE_INSTALLER_FILES).flatMap((name) => [
    { name, url: `${DOWNLOAD}/${name}` },
    { name: `${name}.sha256`, url: `${DOWNLOAD}/${name}.sha256` },
  ]);
  return {
    tagName: "v0.3.0",
    htmlUrl: "https://github.com/maodesikeng-boop/agent-hub/releases/tag/v0.3.0",
    draft: false,
    prerelease: false,
    publishedAt: "2026-11-20T08:00:00Z",
    assets,
    ...overrides,
  };
}

const base: UpdateBase = {
  currentVersion: "0.2.0",
  installKind: "bundled",
  platformTarget: "macos-arm64",
  releaseUrl: "https://github.com/maodesikeng-boop/agent-hub/releases",
  checkedAt: 1_000,
};

describe("release versions", () => {
  it("parses only plain X.Y.Z cores and compares them numerically", () => {
    expect(parseVersion("0.10.2")).toEqual({ major: 0, minor: 10, patch: 2 });
    for (const bad of ["v0.2.0", "0.2", "0.2.0-rc.1", "01.2.3", "1.2.3.4", "", "99999999999999999999.0.0"]) {
      expect(parseVersion(bad), bad).toBeNull();
    }
    const v = (text: string) => parseVersion(text)!;
    expect(compareVersions(v("0.10.0"), v("0.9.9"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.0.0"), v("1.0.0"))).toBe(0);
    expect(compareVersions(v("1.2.3"), v("1.3.0"))).toBeLessThan(0);
  });

  it("counts only non-draft, non-prerelease vX.Y.Z tags as formal releases", () => {
    expect(formalReleaseVersion({ tagName: "v0.3.0", draft: false, prerelease: false })).toBe("0.3.0");
    expect(formalReleaseVersion({ tagName: "v0.3.0", draft: true, prerelease: false })).toBeNull();
    expect(formalReleaseVersion({ tagName: "v0.3.0", draft: false, prerelease: true })).toBeNull();
    expect(formalReleaseVersion({ tagName: "v0.3.0-rc.1", draft: false, prerelease: false })).toBeNull();
    expect(formalReleaseVersion({ tagName: "0.3.0", draft: false, prerelease: false })).toBeNull();
  });

  it("maps only Apple silicon macOS and x64 Windows to installers", () => {
    expect(platformTargetOf("darwin", "arm64")).toBe("macos-arm64");
    expect(platformTargetOf("win32", "x64")).toBe("windows-x64");
    expect(platformTargetOf("darwin", "x64")).toBe("other");
    expect(platformTargetOf("win32", "arm64")).toBe("other");
    expect(platformTargetOf("linux", "x64")).toBe("other");
  });
});

describe("evaluateRelease", () => {
  it("offers the matching installer and its checksum when a newer formal release exists", () => {
    expect(evaluateRelease(base, release())).toEqual({
      ...base,
      status: "update_available",
      releaseUrl: release().htmlUrl,
      latestVersion: "0.3.0",
      tagName: "v0.3.0",
      publishedAt: "2026-11-20T08:00:00Z",
      installer: {
        fileName: "Bellwood-macos-arm64.dmg",
        downloadUrl: `${DOWNLOAD}/Bellwood-macos-arm64.dmg`,
        sha256Url: `${DOWNLOAD}/Bellwood-macos-arm64.dmg.sha256`,
      },
    });
    const windows = evaluateRelease({ ...base, platformTarget: "windows-x64" }, release());
    expect(windows.status === "update_available" && windows.installer?.fileName).toBe("Bellwood-windows-x64-setup.exe");
  });

  it("has no installer for other platforms or when the release lacks the file or its checksum", () => {
    const other = evaluateRelease({ ...base, platformTarget: "other" }, release());
    expect(other.status === "update_available" && other.installer).toBeNull();
    const noChecksum = release().assets.filter((asset) => asset.name !== "Bellwood-macos-arm64.dmg.sha256");
    expect(installerOf(noChecksum, "macos-arm64")).toBeNull();
  });

  it("reports up to date when the latest release is the same or older", () => {
    expect(evaluateRelease({ ...base, currentVersion: "0.3.0" }, release())).toMatchObject({ status: "up_to_date", releaseUrl: release().htmlUrl });
    expect(evaluateRelease({ ...base, currentVersion: "0.4.1" }, release())).toMatchObject({ status: "up_to_date" });
  });

  it("is unavailable for drafts, prereleases, suffixed tags, or an unparsable current version", () => {
    for (const bad of [release({ draft: true }), release({ prerelease: true }), release({ tagName: "v0.3.0-rc.1" })]) {
      expect(evaluateRelease(base, bad)).toEqual({ ...base, status: "unavailable" });
    }
    expect(evaluateRelease({ ...base, currentVersion: "dev" }, release()).status).toBe("unavailable");
  });
});

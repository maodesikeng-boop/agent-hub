import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_INSTALLER_FILES } from "../src/shared/update.ts";
import { RELEASE_ASSETS, assertVersionSourcesMatch, composeReleaseNotes, isTagPushOf, prepareReleaseAssets } from "./release-assets.ts";
import { REPO_ROOT, readDesktopAppVersion, sha256FileHex } from "./stage-runtime-common.ts";

function writeArtifact(dir: string, name: string, body: string, hashOverride?: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
  const hash = hashOverride ?? sha256FileHex(join(dir, name));
  writeFileSync(join(dir, `${name}.sha256`), `${hash}  ${name}\n`);
}

const TAURI_CONF = ["apps", "windows", "crates", "fusa-desktop", "tauri.conf.json"];

function versionSourcesRepo(versions: { pkg: string; tauri: string; securitySeries?: readonly string[] }): string {
  const root = mkdtempSync(join(tmpdir(), "fusa-release-versions-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-hub", version: versions.pkg }));
  mkdirSync(join(root, ...TAURI_CONF.slice(0, -1)), { recursive: true });
  cpSync(join(REPO_ROOT, ...TAURI_CONF), join(root, ...TAURI_CONF));
  const conf = JSON.parse(readFileSync(join(root, ...TAURI_CONF), "utf8")) as Record<string, unknown>;
  writeFileSync(join(root, ...TAURI_CONF), JSON.stringify({ ...conf, version: versions.tauri }));
  const defaultSeries = `${versions.pkg.split(".").slice(0, 2).join(".")}.x`;
  const series = versions.securitySeries ?? [defaultSeries, defaultSeries];
  const securityBody = series.map((item, idx) => `Section ${idx + 1}: \`${item}\``).join("\n\n");
  writeFileSync(join(root, "SECURITY.md"), `${securityBody}\n`);
  return root;
}

describe("scripts/release-assets.ts", () => {
  it("writes to GitHub only from a run started by pushing that exact tag", () => {
    const push = { GITHUB_EVENT_NAME: "push", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.4.0-rc.1" };
    expect(isTagPushOf("v0.4.0-rc.1", push)).toBe(true);
    expect(isTagPushOf("v0.4.0", push)).toBe(false);
    expect(isTagPushOf("v0.4.0-rc.1", { ...push, GITHUB_EVENT_NAME: "workflow_dispatch" })).toBe(false);
    expect(isTagPushOf("v0.4.0-rc.1", { ...push, GITHUB_REF_TYPE: "branch" })).toBe(false);
    expect(isTagPushOf("v0.4.0-rc.1", {})).toBe(false);
  });

  it("builds release notes from the CHANGELOG.md section followed by the shared downloads table", () => {
    const downloads = readFileSync(join(REPO_ROOT, ".github", "release-downloads.md"), "utf8");
    const notes = composeReleaseNotes(readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8"), downloads, "0.3.0");
    expect(notes.startsWith("- ")).toBe(true);
    expect(notes).toContain("### English");
    expect(downloads).not.toContain("/blob/main/");
    expect(notes).toContain("https://github.com/maodesikeng-boop/agent-hub/blob/v0.3.0/docs/verification-matrix.md");
    expect(notes).not.toContain("/blob/main/docs/verification-matrix.md");

    const rcNotes = composeReleaseNotes(readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8"), downloads, "0.4.0", {
      ref: "v0.4.0-rc.1",
      repo: "example-org/agent-hub",
    });
    expect(rcNotes).toContain("https://github.com/example-org/agent-hub/blob/v0.4.0-rc.1/docs/verification-matrix.md");
    expect(rcNotes).not.toContain("{{RELEASE_");

    expect(() => composeReleaseNotes("## v0.4.0\n- x\n", downloads, "0.4.0", { ref: "main" })).toThrow(/release tag or commit SHA/i);
    expect(() => composeReleaseNotes("## v0.4.0\n- x\n", downloads, "0.4.0", { ref: "HEAD" })).toThrow(/release tag or commit SHA/i);
    expect(() => composeReleaseNotes("## v0.4.0\n- x\n", downloads, "0.4.0", { ref: "develop" })).toThrow(/release tag or commit SHA/i);
    expect(() => composeReleaseNotes("## v0.4.0\n- x\n", downloads, "0.4.0", { ref: "v0.3.0" })).toThrow(/release tag/i);
    expect(() =>
      composeReleaseNotes(
        "## v0.4.0\n- x\n",
        "[matrix](https://github.com/maodesikeng-boop/agent-hub/blob/main/docs/verification-matrix.md)",
        "0.4.0",
      ),
    ).toThrow(/floating branch/i);
    expect(() =>
      composeReleaseNotes(
        "## v0.4.0\n- x\n",
        "[matrix](https://github.com/maodesikeng-boop/agent-hub/blob/develop/docs/verification-matrix.md)",
        "0.4.0",
        { ref: "v0.4.0" },
      ),
    ).toThrow(/release ref|floating branch/i);
    expect(() =>
      composeReleaseNotes(
        "## v0.4.0\n- x\n",
        "[matrix](https://github.com/maodesikeng-boop/agent-hub/blob/v0.3.0/docs/verification-matrix.md)",
        "0.4.0",
        { ref: "v0.4.0" },
      ),
    ).toThrow(/release ref|v0\.4\.0/i);
    expect(() =>
      composeReleaseNotes(
        "## v0.4.0\n- x\n",
        [
          "[zh](https://github.com/{{RELEASE_REPO}}/blob/{{RELEASE_REF}}/docs/verification-matrix.md)",
          "[en](https://github.com/{{RELEASE_REPO}}/blob/develop/docs/verification-matrix.md)",
        ].join("\n"),
        "0.4.0",
        { ref: "v0.4.0" },
      ),
    ).toThrow(/release ref|floating branch/i);
    expect(() =>
      composeReleaseNotes(
        "## v0.4.0\n- x\n",
        "[matrix](https://github.com/other-org/agent-hub/blob/v0.4.0/docs/verification-matrix.md)",
        "0.4.0",
        { ref: "v0.4.0", repo: "maodesikeng-boop/agent-hub" },
      ),
    ).toThrow(/release ref|maodesikeng-boop\/agent-hub/i);
    expect(() => composeReleaseNotes("## v0.4.0\n- x\n", "No matrix link in downloads", "0.4.0", { ref: "v0.4.0" })).toThrow(
      /verification-matrix/i,
    );
    const shaNotes = composeReleaseNotes("## v0.4.0\n- x\n", downloads, "0.4.0", {
      ref: "6f6eed4107d8a7cc77a0a615c72fba59b1cc77c7",
    });
    expect(shaNotes).toContain(
      "https://github.com/maodesikeng-boop/agent-hub/blob/6f6eed4107d8a7cc77a0a615c72fba59b1cc77c7/docs/verification-matrix.md",
    );

    for (const name of Object.values(RELEASE_INSTALLER_FILES)) expect(downloads).toContain(`\`${name}.sha256\``);
    expect(() => composeReleaseNotes("## v0.3.0\n- x\n", downloads, "9.9.9")).toThrow('no "## v9.9.9" section');
  });

  it("keeps package.json, Cargo.toml, tauri.conf.json, and SECURITY.md on one version in this repository", () => {
    expect(() => assertVersionSourcesMatch(REPO_ROOT, readDesktopAppVersion())).not.toThrow();
  });

  it("rejects a package.json, tauri.conf.json, or SECURITY.md version that drifts from Cargo.toml", () => {
    const pkgDrift = versionSourcesRepo({ pkg: "0.2.1", tauri: "0.2.0" });
    const tauriDrift = versionSourcesRepo({ pkg: "0.2.0", tauri: "0.1.9" });
    const patchMatch = versionSourcesRepo({ pkg: "0.3.2", tauri: "0.3.2", securitySeries: ["0.3.x", "0.3.x"] });
    const securityStale = versionSourcesRepo({ pkg: "0.4.0", tauri: "0.4.0", securitySeries: ["0.3.x", "0.3.x"] });
    const securityHalfUpdated = versionSourcesRepo({ pkg: "0.4.0", tauri: "0.4.0", securitySeries: ["0.4.x", "0.3.x"] });
    const securitySingleSection = versionSourcesRepo({ pkg: "0.4.0", tauri: "0.4.0", securitySeries: ["0.4.x"] });
    try {
      expect(() => assertVersionSourcesMatch(pkgDrift, "0.2.0")).toThrow("package.json version 0.2.1 does not match apps/windows/Cargo.toml version 0.2.0");
      expect(() => assertVersionSourcesMatch(tauriDrift, "0.2.0")).toThrow("tauri.conf.json version 0.1.9 does not match apps/windows/Cargo.toml version 0.2.0");
      expect(() => assertVersionSourcesMatch(tauriDrift, "0.1.9")).toThrow(/^package\.json version 0\.2\.0/);
      expect(() => assertVersionSourcesMatch(patchMatch, "0.3.2")).not.toThrow();
      expect(() => assertVersionSourcesMatch(securityStale, "0.4.0")).toThrow(
        "SECURITY.md supported version 0.3.x does not match package.json version 0.4.0 (expected 0.4.x)",
      );
      expect(() => assertVersionSourcesMatch(securityHalfUpdated, "0.4.0")).toThrow(
        "SECURITY.md supported version 0.3.x does not match package.json version 0.4.0 (expected 0.4.x)",
      );
      expect(() => assertVersionSourcesMatch(securitySingleSection, "0.4.0")).toThrow(
        "SECURITY.md must list supported version 0.4.x in both English and Chinese sections",
      );
    } finally {
      for (const dir of [pkgDrift, tauriDrift, patchMatch, securityStale, securityHalfUpdated, securitySingleSection]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("uses fixed names without a version or unsigned-preview suffix, shared with the in-app update check", () => {
    expect(RELEASE_ASSETS.map((spec) => spec.fixedName).sort()).toEqual(Object.values(RELEASE_INSTALLER_FILES).sort());
    for (const spec of RELEASE_ASSETS) {
      expect(spec.fixedName).not.toMatch(/\d+\.\d+|unsigned|preview/);
    }
  });

  it("prepare copies artifacts to fixed names and rewrites .sha256 for the new name", () => {
    const root = mkdtempSync(join(tmpdir(), "fusa-release-assets-"));
    try {
      const win = join(root, "win");
      const mac = join(root, "mac");
      writeArtifact(win, "Bellwood_0.1.0_x64-setup-unsigned-preview.exe", "win-bytes");
      writeArtifact(mac, "Bellwood_0.1.0_arm64-unsigned-preview.dmg", "mac-bytes");
      const out = join(root, "out");
      const written = prepareReleaseAssets({ dirs: { windows: win, macos: mac }, outDir: out, appVersion: "0.1.0" });
      expect(written).toEqual([
        "Bellwood-windows-x64-setup.exe",
        "Bellwood-windows-x64-setup.exe.sha256",
        "Bellwood-macos-arm64.dmg",
        "Bellwood-macos-arm64.dmg.sha256",
      ]);
      expect(readFileSync(join(out, "Bellwood-macos-arm64.dmg"), "utf8")).toBe("mac-bytes");
      const sha = readFileSync(join(out, "Bellwood-windows-x64-setup.exe.sha256"), "utf8");
      expect(sha).toBe(`${sha256FileHex(join(out, "Bellwood-windows-x64-setup.exe"))}  Bellwood-windows-x64-setup.exe\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prepare rejects a version mismatch, a checksum mismatch, and a missing directory", () => {
    const root = mkdtempSync(join(tmpdir(), "fusa-release-assets-bad-"));
    try {
      const win = join(root, "win");
      const mac = join(root, "mac");
      writeArtifact(win, "Bellwood_0.1.0_x64-setup-unsigned-preview.exe", "w");
      writeArtifact(mac, "Bellwood_0.1.0_arm64-unsigned-preview.dmg", "m");
      const dirs = { windows: win, macos: mac };
      expect(() => prepareReleaseAssets({ dirs, outDir: join(root, "o1"), appVersion: "0.2.0" })).toThrow(/does not match app version 0\.2\.0/);

      const badMac = join(root, "badmac");
      writeArtifact(badMac, "Bellwood_0.1.0_arm64-unsigned-preview.dmg", "m", "0".repeat(64));
      expect(() => prepareReleaseAssets({ dirs: { windows: win, macos: badMac }, outDir: join(root, "o2"), appVersion: "0.1.0" })).toThrow(/SHA-256/);

      expect(() => prepareReleaseAssets({ dirs: { windows: win, macos: join(root, "nope") }, outDir: join(root, "o3"), appVersion: "0.1.0" })).toThrow(/does not exist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

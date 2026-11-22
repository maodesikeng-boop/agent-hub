import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_RELEASE_ASSETS, planRelease, releaseNotesFor, type ExistingRelease, type ReleaseFacts } from "./release-plan.ts";
import { REPO_ROOT, readDesktopAppVersion } from "./stage-runtime-common.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function release(tag: string, overrides: Partial<ExistingRelease> = {}): ExistingRelease {
  return { tag, commit: SHA, draft: false, prerelease: tag.includes("-"), assets: [...REQUIRED_RELEASE_ASSETS], ...overrides };
}

function facts(tag: string, overrides: Partial<ReleaseFacts> = {}): ReleaseFacts {
  return { tag, commit: SHA, appVersion: "0.4.0", onMain: true, releases: [release("v0.3.0")], ...overrides };
}

describe("planRelease", () => {
  it("plans a build for vX.Y.Z-rc.N on a main commit with no existing release", () => {
    expect(planRelease(facts("v0.4.0-rc.2"))).toEqual({ mode: "build", tag: "v0.4.0-rc.2", version: "0.4.0", rc: 2 });
  });

  it("plans a promote from the highest-numbered published rc of the same version on the same commit", () => {
    const releases = [release("v0.4.0-rc.2", { commit: OTHER_SHA }), release("v0.4.0-rc.10"), release("v0.4.0-rc.9", { commit: OTHER_SHA })];
    expect(planRelease(facts("v0.4.0", { releases }))).toEqual({ mode: "promote", tag: "v0.4.0", version: "0.4.0", fromTag: "v0.4.0-rc.10" });
  });

  it("refuses a tag whose version differs from the app version", () => {
    expect(() => planRelease(facts("v0.5.0-rc.1"))).toThrow("Tag v0.5.0-rc.1 does not match app version 0.4.0");
  });

  it("refuses a prerelease suffix other than -rc.N", () => {
    for (const tag of ["v0.4.0-beta.1", "v0.4.0-rc.0", "v0.4.0-rc1", "0.4.0", "v0.4"]) {
      expect(() => planRelease(facts(tag)), tag).toThrow(`Tag ${tag} is not vX.Y.Z or vX.Y.Z-rc.N`);
    }
  });

  it("refuses a commit that main does not contain", () => {
    expect(() => planRelease(facts("v0.4.0-rc.1", { onMain: false }))).toThrow(`Commit ${SHA} of v0.4.0-rc.1 is not on main`);
    expect(planRelease(facts("v0.4.0-rc.1", { onMain: false }), { dryRun: true }).mode).toBe("build");
  });

  it("refuses a tag that already has a published release", () => {
    const releases = [release("v0.4.0-rc.1")];
    expect(() => planRelease(facts("v0.4.0-rc.1", { releases }))).toThrow("Tag v0.4.0-rc.1 already has a published release");
    expect(() => planRelease(facts("v0.4.0-rc.1", { releases }), { dryRun: true })).toThrow("already has a published release");
  });

  it("refuses a tag that already has a draft release", () => {
    const releases = [release("v0.4.0-rc.1", { draft: true })];
    expect(() => planRelease(facts("v0.4.0-rc.1", { releases }))).toThrow("Tag v0.4.0-rc.1 already has a draft release");
  });

  it("refuses a formal tag with no published rc for its version", () => {
    const releases = [release("v0.3.0"), release("v0.3.0-rc.1")];
    expect(() => planRelease(facts("v0.4.0", { releases }))).toThrow("v0.4.0 has no published v0.4.0-rc.N to promote");
  });

  it("refuses a formal tag on a different commit than the newest rc", () => {
    const releases = [release("v0.4.0-rc.1"), release("v0.4.0-rc.2", { commit: OTHER_SHA })];
    expect(() => planRelease(facts("v0.4.0", { releases }))).toThrow(`newest candidate v0.4.0-rc.2 points at ${OTHER_SHA}`);
  });

  it("ignores draft rcs when choosing the rc to promote", () => {
    const releases = [release("v0.4.0-rc.1"), release("v0.4.0-rc.2", { draft: true, commit: OTHER_SHA })];
    expect(planRelease(facts("v0.4.0", { releases }))).toMatchObject({ mode: "promote", fromTag: "v0.4.0-rc.1" });
  });

  it("refuses a formal tag when the newest rc lacks an installer or a .sha256", () => {
    for (const absent of REQUIRED_RELEASE_ASSETS) {
      const releases = [release("v0.4.0-rc.1", { assets: REQUIRED_RELEASE_ASSETS.filter((name) => name !== absent) })];
      expect(() => planRelease(facts("v0.4.0", { releases })), absent).toThrow(`v0.4.0-rc.1 lacks ${absent}`);
    }
  });
});

const CHANGELOG = ["# Changelog", "", "## v0.4.0", "", "- 新功能", "", "### English", "", "- New feature", "", "## v0.3.0", "", "- Old", ""].join("\n");

describe("releaseNotesFor", () => {
  it("returns the section under ## vX.Y.Z up to the next ## heading", () => {
    expect(releaseNotesFor(CHANGELOG, "0.4.0")).toBe("- 新功能\n\n### English\n\n- New feature");
    expect(releaseNotesFor(CHANGELOG, "0.3.0")).toBe("- Old");
  });

  it("throws when the version has no section", () => {
    expect(() => releaseNotesFor(CHANGELOG, "0.4.1")).toThrow('CHANGELOG.md has no "## v0.4.1" section');
    expect(() => releaseNotesFor(CHANGELOG, "0.4")).toThrow('no "## v0.4" section');
  });

  it("throws when the section is empty", () => {
    expect(() => releaseNotesFor("## v0.5.0\n\n## v0.4.0\n- x\n", "0.5.0")).toThrow('CHANGELOG.md section "## v0.5.0" is empty');
  });

  it("finds a section for the current package.json version in CHANGELOG.md", () => {
    const changelog = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const notes = releaseNotesFor(changelog, readDesktopAppVersion());
    expect(notes).toContain("### English");
  });
});

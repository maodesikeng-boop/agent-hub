import { describe, it } from "vitest";

describe("planRelease", () => {
  it.todo("plans a build for vX.Y.Z-rc.N on a main commit with no existing release");
  it.todo("plans a promote from the highest-numbered published rc of the same version on the same commit");
  it.todo("refuses a tag whose version differs from the app version");
  it.todo("refuses a prerelease suffix other than -rc.N");
  it.todo("refuses a commit that main does not contain");
  it.todo("refuses a tag that already has a published release");
  it.todo("refuses a tag that already has a draft release");
  it.todo("refuses a formal tag with no published rc for its version");
  it.todo("refuses a formal tag on a different commit than the newest rc");
  it.todo("ignores draft rcs when choosing the rc to promote");
  it.todo("refuses a formal tag when the newest rc lacks an installer or a .sha256");
});

describe("releaseNotesFor", () => {
  it.todo("returns the section under ## vX.Y.Z up to the next ## heading");
  it.todo("throws when the version has no section");
  it.todo("throws when the section is empty");
  it.todo("finds a section for the current package.json version in CHANGELOG.md");
});

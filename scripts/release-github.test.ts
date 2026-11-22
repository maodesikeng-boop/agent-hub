import { describe, it } from "vitest";

describe("readReleaseFacts", () => {
  it.todo("reads every release with its tag commit, draft and prerelease flags, and asset names");
  it.todo("reports onMain from git merge-base --is-ancestor against origin/main");
  it.todo("uses HEAD as the commit when the tag does not exist yet");
});

describe("publishRelease", () => {
  it.todo("creates a build plan's release as a draft, uploads every asset, then publishes it as a prerelease");
  it.todo("downloads the rc assets for a promote plan and publishes them as latest under the formal tag");
  it.todo("refuses to publish a promoted asset whose .sha256 does not match");
  it.todo("refuses to publish a promoted asset without a release.yml build provenance attestation");
  it.todo("never passes --clobber and never uploads to or edits an existing release");
  it.todo("logs every write command and runs only read commands in dry-run mode");
});

describe("yankRelease", () => {
  it.todo("marks the release as a prerelease that is not latest and marks the previous formal release as latest");
  it.todo("confirms that releases/latest returns the previous formal release");
  it.todo("throws when no other formal release exists");
  it.todo("logs the edits without running them in dry-run mode");
});

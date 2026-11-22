import { describe, it } from "vitest";

describe("pruneLockfile", () => {
  it.todo("keeps exactly the requested root dependencies with their root specifiers and resolved versions");
  it.todo("keeps the transitive closure in packages and snapshots, including optional platform packages");
  it.todo("drops devDependencies and packages that only the web bundle uses");
  it.todo("throws when a requested dependency is missing from the root importer");
  it.todo("throws when a requested specifier differs from the root importer");
  it.todo("throws when a referenced snapshot is absent");
  it.todo("prunes the real root lockfile for buildStagedDaemonPackageJson so pnpm accepts it with --frozen-lockfile --offline");
});

describe("assertInstalledMatchesLockfile", () => {
  it.todo("accepts a hoisted tree whose top-level and nested packages all appear in the lockfile");
  it.todo("throws listing every package whose installed version is not in the lockfile");
});

describe("STAGED_INSTALL_ARGS", () => {
  it.todo("installs with --frozen-lockfile and --offline and never with --no-lockfile");
});

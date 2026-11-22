import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { readBuildCommit, stageDaemonTree } from "./stage-runtime-common.ts";
import { STAGED_INSTALL_ARGS } from "./staged-lockfile.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function committedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "fusa-build-commit-"));
  git(root, "init", "-q");
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  writeFileSync(join(root, "tracked.txt"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

describe("readBuildCommit", () => {
  it("returns the full HEAD commit of a clean checkout", () => {
    const root = committedRepo();
    try {
      const commit = readBuildCommit(root);
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      expect(commit).toBe(git(root, "rev-parse", "HEAD"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds -dirty when a tracked file differs from HEAD", () => {
    const root = committedRepo();
    try {
      writeFileSync(join(root, "tracked.txt"), "two\n");
      expect(readBuildCommit(root)).toBe(`${git(root, "rev-parse", "HEAD")}-dirty`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores untracked and git-ignored build output", () => {
    const root = committedRepo();
    try {
      writeFileSync(join(root, "untracked.txt"), "new\n");
      mkdirSync(join(root, "dist"));
      writeFileSync(join(root, "dist", "index.html"), "<html></html>");
      expect(readBuildCommit(root)).toBe(git(root, "rev-parse", "HEAD"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws outside a git checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "fusa-build-commit-none-"));
    try {
      expect(() => readBuildCommit(root)).toThrow(/git rev-parse --verify HEAD\^\{commit\} failed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const DAEMON_DEPS = { "@microsoft/mxc-sdk": "^1.0.1", zod: "^4.0.0" };

function fakeDaemonRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "fusa-stage-daemon-"));
  for (const sub of ["admin", "daemon", "shared", "vendors", "hub", "feishu", "mesh", "relay"]) {
    mkdirSync(join(root, "src", sub), { recursive: true });
  }
  writeFileSync(join(root, "src", "daemon", "main.ts"), 'import { z } from "zod";\nexport const schema = z.string();\n');
  mkdirSync(join(root, "migrations"));
  writeFileSync(join(root, "migrations", "0001_init.sql"), "SELECT 1;\n");
  mkdirSync(join(root, "dist", "web"), { recursive: true });
  writeFileSync(join(root, "dist", "web", "index.html"), "<html></html>");
  mkdirSync(join(root, "apps", "desktop"), { recursive: true });
  writeFileSync(join(root, "apps", "desktop", "contract.json"), "{}");
  writeFileSync(join(root, "tsconfig.json"), "{}");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.3.0", dependencies: { ...DAEMON_DEPS, react: "^19.0.0" } }));
  writeFileSync(
    join(root, "pnpm-lock.yaml"),
    stringify({
      lockfileVersion: "9.0",
      importers: {
        ".": {
          dependencies: {
            "@microsoft/mxc-sdk": { specifier: "^1.0.1", version: "1.0.1" },
            zod: { specifier: "^4.0.0", version: "4.0.0" },
            react: { specifier: "^19.0.0", version: "19.0.0" },
          },
        },
      },
      packages: {
        "@microsoft/mxc-sdk@1.0.1": { resolution: { integrity: "sha512-m" } },
        "zod@4.0.0": { resolution: { integrity: "sha512-z" } },
        "react@19.0.0": { resolution: { integrity: "sha512-r" } },
      },
      snapshots: { "@microsoft/mxc-sdk@1.0.1": {}, "zod@4.0.0": {}, "react@19.0.0": {} },
    }),
  );
  return root;
}

/** Puts a fake pnpm first on PATH that logs its arguments and installs zod at FAKE_PNPM_ZOD_VERSION. */
function installFakePnpm(root: string, zodVersion: string): string {
  const bin = join(root, "fake-bin");
  const log = join(root, "pnpm-args.txt");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pnpm"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$FAKE_PNPM_LOG"',
      "mkdir -p node_modules/zod node_modules/@microsoft/mxc-sdk",
      `printf '{"name":"zod","version":"%s"}' "$FAKE_PNPM_ZOD_VERSION" > node_modules/zod/package.json`,
      `printf '{"name":"@microsoft/mxc-sdk","version":"1.0.1"}' > node_modules/@microsoft/mxc-sdk/package.json`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("FAKE_PNPM_LOG", log);
  vi.stubEnv("FAKE_PNPM_ZOD_VERSION", zodVersion);
  return log;
}

// The fake pnpm is a POSIX shell script; Windows CI covers the real staged install in windows-desktop.yml.
const itPosix = it.skipIf(process.platform === "win32");

describe("stageDaemonTree", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  itPosix("writes the pruned lockfile next to the staged package.json and installs with STAGED_INSTALL_ARGS", () => {
    const root = fakeDaemonRepo();
    try {
      const log = installFakePnpm(root, "4.0.0");
      const daemonOutDir = join(root, "out", "daemon");
      stageDaemonTree({ repoRoot: root, daemonOutDir, targetOs: "host" });

      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([...STAGED_INSTALL_ARGS]);
      const stagedPkg = JSON.parse(readFileSync(join(daemonOutDir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
      expect(stagedPkg.dependencies).toEqual(DAEMON_DEPS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itPosix("keeps the pruned pnpm-lock.yaml in the staged daemon directory as the record of shipped versions", () => {
    const root = fakeDaemonRepo();
    try {
      installFakePnpm(root, "4.0.0");
      const daemonOutDir = join(root, "out", "daemon");
      stageDaemonTree({ repoRoot: root, daemonOutDir, targetOs: "host" });

      const lock = readFileSync(join(daemonOutDir, "pnpm-lock.yaml"), "utf8");
      expect(lock).toContain("zod@4.0.0");
      expect(lock).toContain('"@microsoft/mxc-sdk@1.0.1"');
      expect(lock).not.toContain("react");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itPosix("fails the build when pnpm installs a version outside the lockfile", () => {
    const root = fakeDaemonRepo();
    try {
      installFakePnpm(root, "4.1.0");
      expect(() => stageDaemonTree({ repoRoot: root, daemonOutDir: join(root, "out", "daemon"), targetOs: "host" })).toThrow(
        /missing from the staged pnpm-lock\.yaml:\n {2}zod@4\.1\.0/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

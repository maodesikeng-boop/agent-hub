import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { REPO_ROOT, buildStagedDaemonPackageJson } from "./stage-runtime-common.ts";
import { STAGED_INSTALL_ARGS, assertInstalledMatchesLockfile, pruneLockfile } from "./staged-lockfile.ts";

const ROOT_LOCK = stringify({
  lockfileVersion: "9.0",
  settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
  importers: {
    ".": {
      dependencies: {
        fastify: { specifier: "^5.0.0", version: "5.1.0(zod@4.0.0)" },
        zod: { specifier: "^4.0.0", version: "4.0.0" },
        react: { specifier: "^19.0.0", version: "19.0.0" },
      },
      devDependencies: { vitest: { specifier: "^5.0.0", version: "5.0.0" } },
    },
  },
  packages: {
    "fastify@5.1.0": { resolution: { integrity: "sha512-f" } },
    "zod@4.0.0": { resolution: { integrity: "sha512-z" } },
    "cookie@2.0.1": { resolution: { integrity: "sha512-c" } },
    "fsevents@2.3.3": { resolution: { integrity: "sha512-e" }, os: ["darwin"] },
    "react@19.0.0": { resolution: { integrity: "sha512-r" } },
    "vitest@5.0.0": { resolution: { integrity: "sha512-v" } },
  },
  snapshots: {
    "fastify@5.1.0(zod@4.0.0)": { dependencies: { cookie: "2.0.1", zod: "4.0.0" }, optionalDependencies: { fsevents: "2.3.3" } },
    "zod@4.0.0": {},
    "cookie@2.0.1": {},
    "fsevents@2.3.3": {},
    "react@19.0.0": {},
    "vitest@5.0.0": {},
  },
});

interface ParsedLock {
  importers: Record<string, { dependencies: Record<string, { specifier: string; version: string }>; devDependencies?: unknown }>;
  packages: Record<string, unknown>;
  snapshots: Record<string, unknown>;
}

function writePackage(nodeModules: string, name: string, version: string): string {
  const dir = join(nodeModules, ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
  return dir;
}

function runPnpm(cwd: string, args: readonly string[]): { status: number | null; output: string } {
  const res = spawnSync("pnpm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  return { status: res.status, output: `${res.stdout}${res.stderr}` };
}

describe("pruneLockfile", () => {
  it("keeps exactly the requested root dependencies with their root specifiers and resolved versions", () => {
    const pruned = parse(pruneLockfile(ROOT_LOCK, { fastify: "^5.0.0", zod: "^4.0.0" })) as ParsedLock;
    expect(Object.keys(pruned.importers)).toEqual(["."]);
    expect(pruned.importers["."]!.dependencies).toEqual({
      fastify: { specifier: "^5.0.0", version: "5.1.0(zod@4.0.0)" },
      zod: { specifier: "^4.0.0", version: "4.0.0" },
    });
  });

  it("keeps the transitive closure in packages and snapshots, including optional platform packages", () => {
    const pruned = parse(pruneLockfile(ROOT_LOCK, { fastify: "^5.0.0", zod: "^4.0.0" })) as ParsedLock;
    expect(Object.keys(pruned.snapshots).sort()).toEqual(["cookie@2.0.1", "fastify@5.1.0(zod@4.0.0)", "fsevents@2.3.3", "zod@4.0.0"]);
    expect(Object.keys(pruned.packages).sort()).toEqual(["cookie@2.0.1", "fastify@5.1.0", "fsevents@2.3.3", "zod@4.0.0"]);
  });

  it("drops devDependencies and packages that only the web bundle uses", () => {
    const pruned = parse(pruneLockfile(ROOT_LOCK, { fastify: "^5.0.0", zod: "^4.0.0" })) as ParsedLock;
    expect(pruned.importers["."]!.devDependencies).toBeUndefined();
    expect(pruned.packages).not.toHaveProperty("react@19.0.0");
    expect(pruned.packages).not.toHaveProperty("vitest@5.0.0");
  });

  it("throws when a requested dependency is missing from the root importer", () => {
    expect(() => pruneLockfile(ROOT_LOCK, { "left-pad": "^1.3.0" })).toThrow("left-pad is not a dependency of the root importer");
  });

  it("throws when a requested specifier differs from the root importer", () => {
    expect(() => pruneLockfile(ROOT_LOCK, { zod: "^4.1.0" })).toThrow("zod has specifier ^4.1.0, but pnpm-lock.yaml locks ^4.0.0");
  });

  it("throws when a referenced snapshot is absent", () => {
    const lock = parse(ROOT_LOCK) as ParsedLock;
    delete lock.snapshots["cookie@2.0.1"];
    expect(() => pruneLockfile(stringify(lock), { fastify: "^5.0.0" })).toThrow("pnpm-lock.yaml has no snapshot for cookie@2.0.1");
  });

  it("prunes the real root lockfile for buildStagedDaemonPackageJson so pnpm accepts it with --frozen-lockfile --offline", () => {
    const dir = mkdtempSync(join(tmpdir(), "fusa-staged-lock-"));
    try {
      const pkg = buildStagedDaemonPackageJson();
      const pruned = pruneLockfile(readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8"), pkg.dependencies);
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
      writeFileSync(join(dir, "pnpm-lock.yaml"), pruned);
      // --lockfile-only keeps the frozen specifier check but skips copying about 250 packages out of the store.
      const accepted = runPnpm(dir, [...STAGED_INSTALL_ARGS, "--lockfile-only"]);
      expect(accepted.status, accepted.output).toBe(0);

      writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, zod: "^4.0.0" } }));
      const drifted = runPnpm(dir, [...STAGED_INSTALL_ARGS, "--lockfile-only"]);
      expect(drifted.status).not.toBe(0);
      expect(drifted.output).toContain("zod (lockfile: ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assertInstalledMatchesLockfile", () => {
  const lockfile = pruneLockfile(ROOT_LOCK, { fastify: "^5.0.0", zod: "^4.0.0" });

  it("accepts a hoisted tree whose top-level and nested packages all appear in the lockfile", () => {
    const root = mkdtempSync(join(tmpdir(), "fusa-staged-tree-"));
    try {
      const nm = join(root, "node_modules");
      const fastify = writePackage(nm, "fastify", "5.1.0");
      writePackage(join(fastify, "node_modules"), "cookie", "2.0.1");
      writePackage(nm, "zod", "4.0.0");
      mkdirSync(join(nm, ".bin"), { recursive: true });
      expect(() => assertInstalledMatchesLockfile(nm, lockfile)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws listing every package whose installed version is not in the lockfile", () => {
    const root = mkdtempSync(join(tmpdir(), "fusa-staged-tree-"));
    try {
      const nm = join(root, "node_modules");
      const fastify = writePackage(nm, "fastify", "5.1.0");
      writePackage(join(fastify, "node_modules"), "cookie", "2.0.2");
      writePackage(nm, "zod", "4.0.0");
      writePackage(nm, "@types/node", "26.6.6");
      let message = "";
      try {
        assertInstalledMatchesLockfile(nm, lockfile);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("cookie@2.0.2");
      expect(message).toContain("@types/node@26.6.6");
      expect(message).not.toContain("zod@4.0.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("STAGED_INSTALL_ARGS", () => {
  it("installs with --frozen-lockfile and --offline and never with --no-lockfile", () => {
    expect(STAGED_INSTALL_ARGS).toContain("--frozen-lockfile");
    expect(STAGED_INSTALL_ARGS).toContain("--offline");
    expect(STAGED_INSTALL_ARGS).toContain("--prod");
    expect(STAGED_INSTALL_ARGS).not.toContain("--no-lockfile");
    expect(STAGED_INSTALL_ARGS).not.toContain("--prefer-offline");
  });
});

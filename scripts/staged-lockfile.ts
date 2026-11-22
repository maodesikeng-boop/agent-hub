// Pins the staged desktop daemon to the root pnpm-lock.yaml so an installer ships exactly the dependency tree CI tested.
// Invariant: staging never resolves a version range; every installed package comes from the root lockfile with its integrity hash.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

/** Arguments for installing the staged daemon: frozen lockfile, no network, no lifecycle scripts, and a flat copied node_modules. */
export const STAGED_INSTALL_ARGS: readonly string[] = [
  "install",
  "--prod",
  "--frozen-lockfile",
  "--offline",
  "--ignore-scripts",
  "--config.node-linker=hoisted",
  "--config.package-import-method=copy",
];

interface ImporterDependency {
  specifier: string;
  version: string;
}

interface SnapshotEntry {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PnpmLockfile {
  lockfileVersion: string;
  settings?: Record<string, unknown>;
  importers: Record<string, { dependencies?: Record<string, ImporterDependency> }>;
  packages: Record<string, unknown>;
  snapshots: Record<string, SnapshotEntry | null>;
}

function parseLockfile(text: string): PnpmLockfile {
  const lock = parse(text) as PnpmLockfile;
  if (String(lock.lockfileVersion) !== "9.0") {
    throw new Error(`Unsupported pnpm lockfileVersion ${lock.lockfileVersion}; expected 9.0`);
  }
  return lock;
}

/** Turns a dependency reference such as `2.5.0(zod@4.6.7)` or an alias `string-width@4.2.3` into its snapshot key. */
function snapshotKeyOf(name: string, ref: string): string {
  if (ref.startsWith("link:") || ref.startsWith("file:")) {
    throw new Error(`Staged daemon dependency ${name} uses ${ref}, which cannot be installed outside the repository`);
  }
  const base = ref.replace(/\(.*$/, "");
  return base.lastIndexOf("@") > 0 ? ref : `${name}@${ref}`;
}

function packageKeyOf(snapshotKey: string): string {
  return snapshotKey.replace(/\(.*$/, "");
}

/**
 * Precondition: rootLockfile is the text of a lockfileVersion 9.0 pnpm-lock.yaml, and each key of dependencies is a
 * dependency of the root importer whose specifier equals the given value.
 * Postcondition: returns lockfile text with a single importer that lists exactly those dependencies at the root's resolved
 * versions, with `packages` and `snapshots` limited to their transitive closure, including optional dependencies of every platform.
 * Throws when a dependency is missing from the root importer, its specifier differs, or a referenced snapshot is absent.
 */
export function pruneLockfile(rootLockfile: string, dependencies: Readonly<Record<string, string>>): string {
  const lock = parseLockfile(rootLockfile);
  const rootDeps = lock.importers["."]?.dependencies ?? {};
  const importerDeps: Record<string, ImporterDependency> = {};
  for (const [name, specifier] of Object.entries(dependencies)) {
    const locked = rootDeps[name];
    if (!locked) throw new Error(`${name} is not a dependency of the root importer in pnpm-lock.yaml`);
    if (locked.specifier !== specifier) {
      throw new Error(`${name} has specifier ${specifier}, but pnpm-lock.yaml locks ${locked.specifier}; run pnpm install`);
    }
    importerDeps[name] = { specifier: locked.specifier, version: locked.version };
  }

  const keep = new Set<string>();
  const pending = Object.entries(importerDeps).map(([name, dep]) => snapshotKeyOf(name, dep.version));
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (keep.has(key)) continue;
    if (!(key in lock.snapshots)) throw new Error(`pnpm-lock.yaml has no snapshot for ${key}`);
    if (!(packageKeyOf(key) in lock.packages)) throw new Error(`pnpm-lock.yaml has no package entry for ${packageKeyOf(key)}`);
    keep.add(key);
    const snapshot = lock.snapshots[key] ?? {};
    for (const refs of [snapshot.dependencies, snapshot.optionalDependencies]) {
      for (const [name, ref] of Object.entries(refs ?? {})) pending.push(snapshotKeyOf(name, ref));
    }
  }

  const keptPackages = new Set([...keep].map(packageKeyOf));
  const pruned: PnpmLockfile = {
    lockfileVersion: lock.lockfileVersion,
    ...(lock.settings ? { settings: lock.settings } : {}),
    importers: { ".": { dependencies: importerDeps } },
    packages: Object.fromEntries(Object.entries(lock.packages).filter(([key]) => keptPackages.has(key))),
    snapshots: Object.fromEntries(Object.entries(lock.snapshots).filter(([key]) => keep.has(key))),
  };
  return stringify(pruned, { lineWidth: 0 });
}

function collectInstalledPackages(nodeModulesDir: string): { name: string; version: string; path: string }[] {
  const found: { name: string; version: string; path: string }[] = [];
  const visitPackage = (dir: string) => {
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      const { name, version } = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; version?: string };
      found.push({ name: name ?? "", version: version ?? "", path: dir });
    }
    const nested = join(dir, "node_modules");
    if (existsSync(nested)) visitModulesDir(nested);
  };
  const visitModulesDir = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const full = join(dir, ent.name);
      if (ent.name.startsWith("@")) {
        for (const scoped of readdirSync(full, { withFileTypes: true })) {
          if (scoped.isDirectory()) visitPackage(join(full, scoped.name));
        }
      } else {
        visitPackage(full);
      }
    }
  };
  if (existsSync(nodeModulesDir)) visitModulesDir(nodeModulesDir);
  return found;
}

/**
 * Precondition: nodeModulesDir was installed from lockfile with STAGED_INSTALL_ARGS.
 * Postcondition: returns normally when every package.json under nodeModulesDir, including nested node_modules, names a
 * package and version present in the lockfile's snapshots.
 * Throws listing every package whose version is not in the lockfile.
 */
export function assertInstalledMatchesLockfile(nodeModulesDir: string, lockfile: string): void {
  const lock = parseLockfile(lockfile);
  const locked = new Set(Object.keys(lock.snapshots).map(packageKeyOf));
  const strays = collectInstalledPackages(nodeModulesDir)
    .filter(({ name, version }) => !locked.has(`${name}@${version}`))
    .map(({ name, version, path }) => `${name}@${version} (${path})`);
  if (strays.length > 0) {
    throw new Error(`Installed packages missing from the staged pnpm-lock.yaml:\n  ${strays.join("\n  ")}`);
  }
}

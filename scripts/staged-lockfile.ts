// Pins the staged desktop daemon to the root pnpm-lock.yaml so an installer ships exactly the dependency tree CI tested.
// Invariant: staging never resolves a version range; every installed package comes from the root lockfile with its integrity hash.

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

/**
 * Precondition: rootLockfile is the text of a lockfileVersion 9.0 pnpm-lock.yaml, and each key of dependencies is a
 * dependency of the root importer whose specifier equals the given value.
 * Postcondition: returns lockfile text with a single importer that lists exactly those dependencies at the root's resolved
 * versions, with `packages` and `snapshots` limited to their transitive closure, including optional dependencies of every platform.
 * Throws when a dependency is missing from the root importer, its specifier differs, or a referenced snapshot is absent.
 */
export function pruneLockfile(rootLockfile: string, dependencies: Readonly<Record<string, string>>): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: nodeModulesDir was installed from lockfile with STAGED_INSTALL_ARGS.
 * Postcondition: returns normally when every package.json under nodeModulesDir, including nested node_modules, names a
 * package and version present in the lockfile's snapshots.
 * Throws listing every package whose version is not in the lockfile.
 */
export function assertInstalledMatchesLockfile(nodeModulesDir: string, lockfile: string): void {
  throw new Error("Not implemented");
}

import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** The real path of the longest existing prefix plus the rest, lowercased, so symlinks and case cannot hide a match. */
export function canonicalPath(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  for (;;) {
    const stat = lstatSync(existing, { throwIfNoEntry: false });
    if (stat !== undefined) return join(realpathSync.native(existing), ...rest).toLowerCase();
    rest.unshift(existing.slice(dirname(existing).length).replace(/^[\\/]/, ""));
    existing = dirname(existing);
  }
}

export function isInsideBench(path: string, root: string): boolean {
  return isWithin(canonicalPath(path), canonicalPath(root));
}

export function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep) && !/^[a-z]:/i.test(rel));
}

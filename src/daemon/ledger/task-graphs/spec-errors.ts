// Invariant: every Zod schema rejection on graph create or patch JSON names the exact field path,
// expected type or unrecognized key, and closest allowed key suggestion when applicable.

import type { z } from "zod";

export type GraphSpecKind = "create" | "patch";

/**
 * Precondition: issues is a non-empty array from Zod's safeParse failure on a strict graph create or patch schema.
 * Postcondition: returns a multi-line Chinese diagnostic naming each offending path (for example `steps[0].no_outer_sandbox`),
 * the reason (unknown key with closest allowed key suggestion, wrong type, or missing field), and a final no-effect note for patch.
 */
export function formatGraphSpecIssues(_kind: GraphSpecKind, _issues: readonly z.core.$ZodIssue[]): string {
  throw new Error("Not implemented");
}

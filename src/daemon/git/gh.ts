// Invariant: callers pass secrets only through `env`, never through `args`, so tokens stay out of process listings and error text.

export type GhRunResult =
  | { kind: "ok"; stdout: string }
  | { kind: "failed"; code: string | number | null; stderr: string; timedOut: boolean; missing: boolean };

export interface GhRunOptions {
  timeoutMs: number;
  /** Extra variables merged over the daemon's environment, such as GH_TOKEN for a chosen account. */
  env?: Readonly<Record<string, string>>;
}

/**
 * Runs `gh` with prompts and update notices off, resolving the executable through PATHEXT and the cmd shim on Windows.
 * Postcondition: never rejects; a missing executable reports `missing: true`, a timeout reports `timedOut: true`,
 * and synchronous spawn errors such as EPERM report `failed`.
 */
export function execGh(cwd: string, args: readonly string[], options: GhRunOptions): Promise<GhRunResult> {
  throw new Error("Not implemented");
}

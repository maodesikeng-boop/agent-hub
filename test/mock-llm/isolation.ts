// Invariant: isolated homes never overlap the user's real HOME, never inherit real vendor credentials, and blackhole non-loopback proxies.
import type { IsolatedHomeConfig } from "./types.ts";

/**
 * Precondition: candidateHome is a non-empty filesystem path; realHome defaults to os.homedir().
 * Postcondition: returns normally only when candidateHome is strictly outside realHome and outside every real vendor config directory; otherwise throws an Error.
 */
export function assertIsolatedHome(_candidateHome: string, _realHome?: string): void {
  throw new Error("Not implemented");
}

/**
 * Precondition: homeDir passes assertIsolatedHome.
 * Postcondition: returns a clean child environment containing HOME/USERPROFILE/XDG/TMP overrides, loopback proxy blackhole vars, and zero real vendor credential or parent-session env vars.
 */
export function buildIsolatedEnv(_input: {
  homeDir: string;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  vendorEnv?: Readonly<Record<string, string>>;
  platform?: NodeJS.Platform;
}): Record<string, string> {
  throw new Error("Not implemented");
}

/**
 * Precondition: optional root does not overlap realHome.
 * Postcondition: creates a fresh temporary root with isolated homeDir, dataDir, and workDir and returns an IsolatedHomeConfig whose cleanup() removes the temp tree.
 */
export function createIsolatedHome(_options?: {
  prefix?: string;
  root?: string;
  realHome?: string;
}): IsolatedHomeConfig {
  throw new Error("Not implemented");
}

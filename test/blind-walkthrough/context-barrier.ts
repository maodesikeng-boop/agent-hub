// Invariant: no repository path, source identifier, UI test selector, or production credential ever crosses into the blind agent.
import type { SanitizedA11yNode } from "./types.ts";

export interface PromptCleanOptions {
  readonly repoRoot: string;
  readonly worktreeRoot?: string;
  readonly forbiddenTerms?: readonly string[];
}

export interface PromptLeakViolation {
  readonly rule: string;
  readonly match: string;
}

export interface RawA11yNode {
  readonly role?: string;
  readonly name?: string;
  readonly value?: string;
  readonly disabled?: boolean;
  readonly expanded?: boolean;
  readonly focused?: boolean;
  readonly testId?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly children?: readonly RawA11yNode[];
}

export interface IsolationCheckOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly userHome?: string;
  readonly platform?: NodeJS.Platform;
}

/**
 * Precondition: targetDir is the candidate workspace or temp directory the walkthrough tool wants to create or delete.
 * Postcondition: returns cleanly only when targetDir does not overlap ~/.agent-hub or env AGENT_HUB_HOME after symlink resolution; otherwise throws Error.
 */
export function assertIsolatedWorkspace(_targetDir: string, _options?: IsolationCheckOptions): void {
  throw new Error("Not implemented");
}

/**
 * Precondition: text is any system prompt, mission brief, or observation string about to be sent to the blind agent.
 * Postcondition: returns an empty array when no repository path, source identifier, or internal selector leaks; otherwise returns every matched violation.
 */
export function scanBlindPromptLeaks(_text: string, _options: PromptCleanOptions): readonly PromptLeakViolation[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: text is any prompt or observation destined for the blind agent.
 * Postcondition: returns cleanly when scanBlindPromptLeaks finds zero violations; otherwise throws Error naming all violations.
 */
export function assertBlindPromptClean(_text: string, _options: PromptCleanOptions): void {
  throw new Error("Not implemented");
}

/**
 * Precondition: root is a raw accessibility tree snapshot captured from the browser.
 * Postcondition: strips data-testid and internal attributes, caps node count at BLIND_A11Y_MAX_NODES and serialized text at BLIND_A11Y_SNAPSHOT_MAX_CHARS.
 */
export function sanitizeAccessibilitySnapshot(_root: RawA11yNode | null): { readonly nodes: readonly SanitizedA11yNode[]; readonly text: string } {
  throw new Error("Not implemented");
}

/**
 * Precondition: blindHomeDir is an isolated empty directory outside the repository and production data directory.
 * Postcondition: returns a scrubbed environment containing no HUB_TOKEN, HUB_SOCK, AGENT_HUB_*, GitHub tokens, or SSH agent sockets,
 * while forwarding only explicit caller-approved credential keys from allowEnvKeys when provided.
 */
export function buildBlindAgentEnv(
  _baseEnv: Readonly<Record<string, string | undefined>>,
  _blindHomeDir: string,
  _platform?: NodeJS.Platform,
  _allowEnvKeys?: readonly string[],
): Record<string, string> {
  throw new Error("Not implemented");
}

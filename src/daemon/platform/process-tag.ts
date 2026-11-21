// Invariant: process tagging and reaping never target PID <= 1, the daemon itself, or processes owned by another user.
import type { SessionId } from "../../shared/domain.ts";

export interface TaggedProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly tag: string;
  readonly command: string;
}

export interface ListTaggedProcessesOptions {
  readonly platform?: NodeJS.Platform;
  readonly procRoot?: string;
  readonly ownPid?: number;
  readonly ownUid?: number;
}

export interface ReapTaggedProcessesOptions extends ListTaggedProcessesOptions {
  readonly killWaitMs?: number;
}

export interface ReapTaggedProcessesResult {
  readonly reapedPids: readonly number[];
  readonly survivingPids: readonly number[];
}

/**
 * Precondition: sessionId is a positive integer and nonce is a non-empty alphanumeric token.
 * Postcondition: returns a tag string carrying this session's token, appending to parentTag up to SESSION_TAG_MAX_DEPTH ancestors when present.
 */
export function makeSessionOwnerTag(sessionId: SessionId, nonce: string, parentTag?: string): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: envValue is the raw value of ENV_SESSION_OWNER_TAG and tag is a single session token.
 * Postcondition: returns true if and only if tag matches an exact comma-delimited token inside envValue.
 */
export function envContainsSessionTag(envValue: string, tag: string): boolean {
  throw new Error("Not implemented");
}

/**
 * Precondition: tag is a non-empty single session owner token (or prefix ending in ":").
 * Postcondition: returns same-user processes carrying tag via ps eww on darwin, /proc/<pid>/environ on linux, or empty array on win32 where Job Objects own descendants; excludes ownPid and PID <= 1.
 */
export async function listTaggedProcesses(
  tag: string,
  options?: ListTaggedProcessesOptions,
): Promise<TaggedProcessInfo[]> {
  throw new Error("Not implemented");
}

/**
 * Precondition: tag identifies a retired or ending session whose children should no longer run.
 * Postcondition: SIGSTOPs and SIGKILLs all matching processes and their non-daemon process groups, waits up to killWaitMs, and reports reaped and surviving PIDs.
 */
export async function reapTaggedProcesses(
  tag: string,
  options?: ReapTaggedProcessesOptions,
): Promise<ReapTaggedProcessesResult> {
  throw new Error("Not implemented");
}

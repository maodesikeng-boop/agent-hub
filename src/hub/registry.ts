// Invariant: every hub CLI command (HUB_COMMANDS, self-reload, and dispatch) has one metadata entry in HUB_CLI_REGISTRY,
// and progressive help, scoped usage, and CLI diagnostic suggestions derive from this registry only.

import type { AgentRole } from "../shared/domain.ts";
import type { HubCommand } from "../shared/hub.ts";

export type HubCommandCategory = "core" | "project" | "persona" | "worker" | "ask" | "schedule" | "graph" | "router" | "dispatch";

export type HubCliCommandId = HubCommand | "caps" | "self.reload" | `dispatch.${string}`;

export interface HubCliEntry {
  readonly id: HubCliCommandId;
  readonly category: HubCommandCategory;
  readonly group: string;
  readonly action?: string;
  readonly cli: string;
  readonly summary: string;
  readonly usage: string;
  readonly allowedFlags: readonly string[];
  readonly minPositionals: number;
  readonly maxPositionals: number | null;
  readonly positionalHint?: string;
  readonly roles: readonly AgentRole[];
  readonly helpOnly?: boolean;
}

export type HelpResolution =
  | { kind: "index" }
  | { kind: "all" }
  | { kind: "graph-manual" }
  | { kind: "entries"; entries: readonly HubCliEntry[]; scopeLabel: string }
  | { kind: "unknown"; query: string; suggestions: readonly string[] };

/**
 * Single metadata table for every hub CLI command.
 * Populated during implementation; empty in the planning skeleton so unimplemented checks fail cleanly.
 */
export const HUB_CLI_REGISTRY: readonly HubCliEntry[] = [];

/**
 * Precondition: argv is the raw argument vector passed to hub.
 * Postcondition: returns null when argv is not a help request; otherwise classifies bare `hub help`, `hub help --all`,
 * `hub help graph` (manual), scoped `hub help <group> [<action>]` or `<cmd> --help`/`-h`, or an unknown help target with suggestions.
 */
export function resolveHelpTarget(_argv: readonly string[]): HelpResolution | null {
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns a compact grouped command index suitable for bare `hub help` (under 4 KB)
 * that lists every non-dispatch group, one-line summaries, drill-down hints, and the shared stdin shell note.
 */
export function renderHelpIndex(): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: entries is non-empty.
 * Postcondition: renders usage lines and applicable HUB_LIMITS lines only for the given entries,
 * followed by a concise pointer to full help.
 */
export function renderScopedHelp(_entries: readonly HubCliEntry[]): string {
  throw new Error("Not implemented");
}

/**
 * Postcondition: renders the complete expanded usage reference for `hub help --all` and static guards,
 * including every command's usage, HUB_LIMITS line, self-reload, help graph pointer, and stdin shell examples.
 */
export function renderFullHelp(): string {
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns up to HUB_ERROR_SUGGESTIONS_MAX closest command or action names for a mistyped token,
 * ordered by edit distance; returns an empty array when no candidate is close.
 */
export function suggestSubcommands(_group: string | undefined, _token: string): string[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: allowedFlags lists flag names without leading `--`.
 * Postcondition: returns up to HUB_ERROR_SUGGESTIONS_MAX closest `--<flag>` suggestions for an unknown flag token.
 */
export function suggestFlags(_rawFlag: string, _allowedFlags: readonly string[]): string[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: group matches a known command group with named actions.
 * Postcondition: returns a Chinese error listing the group's valid actions instead of saying the group is unknown.
 */
export function formatMissingActionError(_group: string): string {
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns a Chinese error naming the command, expected positional count (or range), actual count,
 * and optional positional hint.
 */
export function formatPositionalCountError(
  _cli: string,
  _expected: { min: number; max: number | null; hint?: string },
  _actual: number,
): string {
  throw new Error("Not implemented");
}

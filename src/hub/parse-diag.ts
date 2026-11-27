// Invariant: parses `hub diag bug-hunt` CLI arguments without POSIX-only assumptions or system-prompt changes.
import type { GroupArgs, Parsed } from "./args.ts";

/**
 * Precondition: args.group === "diag".
 * Postcondition: parses `hub diag bug-hunt [--since <24h|7d>] [--dry-run] [--run-key <key>] [--ack <fp> | --mute <fp> [--reason <text>] | --fix <fp> [--commit <sha>]] [--json]` into a validated Parsed command or throws UsageError.
 */
export function parseDiagCommand(_args: GroupArgs): Parsed {
  throw new Error("Not implemented");
}

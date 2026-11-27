// Invariant: normalized snapshots strip volatile paths, ports, UUIDs, and timestamps and stay bounded by MOCK_LLM_SNAPSHOT_MAX_BYTES.
import type { DriverEvent } from "../../src/shared/index.ts";
import type { JsonSchemaTreeDiff, NormalizedDriverEvent, NormalizedModelContext, RecordedLlmRequest } from "./types.ts";

/**
 * Precondition: text is any string and replacements maps concrete volatile substrings (such as temp paths) to stable tokens.
 * Postcondition: returns deterministic text with custom replacements, UUIDs, ISO timestamps, and loopback ports normalized.
 */
export function normalizeVolatileText(
  _text: string,
  _replacements?: Readonly<Record<string, string>>,
): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: request is a recorded mock LLM request.
 * Postcondition: extracts a bounded, deterministic representation of model-visible system text, sorted tool names, and messages across all four open dialects without throwing on malformed bodies.
 */
export function normalizeModelContext(
  _request: RecordedLlmRequest,
  _options?: { replacements?: Readonly<Record<string, string>> },
): NormalizedModelContext {
  throw new Error("Not implemented");
}

/**
 * Precondition: events is an ordered list of Bellwood DriverEvent objects.
 * Postcondition: returns deterministic event shape summaries with volatile IDs and timestamps stripped.
 */
export function normalizeDriverEvents(
  _events: readonly DriverEvent[],
  _options?: { replacements?: Readonly<Record<string, string>> },
): readonly NormalizedDriverEvent[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: baselineDir and currentDir are readable directories containing JSON schema files.
 * Postcondition: returns sorted lists of added, removed, and structurally changed JSON schema file paths relative to each root.
 */
export function diffJsonSchemaTrees(_baselineDir: string, _currentDir: string): JsonSchemaTreeDiff {
  throw new Error("Not implemented");
}

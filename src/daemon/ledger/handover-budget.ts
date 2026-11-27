// Invariant: assembled handover preambles never exceed the remaining single-message UTF-8 byte budget after reserving the latest turn payload, never emit lone UTF-16 surrogates, and trim history oldest-first.

export type LoadedSkillSource = "user" | "model";

export interface SkillIndexEntry {
  readonly name: string;
  readonly path: string;
  readonly source: LoadedSkillSource;
  readonly description: string | null;
}

export interface MissingSkillEntry {
  readonly name: string;
  readonly path: string;
}

export interface SkillIndexInput {
  readonly available: readonly SkillIndexEntry[];
  readonly missing: readonly MissingSkillEntry[];
}

export interface HandoverPreambleSections {
  readonly header: string;
  readonly skillsIndex: string | null;
  readonly summaryHeading: string;
  readonly summaryBody: string | null;
  readonly historyHeading: string;
  readonly historyEntriesNewestFirst: readonly string[];
  readonly historyEmptyText: string;
  readonly historyTruncatedHint: string;
  readonly reportsHeading?: string;
  readonly reports?: readonly string[];
  readonly pendingAsksSection: string | null;
  readonly agendaSection: string | null;
}

export interface PreambleBudgetOptions {
  readonly vendor: string;
  readonly reservedBytes?: number;
  readonly maxSingleMessageBytes?: number;
  readonly summaryMaxBytes?: number;
  readonly historyMaxBytes?: number;
  readonly liveStateMaxBytes?: number;
  readonly reportsMaxBytes?: number;
}

export interface BudgetedPreambleResult {
  readonly text: string | null;
  readonly totalBytes: number;
  readonly budgetBytes: number;
  readonly historyTruncated: boolean;
  readonly summaryTruncated: boolean;
  readonly liveStateTruncated: boolean;
  readonly skillsOmitted: boolean;
}

export interface TurnReservedParts {
  readonly text: string;
  readonly prefixes?: readonly string[];
  readonly systemPrompt?: string | null;
  readonly deliverySuffix?: string | null;
}

/**
 * Precondition: maxBytes is a finite number; values <= 0 yield an empty string.
 * Postcondition: returns the longest prefix of text whose UTF-8 byte length is <= maxBytes with no lone UTF-16 surrogates.
 */
export function sliceUtf8HeadSafe(_text: string, _maxBytes: number): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: maxBytes is a finite number; values <= 0 yield an empty string.
 * Postcondition: returns the longest suffix of text whose UTF-8 byte length is <= maxBytes with no lone UTF-16 surrogates.
 */
export function sliceUtf8TailSafe(_text: string, _maxBytes: number): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: markdown is the head slice of a SKILL.md file (may contain BOM, CRLF, or malformed frontmatter).
 * Postcondition: returns a single-line description capped at SKILL_CARRYOVER_DESCRIPTION_MAX_CHARS, or null when missing or empty.
 */
export function extractSkillDescription(_markdown: string): string | null {
  throw new Error("Not implemented");
}

/**
 * Precondition: input.available is ordered most-recently-loaded first; maxBytes defaults to SKILL_CARRYOVER_INDEX_MAX_BYTES.
 * Postcondition: returns a compact index section with zero full skill bodies and UTF-8 byte length <= maxBytes, or null when empty or when the heading does not fit.
 */
export function renderLoadedSkillsIndex(_input: SkillIndexInput, _maxBytes?: number): string | null {
  throw new Error("Not implemented");
}

/**
 * Precondition: vendor is any vendor id string; non-finite or negative reservedBytes are treated as 0.
 * Postcondition: returns Math.max(0, effectiveCap - normalizedReserved) using maxSingleMessageBytes or handoverMaxSingleMessageBytesOf(vendor).
 */
export function computePreambleByteBudget(_vendor: string, _reservedBytes?: number, _maxSingleMessageBytes?: number): number {
  throw new Error("Not implemented");
}

/**
 * Precondition: parts lists all non-preamble strings committed to the first turn sent to the vendor.
 * Postcondition: returns the UTF-8 byte total of all non-preamble text plus inter-block framing overhead.
 */
export function measureTurnReservedBytes(_parts: TurnReservedParts): number {
  throw new Error("Not implemented");
}

/**
 * Precondition: sections.historyEntriesNewestFirst is ordered newest-first; options.reservedBytes accounts for all non-preamble turn bytes.
 * Postcondition: returns text === null when budgetBytes < HANDOVER_MIN_PREAMBLE_BYTES; otherwise returns valid UTF-8/UTF-16 text <= budgetBytes preserving Priority 1 (header and live state) before Priority 2 (summary, skill index, reports) and trimming Priority 3 (history) oldest-first.
 */
export function assembleBudgetedPreamble(
  _sections: HandoverPreambleSections,
  _options: PreambleBudgetOptions,
): BudgetedPreambleResult {
  throw new Error("Not implemented");
}

/**
 * Precondition: legacyPreamble was pre-baked by an older version before upgrade; liveSections hold live asks and agenda.
 * Postcondition: returns text === null when budgetBytes < HANDOVER_MIN_PREAMBLE_BYTES; otherwise preserves liveSections first and fits legacyPreamble inside remaining bytes with no lone surrogates.
 */
export function fitLegacyPreambleToBudget(
  _legacyPreamble: string,
  _liveSections: readonly string[],
  _options: PreambleBudgetOptions,
): BudgetedPreambleResult {
  throw new Error("Not implemented");
}

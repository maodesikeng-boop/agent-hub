// Invariant: every path stored or returned is a repo-relative POSIX path, and any ambiguous syntax, side effect, or config change fails closed rather than omitting an affected test.

export const ENV_TEST_MAX_WORKERS = "BELLWOOD_TEST_MAX_WORKERS";

export interface VitestProjectSpec {
  readonly name: string;
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
  readonly setupFiles?: readonly string[];
}

export interface ModuleImportEdge {
  readonly target: string;
  readonly imported: string | "*";
  readonly local: string | null;
}

export interface ModuleReexportEdge {
  readonly target: string;
  readonly exported: string | "*";
  readonly imported: string | "*";
}

export interface ModuleSummary {
  readonly file: string;
  readonly imports: readonly ModuleImportEdge[];
  readonly reexports: readonly ModuleReexportEdge[];
  readonly localDecls: ReadonlyMap<string, ReadonlySet<string>>;
  readonly exportedLocals: ReadonlyMap<string, string>;
  readonly topLevelSideEffectRefs: ReadonlySet<string>;
  readonly parseFailed: boolean;
}

export type ExportChangeSet =
  | { readonly kind: "none" }
  | { readonly kind: "symbols"; readonly symbols: readonly string[] }
  | { readonly kind: "all"; readonly reason: string };

export interface AffectedReason {
  readonly changedFile: string;
  readonly symbol: string | "*";
  readonly path: readonly string[];
}

export interface ResolveAffectedInput {
  readonly repoRoot: string;
  readonly baseRef: string;
  readonly changedFiles: readonly string[];
  readonly projects: readonly VitestProjectSpec[];
  readonly alwaysRunTests: readonly string[];
  readonly sources: ReadonlyMap<string, string>;
  readonly readBaseFile: (repoRelativePath: string) => string | undefined;
  readonly platform?: NodeJS.Platform;
}

export interface AffectedTestsResult {
  readonly fullSuite: boolean;
  readonly fullSuiteReason?: string;
  readonly linkedByPath: readonly string[];
  readonly testFiles: readonly string[];
  readonly totalTestFiles: number;
  readonly reasons: ReadonlyMap<string, readonly AffectedReason[]>;
}

export interface LocalConcurrencyInput {
  readonly vitestArgs: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cpuCount: number;
  readonly testFileCount: number;
  readonly maxWorkersCap: number;
}

export interface LocalConcurrencyPlan {
  readonly maxWorkers: number | undefined;
  readonly source: "cli" | "env" | "ci" | "local-default";
  readonly extraArgs: readonly string[];
}

export interface ParsedTestRelatedArgs {
  readonly base: string;
  readonly dryRun: boolean;
  readonly explain: boolean;
  readonly vitestArgs: readonly string[];
}

/**
 * Precondition: `repoRoot` contains `vitest.config.ts`.
 * Postcondition: returns the active Vitest project definitions (`name`, `include`, `exclude`, `setupFiles`) derived directly from `vitest.config.ts`.
 */
export async function loadVitestProjectSpecs(_repoRoot: string): Promise<VitestProjectSpec[]> {
  throw new Error("Not implemented");
}

/**
 * Precondition: `file` is a repo-relative POSIX path and `knownFiles` contains all discoverable repo-relative POSIX module paths.
 * Postcondition: parses `source` into runtime static import edges, re-export edges, whole-file fail-closed edges (`imported: "*"`, `local: null`) for runtime dynamic `import("./...")` (`ImportExpression`, including `vi.mock(import("./..."))`) and relative string-literal `vi.mock`, `vi.doMock`, `vi.unmock`, `vi.importActual`, and `vi.importMock` calls, intra-file top-level declaration references (including JSX identifiers and excluding TypeScript type-only syntax and `TSImportType`), and top-level side-effect references; sets `parseFailed: true` on syntax error instead of throwing.
 */
export function analyzeModuleSource(_file: string, _source: string, _knownFiles: ReadonlySet<string>): ModuleSummary {
  throw new Error("Not implemented");
}

/**
 * Precondition: `file` is a repo-relative POSIX path; `oldSource` is the base-ref content (or `undefined` for added files) and `newSource` is the working-tree content (or `undefined` for deleted files).
 * Postcondition: returns `{ kind: "none" }` for comment, formatting, or type-only edits; `{ kind: "symbols", symbols }` when only specific exported or re-exported bindings changed (including intra-file dependents and shared mutable state); or `{ kind: "all", reason }` on added, deleted, unparseable, `export *`, or top-level side-effect changes.
 */
export function diffChangedExports(
  _file: string,
  _oldSource: string | undefined,
  _newSource: string | undefined,
  _knownFiles: ReadonlySet<string>,
): ExportChangeSet {
  throw new Error("Not implemented");
}

/**
 * Precondition: `input.projects` reflects the repository's Vitest project globs and `setupFiles`, and `input.sources` maps repo-relative POSIX code paths to current source text.
 * Postcondition: returns `fullSuite: true` for config triggers, or the sorted deduplicated list of affected test files matching the active platform's project globs plus `alwaysRunTests`, traversing barrels and `setupFiles` at symbol granularity, treating dynamic `import("./...")` and `vi.mock`/`vi.doMock`/`vi.unmock`/`vi.importActual`/`vi.importMock` targets as fail-closed whole-file dependencies, bridging dynamic vendor loaders, and recording shortest causal `reasons`.
 */
export function resolveAffectedTests(_input: ResolveAffectedInput): AffectedTestsResult {
  throw new Error("Not implemented");
}

/**
 * Precondition: `input.cpuCount >= 1`, `input.testFileCount >= 0`, and `input.maxWorkersCap >= 1`.
 * Postcondition: honors explicit CLI worker flags first, then `BELLWOOD_TEST_MAX_WORKERS` (throwing `RangeError` on invalid values), leaves CI uncapped when `env.CI` is truthy, and otherwise caps local workers to `clamp(floor(cpuCount / 2), 1, min(maxWorkersCap, max(1, testFileCount)))`.
 */
export function resolveLocalConcurrency(_input: LocalConcurrencyInput): LocalConcurrencyPlan {
  throw new Error("Not implemented");
}

/**
 * Precondition: `argv` is the CLI argument slice after the script path.
 * Postcondition: extracts `--base <ref>`, `--dry-run`, and `--explain`, forwarding all other flags to `vitestArgs`; throws on missing `--base` value.
 */
export function parseTestRelatedArgs(_argv: readonly string[], _defaultBase?: string): ParsedTestRelatedArgs {
  throw new Error("Not implemented");
}

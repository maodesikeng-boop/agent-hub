// Invariant: every path stored or returned is a repo-relative POSIX path, and any ambiguous syntax, side effect, or config change fails closed rather than omitting an affected test.
import { posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  analyzeModuleSource,
  diffChangedExports,
  expandDirtyLocals,
  extractModuleEdges,
  toRepoPosixPath,
} from "./related-graph-ast.ts";

export { analyzeModuleSource, diffChangedExports };

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
  readonly fileDeps: readonly string[];
  readonly localDecls: ReadonlyMap<string, ReadonlySet<string>>;
  readonly exportedLocals: ReadonlyMap<string, string>;
  readonly topLevelSideEffectRefs: ReadonlySet<string>;
  readonly parseFailed: boolean;
}

export interface ScopedSourceGuard {
  readonly testFile: string;
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
}

// Guards that scan a directory or template-constructed list of source files instead of importing every symbol they inspect.
export const SCOPED_SOURCE_GUARDS: readonly ScopedSourceGuard[] = [
  {
    testFile: "src/daemon/platform/win32.test.ts",
    include: ["src/**/*.ts", "src/**/*.tsx"],
    exclude: ["**/*.test.ts", "**/*.test.tsx"],
  },
  {
    testFile: "src/web/card-corners.test.tsx",
    include: ["src/web/**/*.ts", "src/web/**/*.tsx"],
    exclude: ["**/*.test.ts", "**/*.test.tsx"],
  },
  {
    testFile: "src/web/info-style.test.tsx",
    include: ["src/web/**/*.tsx"],
    exclude: ["**/*.test.tsx"],
  },
  {
    testFile: "src/web/lib/palette.test.ts",
    include: ["src/web/**/*.tsx"],
    exclude: ["**/*.test.tsx"],
  },
  {
    testFile: "src/web/ui/icons.test.ts",
    include: ["src/web/**/*.ts", "src/web/**/*.tsx"],
    exclude: ["**/*.test.ts", "**/*.test.tsx"],
  },
  {
    testFile: "src/web/ui-scale.test.tsx",
    include: ["src/web/components/**/*.tsx", "src/web/ui/**/*.tsx"],
    exclude: ["**/*.test.tsx"],
  },
  {
    testFile: "src/web/ui/ui-standard.test.tsx",
    include: ["src/web/components/**/*.tsx", "src/web/ui/**/*.tsx", "src/web/main.tsx"],
    exclude: ["**/*.test.tsx"],
  },
  {
    testFile: "src/web/motion.test.tsx",
    include: ["src/web/components/Conversation.tsx", "src/web/components/WorkerConversation.tsx"],
  },
  {
    testFile: "src/web/charts.test.tsx",
    include: [
      "src/web/components/Markdown.tsx",
      "src/web/components/CodeBlock.tsx",
      "src/web/components/ChartBlock.tsx",
      "src/web/charts/registry.ts",
      "src/web/charts/cache.ts",
      "src/web/charts/remark-chart-blocks.ts",
      "src/web/charts/theme.ts",
    ],
  },
  {
    testFile: "scripts/related-graph-followups.test.ts",
    include: ["**/*.test.ts", "**/*.test.tsx"],
  },
];

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
  readonly scopedGuards?: readonly ScopedSourceGuard[];
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

const DEFAULT_BASE = "origin/main";
const MODULE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.tsx?$/;
const MANIFEST_OR_LOCKFILE_NAMES = new Set(["package.json", "pnpm-lock.yaml"]);
const CONFIG_TRIGGER = /(?:^|\/)(?:vitest(?:\.[^/]+)?\.config\.[cm]?[jt]s|vite(?:\.[^/]+)?\.config\.[cm]?[jt]s|tsconfig(?:\.[^/]+)?\.json)$/;
const VENDOR_DAEMON_FILE = /^src\/vendors\/[^_/][^/]*\/daemon\.ts$/;
const VENDOR_PATHS_FILE = /^src\/vendors\/[^_/][^/]*\/paths\.ts$/;
const CLI_WORKER_FLAG = /^--(maxWorkers|max-workers)(?:=|$)|^--no-file-parallelism$|^--(fileParallelism|file-parallelism)=false$|^--single-thread$/;
const POSITIVE_INT = /^[1-9]\d*$/;

export function referenceNeedles(file: string): string[] {
  const normalized = toRepoPosixPath(file);
  if (MODULE_FILE.test(normalized)) return [];
  const dir = posix.dirname(normalized);
  // Prompts and fixtures mention Markdown files as prose, so only an exact path below the root counts.
  if (normalized.endsWith(".md")) return dir === "." ? [] : [normalized];
  if (dir === ".") return [normalized];
  return [normalized, `${dir}/`];
}

function isManifestOrLockfile(file: string): boolean {
  return MANIFEST_OR_LOCKFILE_NAMES.has(posix.basename(toRepoPosixPath(file)));
}

function matchesReferenceTarget(changedFile: string, candidatePath: string): boolean {
  if (changedFile.endsWith(".md")) return TEST_FILE.test(candidatePath);
  // Root manifests and lockfiles link only to tests and scripts so literal "package.json" in src/ runtime code does not fan out across unrelated suites.
  if (isManifestOrLockfile(changedFile)) return TEST_FILE.test(candidatePath) || candidatePath.startsWith("scripts/");
  return true;
}

export function findReferencingFiles(changed: readonly string[], sources: ReadonlyMap<string, string>): string[] {
  const hits = new Set<string>();
  for (const rawFile of changed) {
    const file = toRepoPosixPath(rawFile);
    const needles = referenceNeedles(file);
    if (needles.length === 0) continue;
    for (const [path, text] of sources) {
      if (path === file || !matchesReferenceTarget(file, path)) continue;
      if (needles.some((needle) => text.includes(needle))) hits.add(path);
    }
  }
  return [...hits].sort();
}

function globToRegExp(pattern: string): RegExp {
  const normalized = toRepoPosixPath(pattern);
  let out = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    if (ch === "*" && normalized[i + 1] === "*") {
      if (normalized[i + 2] === "/") {
        out += "(?:.+/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
      continue;
    }
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (ch === "{") {
      const close = normalized.indexOf("}", i + 1);
      if (close !== -1) {
        const parts = normalized
          .slice(i + 1, close)
          .split(",")
          .map((part) => part.replace(/[.+^$|()[\]\\]/g, "\\$&"));
        out += `(?:${parts.join("|")})`;
        i = close;
      } else {
        out += "\\{";
      }
    } else if (".+^$|()[]\\".includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return new RegExp(`${out}$`);
}

export async function loadVitestProjectSpecs(repoRoot: string, platform?: NodeJS.Platform): Promise<VitestProjectSpec[]> {
  const baseUrl = pathToFileURL(resolve(repoRoot, "vitest.config.ts")).href;
  let loaded: { default?: unknown };
  if (platform !== undefined && platform !== process.platform) {
    // Load vitest/config under the host platform first so native rolldown bindings resolve before swapping process.platform.
    await import("vitest/config");
    const desc = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { ...desc, value: platform });
    try {
      loaded = (await import(`${baseUrl}?platform=${platform}`)) as { default?: unknown };
    } finally {
      if (desc) Object.defineProperty(process, "platform", desc);
    }
  } else {
    loaded = (await import(baseUrl)) as { default?: unknown };
  }
  const rawConfig =
    typeof loaded.default === "function"
      ? await (loaded.default as (env: { command: string; mode: string }) => unknown)({ command: "serve", mode: "test" })
      : loaded.default;
  const testConfig = (rawConfig as { test?: { projects?: unknown[]; include?: string[]; exclude?: string[]; setupFiles?: string | string[] } } | undefined)?.test;
  if (!testConfig) throw new Error("vitest.config.ts did not export a test configuration");

  const normalizeList = (value: unknown): string[] | undefined => {
    if (typeof value === "string") return [toRepoPosixPath(value)];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").map(toRepoPosixPath);
    return undefined;
  };

  if (Array.isArray(testConfig.projects) && testConfig.projects.length > 0) {
    return testConfig.projects.map((entry, idx) => {
      const cfg = ((entry as { test?: Record<string, unknown> }).test ?? entry) as Record<string, unknown>;
      return {
        name: typeof cfg.name === "string" ? cfg.name : `project-${idx}`,
        include: normalizeList(cfg.include) ?? [],
        exclude: normalizeList(cfg.exclude),
        setupFiles: normalizeList(cfg.setupFiles),
      };
    });
  }

  return [
    {
      name: "default",
      include: normalizeList(testConfig.include) ?? ["**/*.test.{ts,tsx}"],
      exclude: normalizeList(testConfig.exclude),
      setupFiles: normalizeList(testConfig.setupFiles),
    },
  ];
}

interface ReverseEdge {
  readonly consumer: string;
  readonly kind: "import" | "reexport" | "vendor-bridge";
  readonly imported: string | "*";
  readonly exported?: string | "*";
  readonly local: string | null;
}

interface QueueItem {
  readonly file: string;
  readonly symbol: string | "*";
  readonly rootFile: string;
  readonly rootSymbol: string | "*";
  readonly path: readonly string[];
}

function buildProjectIndex(
  projects: readonly VitestProjectSpec[],
  sourceFiles: Iterable<string>,
): {
  projectTests: Map<string, string[]>;
  allTestFiles: Set<string>;
  setupFileToProjects: Map<string, string[]>;
} {
  const compiled = projects.map((project) => ({
    name: project.name,
    include: project.include.map(globToRegExp),
    exclude: (project.exclude ?? []).map(globToRegExp),
    setupFiles: (project.setupFiles ?? []).map(toRepoPosixPath),
  }));

  const projectTests = new Map<string, string[]>(compiled.map((p) => [p.name, []]));
  const allTestFiles = new Set<string>();
  const setupFileToProjects = new Map<string, string[]>();

  for (const project of compiled) {
    for (const setup of project.setupFiles) {
      let list = setupFileToProjects.get(setup);
      if (!list) {
        list = [];
        setupFileToProjects.set(setup, list);
      }
      list.push(project.name);
    }
  }

  for (const file of sourceFiles) {
    for (const project of compiled) {
      if (project.include.some((re) => re.test(file)) && !project.exclude.some((re) => re.test(file))) {
        projectTests.get(project.name)!.push(file);
        allTestFiles.add(file);
      }
    }
  }
  for (const list of projectTests.values()) list.sort();
  return { projectTests, allTestFiles, setupFileToProjects };
}

function buildReverseEdges(
  sources: ReadonlyMap<string, string>,
  knownFiles: ReadonlySet<string>,
): { reverse: Map<string, ReverseEdge[]>; directFileConsumers: Map<string, string[]> } {
  const reverse = new Map<string, ReverseEdge[]>();
  const directFileConsumers = new Map<string, string[]>();
  const push = (target: string, edge: ReverseEdge): void => {
    let list = reverse.get(target);
    if (!list) {
      list = [];
      reverse.set(target, list);
    }
    list.push(edge);
  };
  const pushFileDep = (target: string, consumer: string): void => {
    let list = directFileConsumers.get(target);
    if (!list) {
      list = [];
      directFileConsumers.set(target, list);
    }
    if (!list.includes(consumer)) list.push(consumer);
  };

  for (const [file, text] of sources) {
    const edges = extractModuleEdges(file, text, knownFiles);
    for (const imp of edges.imports) {
      push(imp.target, { consumer: file, kind: "import", imported: imp.imported, local: imp.local });
    }
    for (const reexp of edges.reexports) {
      push(reexp.target, { consumer: file, kind: "reexport", imported: reexp.imported, exported: reexp.exported, local: null });
    }
    for (const dep of edges.fileDeps) {
      pushFileDep(dep, file);
    }
    if (VENDOR_DAEMON_FILE.test(file) && sources.has("src/vendors/daemon-registry.ts")) {
      push(file, { consumer: "src/vendors/daemon-registry.ts", kind: "vendor-bridge", imported: "*", local: null });
    }
    if (VENDOR_PATHS_FILE.test(file) && sources.has("src/vendors/paths-registry.ts")) {
      push(file, { consumer: "src/vendors/paths-registry.ts", kind: "vendor-bridge", imported: "*", local: null });
    }
  }
  return { reverse, directFileConsumers };
}

function propagateEdge(
  cur: QueueItem,
  edge: ReverseEdge,
  allTestFiles: ReadonlySet<string>,
  setupFileToProjects: ReadonlyMap<string, readonly string[]>,
  summaryOf: (file: string) => ModuleSummary | undefined,
  enqueue: (item: QueueItem) => void,
): void {
  const nextPath = [...cur.path, edge.consumer];
  const emit = (symbol: string | "*"): void =>
    enqueue({ file: edge.consumer, symbol, rootFile: cur.rootFile, rootSymbol: cur.rootSymbol, path: nextPath });

  if (edge.kind === "vendor-bridge") {
    emit("*");
    return;
  }

  // A module-evaluation side effect (`*`) executes whenever any static importer or re-exporter loads this module.
  if (cur.symbol === "*") {
    emit("*");
    return;
  }

  if (edge.kind === "reexport") {
    if (edge.exported === "*" && edge.imported === "*") {
      // `export *` never forwards `default` in ESM.
      if (cur.symbol !== "default") emit(cur.symbol);
    } else if (edge.imported === "*" || cur.symbol === edge.imported) {
      emit(edge.exported ?? "*");
    }
    return;
  }

  if (!(edge.imported === "*" || edge.imported === cur.symbol)) return;
  if (edge.local === null || allTestFiles.has(edge.consumer) || setupFileToProjects.has(edge.consumer)) {
    emit("*");
    return;
  }

  const consumerSummary = summaryOf(edge.consumer);
  if (!consumerSummary || consumerSummary.parseFailed) {
    emit("*");
    return;
  }

  const dirty = expandDirtyLocals([edge.local], consumerSummary.localDecls);
  for (const ref of consumerSummary.topLevelSideEffectRefs) {
    if (dirty.has(ref)) {
      emit("*");
      return;
    }
  }
  for (const [expName, localName] of consumerSummary.exportedLocals) {
    if (dirty.has(localName)) emit(expName);
  }
}

export function resolveAffectedTests(input: ResolveAffectedInput): AffectedTestsResult {
  const changedFiles = [...new Set(input.changedFiles.map(toRepoPosixPath))].sort();
  const alwaysRun = input.alwaysRunTests.map(toRepoPosixPath);
  const sources = new Map<string, string>();
  for (const [rawPath, text] of input.sources) sources.set(toRepoPosixPath(rawPath), text);

  const { projectTests, allTestFiles, setupFileToProjects } = buildProjectIndex(input.projects, sources.keys());

  const configTrigger = changedFiles.find((file) => CONFIG_TRIGGER.test(file));
  if (configTrigger) {
    const reasons = new Map<string, AffectedReason[]>();
    const all = [...allTestFiles].sort();
    for (const testFile of all) reasons.set(testFile, [{ changedFile: configTrigger, symbol: "*", path: [configTrigger] }]);
    return {
      fullSuite: true,
      fullSuiteReason: `config file changed: ${configTrigger}`,
      linkedByPath: [],
      testFiles: all,
      totalTestFiles: allTestFiles.size,
      reasons,
    };
  }

  const linkedByPath = changedFiles.some((file) => referenceNeedles(file).length > 0)
    ? findReferencingFiles(changedFiles, sources)
    : [];

  const knownFiles = new Set<string>(sources.keys());
  for (const file of changedFiles) knownFiles.add(file);

  const { reverse, directFileConsumers } = buildReverseEdges(sources, knownFiles);
  const compiledScopedGuards = (input.scopedGuards ?? SCOPED_SOURCE_GUARDS)
    .filter((guard) => allTestFiles.has(toRepoPosixPath(guard.testFile)))
    .map((guard) => ({
      testFile: toRepoPosixPath(guard.testFile),
      include: guard.include.map(globToRegExp),
      exclude: (guard.exclude ?? []).map(globToRegExp),
    }));
  const summaryCache = new Map<string, ModuleSummary>();
  const summaryOf = (file: string): ModuleSummary | undefined => {
    const cached = summaryCache.get(file);
    if (cached) return cached;
    const text = sources.get(file);
    if (text === undefined) return undefined;
    const computed = analyzeModuleSource(file, text, knownFiles);
    summaryCache.set(file, computed);
    return computed;
  };

  const affected = new Set<string>();
  const reasons = new Map<string, AffectedReason[]>();
  const addReason = (testFile: string, reason: AffectedReason): void => {
    affected.add(testFile);
    let list = reasons.get(testFile);
    if (!list) {
      list = [];
      reasons.set(testFile, list);
    }
    const sig = `${reason.changedFile}\0${reason.symbol}\0${reason.path.join("->")}`;
    if (!list.some((r) => `${r.changedFile}\0${r.symbol}\0${r.path.join("->")}` === sig)) list.push(reason);
  };

  const queue: QueueItem[] = [];
  const visited = new Set<string>();
  const expandedSetupFiles = new Set<string>();
  const enqueue = (item: QueueItem): void => {
    if (visited.has(`${item.file}\0*`) || visited.has(`${item.file}\0${item.symbol}`)) return;
    visited.add(`${item.file}\0${item.symbol}`);
    queue.push(item);
  };

  for (const file of changedFiles) {
    for (const guard of compiledScopedGuards) {
      if (guard.include.some((re) => re.test(file)) && !guard.exclude.some((re) => re.test(file))) {
        addReason(guard.testFile, { changedFile: file, symbol: "*", path: [file, `source-guard:${guard.testFile}`] });
      }
    }
    const directConsumers = directFileConsumers.get(file);
    if (directConsumers) {
      for (const consumer of directConsumers) {
        enqueue({ file: consumer, symbol: "*", rootFile: file, rootSymbol: "*", path: [file, consumer] });
      }
    }
    if (!MODULE_FILE.test(file)) continue;
    if (allTestFiles.has(file)) addReason(file, { changedFile: file, symbol: "*", path: [file] });
    const diff = diffChangedExports(file, input.readBaseFile(file), sources.get(file), knownFiles);
    if (diff.kind === "all") {
      enqueue({ file, symbol: "*", rootFile: file, rootSymbol: "*", path: [file] });
    } else if (diff.kind === "symbols") {
      for (const symbol of diff.symbols) enqueue({ file, symbol, rootFile: file, rootSymbol: symbol, path: [file] });
    } else if (!allTestFiles.has(file)) {
      const stem = file.replace(MODULE_FILE, "");
      for (const testExt of [".test.ts", ".test.tsx"]) {
        const colocated = `${stem}${testExt}`;
        if (allTestFiles.has(colocated)) addReason(colocated, { changedFile: file, symbol: "*", path: [file, colocated] });
      }
    }
  }

  for (const linked of linkedByPath) {
    enqueue({ file: linked, symbol: "*", rootFile: linked, rootSymbol: "*", path: [linked] });
  }

  for (let head = 0; head < queue.length; head += 1) {
    const cur = queue[head]!;
    if (allTestFiles.has(cur.file)) {
      addReason(cur.file, { changedFile: cur.rootFile, symbol: cur.rootSymbol, path: cur.path });
    }

    const setupProjects = setupFileToProjects.get(cur.file);
    if (setupProjects && !expandedSetupFiles.has(cur.file)) {
      expandedSetupFiles.add(cur.file);
      for (const projectName of setupProjects) {
        for (const testFile of projectTests.get(projectName) ?? []) {
          addReason(testFile, {
            changedFile: cur.rootFile,
            symbol: cur.rootSymbol,
            path: [...cur.path, `setupFiles:${projectName}`],
          });
        }
      }
    }

    const edges = reverse.get(cur.file);
    if (!edges) continue;
    for (const edge of edges) {
      propagateEdge(cur, edge, allTestFiles, setupFileToProjects, summaryOf, enqueue);
    }
  }

  for (const guard of alwaysRun) {
    if (allTestFiles.has(guard) || !sources.has(guard)) affected.add(guard);
  }

  return {
    fullSuite: false,
    linkedByPath,
    testFiles: [...affected].sort(),
    totalTestFiles: allTestFiles.size,
    reasons,
  };
}

export function resolveLocalConcurrency(input: LocalConcurrencyInput): LocalConcurrencyPlan {
  if (input.vitestArgs.some((arg) => CLI_WORKER_FLAG.test(arg))) {
    return { maxWorkers: undefined, source: "cli", extraArgs: [] };
  }

  const rawEnv = input.env[ENV_TEST_MAX_WORKERS];
  if (rawEnv !== undefined && rawEnv.trim() !== "") {
    const trimmed = rawEnv.trim();
    const parsed = POSITIVE_INT.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new RangeError(
        `Invalid ${ENV_TEST_MAX_WORKERS}="${rawEnv}": expected a positive integer (for example ${ENV_TEST_MAX_WORKERS}=2)`,
      );
    }
    return { maxWorkers: parsed, source: "env", extraArgs: ["--maxWorkers", String(parsed)] };
  }

  const ci = input.env.CI?.trim().toLowerCase();
  if (ci !== undefined && ci !== "" && ci !== "0" && ci !== "false") {
    return { maxWorkers: undefined, source: "ci", extraArgs: [] };
  }

  const halfCpus = Math.floor(Math.max(1, input.cpuCount) / 2);
  const upper = Math.min(Math.max(1, input.maxWorkersCap), Math.max(1, input.testFileCount));
  const workers = Math.max(1, Math.min(halfCpus, upper));
  return { maxWorkers: workers, source: "local-default", extraArgs: ["--maxWorkers", String(workers)] };
}

export function parseTestRelatedArgs(argv: readonly string[], defaultBase: string = DEFAULT_BASE): ParsedTestRelatedArgs {
  let base = defaultBase;
  let dryRun = false;
  let explain = false;
  const vitestArgs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--base") {
      const next = argv[i + 1];
      if (!next) throw new Error("--base needs a git ref");
      base = next;
      i += 1;
    } else if (arg.startsWith("--base=")) {
      const val = arg.slice("--base=".length);
      if (!val) throw new Error("--base needs a git ref");
      base = val;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--explain") {
      explain = true;
    } else {
      vitestArgs.push(arg);
    }
  }

  return { base, dryRun, explain, vitestArgs };
}

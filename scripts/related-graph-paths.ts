// Resolves relative module specifiers, dynamic imports, vi.* mocks, and direct file-path reads for scripts/related-graph-ast.ts.
import { posix } from "node:path";
import type { ModuleImportEdge } from "./related-graph.ts";

export type AstNode = { type: string; [key: string]: unknown };

const VI_MOCK_METHODS = new Set(["mock", "doMock", "unmock", "importActual", "importMock"]);
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const JS_EXT_SWAP = /\.[cm]?jsx?$/;
const DIRNAME_CALLEE = new Set(["dirname"]);
const FILE_URL_TO_PATH_CALLEE = new Set(["fileURLToPath"]);
const JOIN_OR_RESOLVE_CALLEE = new Set(["join", "resolve"]);
const READ_FILE_CALLEE = new Set(["readFileSync", "readFile"]);
const ARRAY_ITER_METHODS = new Set(["forEach", "map", "filter", "some", "every", "flatMap"]);

interface DynamicUrlPattern {
  readonly prefix: string;
  readonly suffix: string;
  readonly paramName: string | null;
}

interface UrlTemplateHelper {
  readonly prefix: string;
  readonly suffix: string;
  readonly exported: boolean;
}

interface DynamicWalkContext {
  readonly file: string;
  readonly knownFiles: ReadonlySet<string>;
  readonly skippedKeys: ReadonlySet<string>;
  readonly addImport: (edge: ModuleImportEdge) => void;
  readonly addFileDep: (target: string) => void;
  readonly urlBindings: Map<string, string>;
  readonly stringBindings: ReadonlyMap<string, readonly string[]>;
  readonly stringArrayBindings: ReadonlyMap<string, readonly string[]>;
  readonly urlTemplateHelpers: ReadonlyMap<string, UrlTemplateHelper>;
  readonly handledNodes: ReadonlySet<AstNode>;
}

export const DYNAMIC_OR_PATH_HINT =
  /\bimport\s*\(|\bvi\s*\.\s*(?:mock|doMock|unmock|importActual|importMock)\b|\bnew\s+URL\s*\(|\bimport\.meta\.dirname\b|\bfileURLToPath\s*\(|\breadFile(?:Sync)?\s*\(\s*(?:["'`](?:src|scripts|test)\/|join\s*\(\s*(?:REPO_ROOT|ROOT|process\.cwd\s*\(\s*\)))|\bresolve\s*\(\s*["'`](?:src|scripts|test)\//;

export const TS_WRAPPER_TYPES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

export const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";

export function toRepoPosixPath(filePath: string): string {
  return filePath.split("\\").join("/").replace(/^\.\//, "");
}

export function isTypeOnlyNode(node: AstNode): boolean {
  if (node.declare === true) return true;
  if (node.type === "TSEnumDeclaration" || node.type === "TSModuleDeclaration" || node.type === "TSParameterProperty") {
    return false;
  }
  if (TS_WRAPPER_TYPES.has(node.type)) return false;
  return node.type.startsWith("TS");
}

export function staticStringValue(node: unknown): string | null {
  if (!isAstNode(node)) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0 &&
    Array.isArray(node.quasis) &&
    node.quasis.length === 1
  ) {
    const quasi = node.quasis[0] as { value?: { cooked?: unknown; raw?: unknown } } | undefined;
    const val = quasi?.value?.cooked ?? quasi?.value?.raw;
    return typeof val === "string" ? val : null;
  }
  return null;
}

export function resolveRelativeModule(fromFile: string, specifier: string, knownFiles: ReadonlySet<string>): string | null {
  if (!(specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..")) {
    return null;
  }
  const clean = specifier.split(/[?#]/, 1)[0]!;
  const dir = posix.dirname(fromFile);
  const candidate = toRepoPosixPath(posix.normalize(dir === "." ? clean : posix.join(dir, clean)));
  if (knownFiles.has(candidate)) return candidate;
  if (JS_EXT_SWAP.test(candidate)) {
    const stem = candidate.replace(JS_EXT_SWAP, "");
    for (const ext of RESOLVE_EXTENSIONS) {
      const hit = `${stem}${ext}`;
      if (knownFiles.has(hit)) return hit;
    }
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const hit = `${candidate}${ext}`;
    if (knownFiles.has(hit)) return hit;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const hit = `${candidate}/index${ext}`;
    if (knownFiles.has(hit)) return hit;
  }
  return null;
}

// Preserves ?query/#hash suffixes on resolved paths so `?raw`/`?url` variants keep distinct runtime identities.
export function moduleRuntimeIdentity(specifier: string, resolvedTarget: string | null): string {
  if (resolvedTarget === null) return specifier;
  const suffixIdx = specifier.search(/[?#]/);
  return suffixIdx === -1 ? resolvedTarget : `${resolvedTarget}${specifier.slice(suffixIdx)}`;
}

function resolveRepoPath(candidate: string, knownFiles: ReadonlySet<string>): string | null {
  const clean = toRepoPosixPath(posix.normalize(candidate.split(/[?#]/, 1)[0]!));
  return knownFiles.has(clean) ? clean : null;
}

function resolveFromDir(dir: string, rel: string, knownFiles: ReadonlySet<string>): string | null {
  const clean = rel.split(/[?#]/, 1)[0]!;
  const joined = dir === "." ? clean : posix.join(dir, clean);
  return resolveRepoPath(joined, knownFiles);
}

function isImportMetaProp(node: unknown, propName: string): boolean {
  return (
    isAstNode(node) &&
    node.type === "MemberExpression" &&
    node.computed !== true &&
    isAstNode(node.object) &&
    node.object.type === "MetaProperty" &&
    isAstNode(node.object.meta) &&
    node.object.meta.name === "import" &&
    isAstNode(node.object.property) &&
    node.object.property.name === "meta" &&
    isAstNode(node.property) &&
    node.property.type === "Identifier" &&
    node.property.name === propName
  );
}

function isCalleeNamed(callee: unknown, names: ReadonlySet<string>): boolean {
  if (!isAstNode(callee)) return false;
  if (callee.type === "Identifier") return names.has(callee.name as string);
  if (callee.type === "MemberExpression" && callee.computed !== true && isAstNode(callee.property) && callee.property.type === "Identifier") {
    return names.has(callee.property.name as string);
  }
  return false;
}

function isDirBaseExpr(node: unknown): boolean {
  if (isImportMetaProp(node, "dirname")) return true;
  if (
    isAstNode(node) &&
    node.type === "CallExpression" &&
    isCalleeNamed(node.callee, DIRNAME_CALLEE) &&
    Array.isArray(node.arguments) &&
    node.arguments.length === 1
  ) {
    const inner = node.arguments[0];
    return (
      isAstNode(inner) &&
      inner.type === "CallExpression" &&
      isCalleeNamed(inner.callee, FILE_URL_TO_PATH_CALLEE) &&
      Array.isArray(inner.arguments) &&
      inner.arguments.length === 1 &&
      isImportMetaProp(inner.arguments[0], "url")
    );
  }
  return false;
}

function isRepoRootExpr(node: unknown): boolean {
  if (isAstNode(node) && node.type === "Identifier" && (node.name === "REPO_ROOT" || node.name === "ROOT")) return true;
  return (
    isAstNode(node) &&
    node.type === "CallExpression" &&
    isAstNode(node.callee) &&
    node.callee.type === "MemberExpression" &&
    node.callee.computed !== true &&
    isAstNode(node.callee.object) &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "process" &&
    isAstNode(node.callee.property) &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "cwd"
  );
}

function resolveStaticPathExpr(node: unknown, file: string, knownFiles: ReadonlySet<string>): string | null {
  if (!isAstNode(node)) return null;
  if (TS_WRAPPER_TYPES.has(node.type)) return resolveStaticPathExpr(node.expression, file, knownFiles);
  if (
    node.type === "MemberExpression" &&
    node.computed !== true &&
    isAstNode(node.property) &&
    node.property.type === "Identifier" &&
    (node.property.name === "href" || node.property.name === "pathname")
  ) {
    return resolveStaticPathExpr(node.object, file, knownFiles);
  }
  if (
    node.type === "NewExpression" &&
    isAstNode(node.callee) &&
    node.callee.type === "Identifier" &&
    node.callee.name === "URL" &&
    Array.isArray(node.arguments) &&
    node.arguments.length === 2 &&
    isImportMetaProp(node.arguments[1], "url")
  ) {
    const rel = staticStringValue(node.arguments[0]);
    if (rel !== null) return resolveFromDir(posix.dirname(file), rel, knownFiles);
  }
  if (node.type === "CallExpression" && Array.isArray(node.arguments) && node.arguments.length > 0) {
    if (isCalleeNamed(node.callee, FILE_URL_TO_PATH_CALLEE) && node.arguments.length === 1) {
      return resolveStaticPathExpr(node.arguments[0], file, knownFiles);
    }
    if (isCalleeNamed(node.callee, JOIN_OR_RESOLVE_CALLEE)) {
      const args = node.arguments;
      if (isDirBaseExpr(args[0])) {
        const parts = args.slice(1).map(staticStringValue);
        if (parts.length > 0 && parts.every((p): p is string => p !== null)) {
          return resolveFromDir(posix.dirname(file), posix.join(...parts), knownFiles);
        }
      } else if (isRepoRootExpr(args[0])) {
        const parts = args.slice(1).map(staticStringValue);
        if (parts.length > 0 && parts.every((p): p is string => p !== null)) {
          return resolveRepoPath(posix.join(...parts), knownFiles);
        }
      } else {
        const parts = args.map(staticStringValue);
        if (parts.length > 0 && parts.every((p): p is string => p !== null)) {
          return resolveRepoPath(posix.join(...parts), knownFiles);
        }
      }
    }
  }
  return null;
}

function quasiString(quasi: unknown): string | null {
  if (!isAstNode(quasi)) return null;
  const val = (quasi.value as { cooked?: unknown; raw?: unknown } | undefined)?.cooked ?? (quasi.value as { raw?: unknown } | undefined)?.raw;
  return typeof val === "string" ? val : null;
}

function isNewUrlWithImportMeta(node: unknown): node is AstNode {
  return (
    isAstNode(node) &&
    node.type === "NewExpression" &&
    isAstNode(node.callee) &&
    node.callee.type === "Identifier" &&
    node.callee.name === "URL" &&
    Array.isArray(node.arguments) &&
    node.arguments.length === 2 &&
    isImportMetaProp(node.arguments[1], "url")
  );
}

function parseDynamicUrlPattern(arg: unknown): DynamicUrlPattern {
  if (!isAstNode(arg)) return { prefix: "", suffix: "", paramName: null };
  if (TS_WRAPPER_TYPES.has(arg.type)) return parseDynamicUrlPattern(arg.expression);
  if (arg.type === "Identifier") return { prefix: "", suffix: "", paramName: arg.name as string };
  if (arg.type === "TemplateLiteral" && Array.isArray(arg.quasis) && Array.isArray(arg.expressions) && arg.expressions.length > 0) {
    const prefix = quasiString(arg.quasis[0]) ?? "";
    const suffix = quasiString(arg.quasis[arg.quasis.length - 1]) ?? "";
    const only = arg.expressions.length === 1 ? arg.expressions[0] : null;
    const paramName = isAstNode(only) && only.type === "Identifier" ? (only.name as string) : null;
    return { prefix, suffix, paramName };
  }
  return { prefix: "", suffix: "", paramName: null };
}

function emitDirectoryFallbackDeps(
  file: string,
  prefix: string,
  suffix: string,
  knownFiles: ReadonlySet<string>,
  emit: (target: string) => void,
): void {
  const dir = posix.dirname(file);
  const cleanSuffix = suffix.split(/[?#]/, 1)[0]!;
  let matchPrefix = "";
  if (prefix === "") {
    matchPrefix = dir === "." ? "" : `${dir}/`;
  } else {
    const joined = dir === "." ? prefix : posix.join(dir, prefix);
    const normalized = toRepoPosixPath(posix.normalize(joined));
    if (normalized === "." || normalized === "./") {
      matchPrefix = "";
    } else if (normalized.startsWith("..")) {
      return;
    } else {
      matchPrefix = normalized;
    }
  }
  for (const candidate of knownFiles) {
    if (candidate === file) continue;
    if (matchPrefix !== "" && !candidate.startsWith(matchPrefix)) continue;
    if (cleanSuffix !== "" && !candidate.endsWith(cleanSuffix)) continue;
    emit(candidate);
  }
}

function staticStringArray(node: unknown): string[] | null {
  if (!isAstNode(node)) return null;
  if (TS_WRAPPER_TYPES.has(node.type)) return staticStringArray(node.expression);
  if (node.type !== "ArrayExpression" || !Array.isArray(node.elements) || node.elements.length === 0) return null;
  const out: string[] = [];
  for (const el of node.elements) {
    const val = staticStringValue(el);
    if (val === null) return null;
    out.push(val);
  }
  return out;
}

function firstParamName(fnNode: unknown): string | null {
  if (!isAstNode(fnNode)) return null;
  if (fnNode.type !== "FunctionDeclaration" && fnNode.type !== "FunctionExpression" && fnNode.type !== "ArrowFunctionExpression") {
    return null;
  }
  if (!Array.isArray(fnNode.params) || fnNode.params.length === 0) return null;
  const first = fnNode.params[0];
  return isAstNode(first) && first.type === "Identifier" ? (first.name as string) : null;
}

function findUrlTemplateInFunctionBody(
  node: unknown,
  paramName: string,
  skippedKeys: ReadonlySet<string>,
): { pattern: DynamicUrlPattern; urlNode: AstNode } | null {
  if (!isAstNode(node) || isTypeOnlyNode(node)) return null;
  if (isNewUrlWithImportMeta(node)) {
    const args = node.arguments as unknown[];
    if (staticStringValue(args[0]) === null) {
      const pattern = parseDynamicUrlPattern(args[0]);
      if (pattern.paramName === paramName) return { pattern, urlNode: node };
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (skippedKeys.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = findUrlTemplateInFunctionBody(item, paramName, skippedKeys);
        if (hit) return hit;
      }
    } else {
      const hit = findUrlTemplateInFunctionBody(value, paramName, skippedKeys);
      if (hit) return hit;
    }
  }
  return null;
}

function findHelperForwardCall(
  node: unknown,
  paramName: string,
  helpers: ReadonlyMap<string, UrlTemplateHelper>,
  skippedKeys: ReadonlySet<string>,
): { helper: UrlTemplateHelper; callNode: AstNode } | null {
  if (!isAstNode(node) || isTypeOnlyNode(node)) return null;
  if (
    node.type === "CallExpression" &&
    isAstNode(node.callee) &&
    node.callee.type === "Identifier" &&
    Array.isArray(node.arguments) &&
    node.arguments.length >= 1 &&
    isAstNode(node.arguments[0]) &&
    node.arguments[0].type === "Identifier" &&
    node.arguments[0].name === paramName
  ) {
    const helper = helpers.get(node.callee.name as string);
    if (helper) return { helper, callNode: node };
  }
  for (const [key, value] of Object.entries(node)) {
    if (skippedKeys.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = findHelperForwardCall(item, paramName, helpers, skippedKeys);
        if (hit) return hit;
      }
    } else {
      const hit = findHelperForwardCall(value, paramName, helpers, skippedKeys);
      if (hit) return hit;
    }
  }
  return null;
}

function collectStaticBindingsAndHelpers(
  root: unknown,
  skippedKeys: ReadonlySet<string>,
): {
  stringBindings: Map<string, readonly string[]>;
  stringArrayBindings: Map<string, readonly string[]>;
  urlTemplateHelpers: Map<string, UrlTemplateHelper>;
  handledNodes: Set<AstNode>;
} {
  const stringBindings = new Map<string, string[]>();
  const ambiguousStrings = new Set<string>();
  const stringArrayBindings = new Map<string, string[]>();
  const ambiguousArrays = new Set<string>();
  const urlTemplateHelpers = new Map<string, UrlTemplateHelper>();
  const handledNodes = new Set<AstNode>();
  const candidateFns: { name: string; fnNode: AstNode; paramName: string; exported: boolean }[] = [];

  const addValues = (target: Map<string, string[]>, name: string, values: readonly string[]): void => {
    let list = target.get(name);
    if (!list) {
      list = [];
      target.set(name, list);
    }
    for (const v of values) if (!list.includes(v)) list.push(v);
  };

  const scan = (node: unknown, exported: boolean): void => {
    if (!isAstNode(node) || isTypeOnlyNode(node)) return;
    if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
      if (isAstNode(node.declaration)) scan(node.declaration, true);
      return;
    }
    if (node.type === "FunctionDeclaration" && isAstNode(node.id) && node.id.type === "Identifier") {
      const paramName = firstParamName(node);
      if (paramName !== null) candidateFns.push({ name: node.id.name as string, fnNode: node, paramName, exported });
    } else if (node.type === "VariableDeclaration" && Array.isArray(node.declarations)) {
      const isConst = node.kind === "const";
      for (const decl of node.declarations) {
        if (!isAstNode(decl) || !isAstNode(decl.id) || decl.id.type !== "Identifier") continue;
        const name = decl.id.name as string;
        const str = isConst ? staticStringValue(decl.init) : null;
        if (str !== null && !ambiguousStrings.has(name)) {
          addValues(stringBindings, name, [str]);
        } else {
          ambiguousStrings.add(name);
          stringBindings.delete(name);
        }
        const arr = isConst ? staticStringArray(decl.init) : null;
        if (arr !== null && !ambiguousArrays.has(name)) {
          addValues(stringArrayBindings, name, arr);
        } else {
          ambiguousArrays.add(name);
          stringArrayBindings.delete(name);
        }
        const paramName = isConst ? firstParamName(decl.init) : null;
        if (paramName !== null && isAstNode(decl.init)) candidateFns.push({ name, fnNode: decl.init, paramName, exported });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (skippedKeys.has(key)) continue;
      if (Array.isArray(value)) for (const item of value) scan(item, false);
      else scan(value, false);
    }
  };
  scan(root, false);

  for (const fn of candidateFns) {
    const direct = findUrlTemplateInFunctionBody(fn.fnNode.body, fn.paramName, skippedKeys);
    if (direct) {
      urlTemplateHelpers.set(fn.name, { prefix: direct.pattern.prefix, suffix: direct.pattern.suffix, exported: fn.exported });
      handledNodes.add(direct.urlNode);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of candidateFns) {
      if (urlTemplateHelpers.has(fn.name)) continue;
      const fwd = findHelperForwardCall(fn.fnNode.body, fn.paramName, urlTemplateHelpers, skippedKeys);
      if (fwd) {
        urlTemplateHelpers.set(fn.name, { prefix: fwd.helper.prefix, suffix: fwd.helper.suffix, exported: fn.exported });
        handledNodes.add(fwd.callNode);
        changed = true;
      }
    }
  }
  return { stringBindings, stringArrayBindings, urlTemplateHelpers, handledNodes };
}

function resolveArgStrings(
  arg: unknown,
  ctx: DynamicWalkContext,
  scopedLists: ReadonlyMap<string, readonly string[]>,
): readonly string[] | null {
  const lit = staticStringValue(arg);
  if (lit !== null) return [lit];
  if (isAstNode(arg) && TS_WRAPPER_TYPES.has(arg.type)) return resolveArgStrings(arg.expression, ctx, scopedLists);
  if (isAstNode(arg) && arg.type === "Identifier") {
    const name = arg.name as string;
    const scoped = scopedLists.get(name);
    if (scoped !== undefined) return scoped;
    const bound = ctx.stringBindings.get(name);
    if (bound !== undefined) return bound;
  }
  return null;
}

function resolveListNode(node: unknown, ctx: DynamicWalkContext): readonly string[] | null {
  const inline = staticStringArray(node);
  if (inline !== null) return inline;
  if (isAstNode(node) && TS_WRAPPER_TYPES.has(node.type)) return resolveListNode(node.expression, ctx);
  if (isAstNode(node) && node.type === "Identifier") return ctx.stringArrayBindings.get(node.name as string) ?? null;
  return null;
}

function emitTemplateUrlDeps(
  pattern: DynamicUrlPattern,
  ctx: DynamicWalkContext,
  scopedLists: ReadonlyMap<string, readonly string[]>,
  emit: (target: string) => void,
): void {
  const dir = posix.dirname(ctx.file);
  if (pattern.paramName !== null) {
    const values = scopedLists.get(pattern.paramName) ?? ctx.stringBindings.get(pattern.paramName);
    if (values !== undefined) {
      for (const val of values) {
        const hit = resolveFromDir(dir, `${pattern.prefix}${val}${pattern.suffix}`, ctx.knownFiles);
        if (hit !== null && hit !== ctx.file) emit(hit);
      }
      return;
    }
  }
  emitDirectoryFallbackDeps(ctx.file, pattern.prefix, pattern.suffix, ctx.knownFiles, emit);
}

function walkDynamicMockAndFileRefs(
  node: unknown,
  ctx: DynamicWalkContext,
  scopedLists: ReadonlyMap<string, readonly string[]>,
): void {
  if (!isAstNode(node) || isTypeOnlyNode(node)) return;
  if (TS_WRAPPER_TYPES.has(node.type)) {
    walkDynamicMockAndFileRefs(node.expression, ctx, scopedLists);
    return;
  }
  if (node.type === "ForOfStatement") {
    const list = resolveListNode(node.right, ctx);
    let loopVar: string | null = null;
    if (isAstNode(node.left) && node.left.type === "VariableDeclaration" && Array.isArray(node.left.declarations)) {
      const first = node.left.declarations[0];
      if (isAstNode(first) && isAstNode(first.id) && first.id.type === "Identifier") loopVar = first.id.name as string;
    } else if (isAstNode(node.left) && node.left.type === "Identifier") {
      loopVar = node.left.name as string;
    }
    if (list !== null && loopVar !== null) {
      const nextScope = new Map(scopedLists);
      nextScope.set(loopVar, list);
      walkDynamicMockAndFileRefs(node.body, ctx, nextScope);
      return;
    }
  }
  if (node.type === "VariableDeclarator" && isAstNode(node.id) && node.id.type === "Identifier") {
    const resolved = resolveStaticPathExpr(node.init, ctx.file, ctx.knownFiles);
    if (resolved !== null) {
      ctx.urlBindings.set(node.id.name as string, resolved);
      if (resolved !== ctx.file) ctx.addFileDep(resolved);
    }
  }
  let callbackScope: { readonly cb: AstNode; readonly scope: Map<string, readonly string[]> } | null = null;
  if (node.type === "ImportExpression") {
    const spec = staticStringValue(node.source);
    if (spec !== null) {
      const target = resolveRelativeModule(ctx.file, spec, ctx.knownFiles);
      if (target !== null) ctx.addImport({ target, imported: "*", local: null });
    } else if (isAstNode(node.source) && node.source.type === "Identifier") {
      const bound = ctx.urlBindings.get(node.source.name as string);
      if (bound !== undefined) ctx.addImport({ target: bound, imported: "*", local: null });
    } else {
      const resolved = resolveStaticPathExpr(node.source, ctx.file, ctx.knownFiles);
      if (resolved !== null) {
        ctx.addImport({ target: resolved, imported: "*", local: null });
      } else {
        const unwrapped =
          isAstNode(node.source) &&
          node.source.type === "MemberExpression" &&
          node.source.computed !== true &&
          isAstNode(node.source.property) &&
          node.source.property.type === "Identifier" &&
          (node.source.property.name === "href" || node.source.property.name === "pathname")
            ? node.source.object
            : node.source;
        if (isNewUrlWithImportMeta(unwrapped)) {
          const pattern = parseDynamicUrlPattern((unwrapped.arguments as unknown[])[0]);
          emitTemplateUrlDeps(pattern, ctx, scopedLists, (target) => ctx.addImport({ target, imported: "*", local: null }));
        }
      }
    }
  } else if (node.type === "CallExpression" && isAstNode(node.callee)) {
    const callee = node.callee;
    if (
      callee.type === "CallExpression" &&
      isAstNode(callee.callee) &&
      callee.callee.type === "MemberExpression" &&
      callee.callee.computed !== true &&
      isAstNode(callee.callee.property) &&
      callee.callee.property.type === "Identifier" &&
      callee.callee.property.name === "each" &&
      Array.isArray(callee.arguments) &&
      callee.arguments.length >= 1 &&
      Array.isArray(node.arguments) &&
      node.arguments.length >= 2
    ) {
      const list = resolveListNode(callee.arguments[0], ctx);
      const cb = node.arguments[1];
      const paramName = firstParamName(cb);
      if (list !== null && paramName !== null && isAstNode(cb)) {
        const nextScope = new Map(scopedLists);
        nextScope.set(paramName, list);
        callbackScope = { cb, scope: nextScope };
      }
    }
    if (
      callee.type === "MemberExpression" &&
      callee.computed !== true &&
      isAstNode(callee.property) &&
      callee.property.type === "Identifier" &&
      ARRAY_ITER_METHODS.has(callee.property.name as string) &&
      Array.isArray(node.arguments) &&
      node.arguments.length >= 1
    ) {
      const list = resolveListNode(callee.object, ctx);
      const cb = node.arguments[0];
      const paramName = firstParamName(cb);
      if (list !== null && paramName !== null && isAstNode(cb)) {
        const nextScope = new Map(scopedLists);
        nextScope.set(paramName, list);
        callbackScope = { cb, scope: nextScope };
      }
    }
    if (
      callee.type === "Identifier" &&
      ctx.urlTemplateHelpers.has(callee.name as string) &&
      !ctx.handledNodes.has(node) &&
      Array.isArray(node.arguments) &&
      node.arguments.length >= 1
    ) {
      const helper = ctx.urlTemplateHelpers.get(callee.name as string)!;
      const values = resolveArgStrings(node.arguments[0], ctx, scopedLists);
      if (values !== null) {
        const dir = posix.dirname(ctx.file);
        for (const val of values) {
          const hit = resolveFromDir(dir, `${helper.prefix}${val}${helper.suffix}`, ctx.knownFiles);
          if (hit !== null && hit !== ctx.file) ctx.addFileDep(hit);
        }
      } else {
        emitDirectoryFallbackDeps(ctx.file, helper.prefix, helper.suffix, ctx.knownFiles, ctx.addFileDep);
      }
    } else if (
      callee.type === "MemberExpression" &&
      callee.computed !== true &&
      isAstNode(callee.object) &&
      callee.object.type === "Identifier" &&
      callee.object.name === "vi" &&
      isAstNode(callee.property) &&
      callee.property.type === "Identifier" &&
      VI_MOCK_METHODS.has(callee.property.name as string) &&
      Array.isArray(node.arguments) &&
      node.arguments.length > 0
    ) {
      const spec = staticStringValue(node.arguments[0]);
      if (spec !== null) {
        const target = resolveRelativeModule(ctx.file, spec, ctx.knownFiles);
        if (target !== null) ctx.addImport({ target, imported: "*", local: null });
      }
    } else if (isCalleeNamed(callee, READ_FILE_CALLEE) && Array.isArray(node.arguments) && node.arguments.length > 0) {
      const literal = staticStringValue(node.arguments[0]);
      const target =
        literal !== null ? resolveRepoPath(literal, ctx.knownFiles) : resolveStaticPathExpr(node.arguments[0], ctx.file, ctx.knownFiles);
      if (target !== null && target !== ctx.file) ctx.addFileDep(target);
    } else {
      const direct = resolveStaticPathExpr(node, ctx.file, ctx.knownFiles);
      if (direct !== null && direct !== ctx.file) ctx.addFileDep(direct);
    }
    if (Array.isArray(node.arguments)) {
      for (const arg of node.arguments) {
        if (isAstNode(arg) && arg.type === "Identifier" && ctx.urlTemplateHelpers.has(arg.name as string)) {
          const helper = ctx.urlTemplateHelpers.get(arg.name as string)!;
          emitDirectoryFallbackDeps(ctx.file, helper.prefix, helper.suffix, ctx.knownFiles, ctx.addFileDep);
        }
      }
    }
  } else if (node.type === "NewExpression") {
    const direct = resolveStaticPathExpr(node, ctx.file, ctx.knownFiles);
    if (direct !== null && direct !== ctx.file) {
      ctx.addFileDep(direct);
    } else if (isNewUrlWithImportMeta(node) && !ctx.handledNodes.has(node)) {
      const pattern = parseDynamicUrlPattern((node.arguments as unknown[])[0]);
      emitTemplateUrlDeps(pattern, ctx, scopedLists, ctx.addFileDep);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (ctx.skippedKeys.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        walkDynamicMockAndFileRefs(item, ctx, callbackScope !== null && item === callbackScope.cb ? callbackScope.scope : scopedLists);
      }
    } else {
      walkDynamicMockAndFileRefs(value, ctx, callbackScope !== null && value === callbackScope.cb ? callbackScope.scope : scopedLists);
    }
  }
}

export function collectDynamicMockAndFileRefs(
  node: unknown,
  file: string,
  knownFiles: ReadonlySet<string>,
  skippedKeys: ReadonlySet<string>,
  addImport: (edge: ModuleImportEdge) => void,
  addFileDep: (target: string) => void,
  urlBindings: Map<string, string>,
): void {
  const { stringBindings, stringArrayBindings, urlTemplateHelpers, handledNodes } = collectStaticBindingsAndHelpers(node, skippedKeys);
  for (const helper of urlTemplateHelpers.values()) {
    if (helper.exported) emitDirectoryFallbackDeps(file, helper.prefix, helper.suffix, knownFiles, addFileDep);
  }
  walkDynamicMockAndFileRefs(
    node,
    { file, knownFiles, skippedKeys, addImport, addFileDep, urlBindings, stringBindings, stringArrayBindings, urlTemplateHelpers, handledNodes },
    new Map(),
  );
}

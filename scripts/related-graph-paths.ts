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

export function collectDynamicMockAndFileRefs(
  node: unknown,
  file: string,
  knownFiles: ReadonlySet<string>,
  skippedKeys: ReadonlySet<string>,
  addImport: (edge: ModuleImportEdge) => void,
  addFileDep: (target: string) => void,
  urlBindings: Map<string, string>,
): void {
  if (!isAstNode(node) || isTypeOnlyNode(node)) return;
  if (TS_WRAPPER_TYPES.has(node.type)) {
    collectDynamicMockAndFileRefs(node.expression, file, knownFiles, skippedKeys, addImport, addFileDep, urlBindings);
    return;
  }
  if (node.type === "VariableDeclarator" && isAstNode(node.id) && node.id.type === "Identifier") {
    const resolved = resolveStaticPathExpr(node.init, file, knownFiles);
    if (resolved !== null) {
      urlBindings.set(node.id.name as string, resolved);
      if (resolved !== file) addFileDep(resolved);
    }
  }
  if (node.type === "ImportExpression") {
    const spec = staticStringValue(node.source);
    if (spec !== null) {
      const target = resolveRelativeModule(file, spec, knownFiles);
      if (target !== null) addImport({ target, imported: "*", local: null });
    } else if (isAstNode(node.source) && node.source.type === "Identifier") {
      const bound = urlBindings.get(node.source.name as string);
      if (bound !== undefined) addImport({ target: bound, imported: "*", local: null });
    } else {
      const resolved = resolveStaticPathExpr(node.source, file, knownFiles);
      if (resolved !== null) addImport({ target: resolved, imported: "*", local: null });
    }
  } else if (node.type === "CallExpression" && isAstNode(node.callee)) {
    const callee = node.callee;
    if (
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
        const target = resolveRelativeModule(file, spec, knownFiles);
        if (target !== null) addImport({ target, imported: "*", local: null });
      }
    } else if (
      isCalleeNamed(callee, READ_FILE_CALLEE) &&
      Array.isArray(node.arguments) &&
      node.arguments.length > 0
    ) {
      const literal = staticStringValue(node.arguments[0]);
      const target =
        literal !== null ? resolveRepoPath(literal, knownFiles) : resolveStaticPathExpr(node.arguments[0], file, knownFiles);
      if (target !== null && target !== file) addFileDep(target);
    } else {
      const direct = resolveStaticPathExpr(node, file, knownFiles);
      if (direct !== null && direct !== file) addFileDep(direct);
    }
  } else if (node.type === "NewExpression") {
    const direct = resolveStaticPathExpr(node, file, knownFiles);
    if (direct !== null && direct !== file) addFileDep(direct);
  }
  for (const [key, value] of Object.entries(node)) {
    if (skippedKeys.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) collectDynamicMockAndFileRefs(item, file, knownFiles, skippedKeys, addImport, addFileDep, urlBindings);
    } else {
      collectDynamicMockAndFileRefs(value, file, knownFiles, skippedKeys, addImport, addFileDep, urlBindings);
    }
  }
}

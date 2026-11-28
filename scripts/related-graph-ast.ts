// AST analysis and export-level diffing for scripts/related-graph.ts; fails closed on syntax errors or ambiguous side effects.
import { posix } from "node:path";
import { parseSync } from "oxc-parser";
import type { ExportChangeSet, ModuleImportEdge, ModuleReexportEdge, ModuleSummary } from "./related-graph.ts";

type AstNode = { type: string; [key: string]: unknown };

const VI_MOCK_METHODS = new Set(["mock", "doMock", "unmock", "importActual", "importMock"]);
const VI_MOCK_HINT = /\bvi\s*\./;
const DYNAMIC_OR_MOCK_HINT = /\bimport\s*\(|\bvi\s*\./;
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const JS_EXT_SWAP = /\.[cm]?jsx?$/;
const TS_WRAPPER_TYPES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);
const SKIPPED_AST_KEYS = new Set([
  "start",
  "end",
  "loc",
  "range",
  "raw",
  "typeAnnotation",
  "typeParameters",
  "typeArguments",
  "returnType",
  "superTypeArguments",
  "implements",
  "definite",
  "optional",
  "importKind",
  "exportKind",
]);

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";

export function toRepoPosixPath(filePath: string): string {
  return filePath.split("\\").join("/").replace(/^\.\//, "");
}

function resolveRelativeModule(fromFile: string, specifier: string, knownFiles: ReadonlySet<string>): string | null {
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

function staticStringValue(node: unknown): string | null {
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

function exportOrImportName(node: unknown): string | null {
  if (!isAstNode(node)) return null;
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function isTypeOnlyNode(node: AstNode): boolean {
  if (node.declare === true) return true;
  if (node.type === "TSEnumDeclaration" || node.type === "TSModuleDeclaration" || node.type === "TSParameterProperty") {
    return false;
  }
  if (TS_WRAPPER_TYPES.has(node.type)) return false;
  return node.type.startsWith("TS");
}

function collectPatternNames(pattern: unknown, names: string[], defaultRefs: Set<string>): void {
  if (!isAstNode(pattern)) return;
  switch (pattern.type) {
    case "Identifier":
      names.push(pattern.name as string);
      return;
    case "AssignmentPattern":
      collectPatternNames(pattern.left, names, defaultRefs);
      collectRuntimeRefs(pattern.right, defaultRefs);
      return;
    case "RestElement":
      collectPatternNames(pattern.argument, names, defaultRefs);
      return;
    case "ArrayPattern":
      if (Array.isArray(pattern.elements)) for (const el of pattern.elements) collectPatternNames(el, names, defaultRefs);
      return;
    case "ObjectPattern":
      if (Array.isArray(pattern.properties)) {
        for (const prop of pattern.properties) {
          if (!isAstNode(prop)) continue;
          if (prop.type === "RestElement") collectPatternNames(prop.argument, names, defaultRefs);
          else if (prop.type === "Property") {
            if (prop.computed === true) collectRuntimeRefs(prop.key, defaultRefs);
            collectPatternNames(prop.value, names, defaultRefs);
          }
        }
      }
      return;
    default:
      return;
  }
}

function collectJsxRootIdentifier(nameNode: unknown, refs: Set<string>): void {
  if (!isAstNode(nameNode)) return;
  if (nameNode.type === "JSXIdentifier") {
    const name = nameNode.name as string;
    if (/^[A-Z_$]/.test(name)) refs.add(name);
    return;
  }
  if (nameNode.type === "JSXMemberExpression") {
    let cur: unknown = nameNode.object;
    while (isAstNode(cur) && cur.type === "JSXMemberExpression") cur = cur.object;
    if (isAstNode(cur) && cur.type === "JSXIdentifier") refs.add(cur.name as string);
  }
}

function collectRuntimeRefs(node: unknown, refs: Set<string>): void {
  if (!isAstNode(node) || isTypeOnlyNode(node)) return;
  if (TS_WRAPPER_TYPES.has(node.type)) {
    collectRuntimeRefs(node.expression, refs);
    return;
  }
  if (node.type === "TSParameterProperty") {
    collectRuntimeRefs(node.parameter, refs);
    return;
  }
  if (node.type === "Identifier") {
    refs.add(node.name as string);
    return;
  }
  if (node.type === "MemberExpression") {
    collectRuntimeRefs(node.object, refs);
    if (node.computed === true) collectRuntimeRefs(node.property, refs);
    return;
  }
  if (node.type === "Property") {
    if (node.computed === true) collectRuntimeRefs(node.key, refs);
    collectRuntimeRefs(node.value, refs);
    return;
  }
  if (node.type === "MethodDefinition" || node.type === "PropertyDefinition") {
    if (node.computed === true) collectRuntimeRefs(node.key, refs);
    collectRuntimeRefs(node.value, refs);
    if (Array.isArray(node.decorators)) for (const dec of node.decorators) collectRuntimeRefs(dec, refs);
    return;
  }
  if (node.type === "JSXOpeningElement") {
    collectJsxRootIdentifier(node.name, refs);
    if (Array.isArray(node.attributes)) for (const attr of node.attributes) collectRuntimeRefs(attr, refs);
    return;
  }
  if (node.type === "JSXClosingElement" || node.type === "JSXAttribute") {
    if (node.type === "JSXAttribute") collectRuntimeRefs(node.value, refs);
    return;
  }
  if (node.type === "VariableDeclarator") {
    const ignored: string[] = [];
    collectPatternNames(node.id, ignored, refs);
    collectRuntimeRefs(node.init, refs);
    return;
  }
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
    if (Array.isArray(node.params)) {
      const ignored: string[] = [];
      for (const param of node.params) {
        if (isAstNode(param) && param.type === "TSParameterProperty") collectPatternNames(param.parameter, ignored, refs);
        else collectPatternNames(param, ignored, refs);
      }
    }
    collectRuntimeRefs(node.body, refs);
    return;
  }
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    collectRuntimeRefs(node.superClass, refs);
    collectRuntimeRefs(node.body, refs);
    if (Array.isArray(node.decorators)) for (const dec of node.decorators) collectRuntimeRefs(dec, refs);
    return;
  }
  if (node.type === "TSEnumMember") {
    if (node.computed === true) collectRuntimeRefs(node.id, refs);
    collectRuntimeRefs(node.initializer, refs);
    return;
  }
  if (node.type === "CatchClause") {
    const ignored: string[] = [];
    collectPatternNames(node.param, ignored, refs);
    collectRuntimeRefs(node.body, refs);
    return;
  }
  if (node.type === "LabeledStatement" || node.type === "BreakStatement" || node.type === "ContinueStatement") {
    if (node.type === "LabeledStatement") collectRuntimeRefs(node.body, refs);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (SKIPPED_AST_KEYS.has(key)) continue;
    if (Array.isArray(value)) for (const item of value) collectRuntimeRefs(item, refs);
    else collectRuntimeRefs(value, refs);
  }
}

function collectDynamicAndMockImports(
  node: unknown,
  file: string,
  knownFiles: ReadonlySet<string>,
  addImport: (edge: ModuleImportEdge) => void,
): void {
  if (!isAstNode(node) || isTypeOnlyNode(node)) return;
  if (TS_WRAPPER_TYPES.has(node.type)) {
    collectDynamicAndMockImports(node.expression, file, knownFiles, addImport);
    return;
  }
  if (node.type === "ImportExpression") {
    const spec = staticStringValue(node.source);
    if (spec !== null) {
      const target = resolveRelativeModule(file, spec, knownFiles);
      if (target !== null) addImport({ target, imported: "*", local: null });
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
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (SKIPPED_AST_KEYS.has(key)) continue;
    if (Array.isArray(value)) for (const item of value) collectDynamicAndMockImports(item, file, knownFiles, addImport);
    else collectDynamicAndMockImports(value, file, knownFiles, addImport);
  }
}

function canonicalizeRuntimeAst(node: unknown): unknown {
  if (typeof node === "bigint") return `${node}n`;
  if (node instanceof RegExp) return String(node);
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      if (isAstNode(item) && isTypeOnlyNode(item)) continue;
      out.push(canonicalizeRuntimeAst(item));
    }
    return out;
  }
  if (!isAstNode(node)) return node;
  if (isTypeOnlyNode(node)) return null;
  if (TS_WRAPPER_TYPES.has(node.type)) return canonicalizeRuntimeAst(node.expression);
  if (node.type === "TSParameterProperty") return canonicalizeRuntimeAst(node.parameter);
  const out: Record<string, unknown> = { type: node.type };
  for (const key of Object.keys(node).sort()) {
    if (key === "type" || SKIPPED_AST_KEYS.has(key)) continue;
    out[key] = canonicalizeRuntimeAst(node[key]);
  }
  return out;
}

const canonicalFingerprint = (node: unknown): string => JSON.stringify(canonicalizeRuntimeAst(node));

function recordDeclaration(
  decl: AstNode,
  localDecls: Map<string, Set<string>>,
  localFingerprints?: Map<string, string>,
): string[] {
  if (isTypeOnlyNode(decl)) return [];
  const declared: string[] = [];
  if (decl.type === "VariableDeclaration" && Array.isArray(decl.declarations)) {
    const kind = String(decl.kind ?? "const");
    for (const declarator of decl.declarations) {
      if (!isAstNode(declarator)) continue;
      const names: string[] = [];
      const refs = new Set<string>();
      collectPatternNames(declarator.id, names, refs);
      collectRuntimeRefs(declarator.init, refs);
      const fp = localFingerprints ? `${kind}:${canonicalFingerprint(declarator)}` : "";
      for (const name of names) {
        declared.push(name);
        localDecls.set(name, refs);
        if (localFingerprints) localFingerprints.set(name, fp);
      }
    }
    return declared;
  }
  if (
    (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration" || decl.type === "TSEnumDeclaration") &&
    isAstNode(decl.id) &&
    decl.id.type === "Identifier"
  ) {
    const name = decl.id.name as string;
    const refs = new Set<string>();
    collectRuntimeRefs(decl, refs);
    declared.push(name);
    localDecls.set(name, refs);
    if (localFingerprints) localFingerprints.set(name, canonicalFingerprint(decl));
    return declared;
  }
  return declared;
}

interface DetailedModuleAnalysis {
  readonly summary: ModuleSummary;
  readonly localFingerprints: ReadonlyMap<string, string>;
  readonly importBindingFingerprints: ReadonlyMap<string, string>;
  readonly sideEffectImportTargets: ReadonlySet<string>;
  readonly namedReexportFingerprints: ReadonlyMap<string, string>;
  readonly wildcardReexportTargets: ReadonlySet<string>;
  readonly topLevelSideEffectFingerprints: readonly string[];
}

function analyzeModuleDetailed(
  rawFile: string,
  source: string,
  knownFiles: ReadonlySet<string>,
  computeFingerprints: boolean,
): DetailedModuleAnalysis {
  const file = toRepoPosixPath(rawFile);
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) {
    return {
      summary: {
        file,
        imports: [],
        reexports: [],
        localDecls: new Map(),
        exportedLocals: new Map(),
        topLevelSideEffectRefs: new Set(),
        parseFailed: true,
      },
      localFingerprints: new Map(),
      importBindingFingerprints: new Map(),
      sideEffectImportTargets: new Set(),
      namedReexportFingerprints: new Map(),
      wildcardReexportTargets: new Set(),
      topLevelSideEffectFingerprints: [],
    };
  }

  const imports: ModuleImportEdge[] = [];
  const seenImports = new Set<string>();
  const addImport = (edge: ModuleImportEdge): void => {
    const key = `${edge.target}\0${edge.imported}\0${edge.local ?? ""}`;
    if (seenImports.has(key)) return;
    seenImports.add(key);
    imports.push(edge);
  };

  const reexports: ModuleReexportEdge[] = [];
  const localDecls = new Map<string, Set<string>>();
  const exportedLocals = new Map<string, string>();
  const topLevelSideEffectRefs = new Set<string>();
  const localFingerprints = new Map<string, string>();
  const importBindingFingerprints = new Map<string, string>();
  const sideEffectImportTargets = new Set<string>();
  const namedReexportFingerprints = new Map<string, string>();
  const wildcardReexportTargets = new Set<string>();
  const topLevelSideEffectFingerprints: string[] = [];

  const body = (parsed.program as unknown as { body: AstNode[] }).body;
  for (const stmt of body) {
    if (stmt.type === "EmptyStatement" || isTypeOnlyNode(stmt)) continue;

    if (stmt.type === "ImportDeclaration") {
      if (stmt.importKind === "type") continue;
      const spec = staticStringValue(stmt.source);
      if (spec === null) continue;
      const target = resolveRelativeModule(file, spec, knownFiles);
      const specifiers = Array.isArray(stmt.specifiers) ? (stmt.specifiers as AstNode[]) : [];
      if (specifiers.length === 0) {
        sideEffectImportTargets.add(target ?? spec);
        if (target !== null) addImport({ target, imported: "*", local: null });
        continue;
      }
      for (const s of specifiers) {
        if (s.importKind === "type" || !isAstNode(s.local) || s.local.type !== "Identifier") continue;
        const local = s.local.name as string;
        let imported: string | "*" = "*";
        if (s.type === "ImportDefaultSpecifier") imported = "default";
        else if (s.type === "ImportNamespaceSpecifier") imported = "*";
        else if (s.type === "ImportSpecifier") {
          const name = exportOrImportName(s.imported);
          if (name === null) continue;
          imported = name;
        }
        importBindingFingerprints.set(local, `${target ?? spec}#${imported}`);
        if (target !== null) addImport({ target, imported, local });
      }
      continue;
    }

    if (stmt.type === "ExportAllDeclaration") {
      if (stmt.exportKind === "type") continue;
      const spec = staticStringValue(stmt.source);
      if (spec === null) continue;
      const target = resolveRelativeModule(file, spec, knownFiles);
      const exported = exportOrImportName(stmt.exported);
      if (exported === null) {
        wildcardReexportTargets.add(target ?? spec);
        if (target !== null) reexports.push({ target, exported: "*", imported: "*" });
      } else {
        namedReexportFingerprints.set(exported, `${target ?? spec}#*`);
        if (target !== null) reexports.push({ target, exported, imported: "*" });
      }
      continue;
    }

    if (stmt.type === "ExportNamedDeclaration") {
      if (stmt.exportKind === "type") continue;
      if (stmt.source) {
        const spec = staticStringValue(stmt.source);
        if (spec === null) continue;
        const target = resolveRelativeModule(file, spec, knownFiles);
        const specifiers = Array.isArray(stmt.specifiers) ? (stmt.specifiers as AstNode[]) : [];
        for (const s of specifiers) {
          if (s.exportKind === "type") continue;
          const imported = exportOrImportName(s.local);
          const exported = exportOrImportName(s.exported);
          if (imported === null || exported === null) continue;
          namedReexportFingerprints.set(exported, `${target ?? spec}#${imported}`);
          if (target !== null) reexports.push({ target, exported, imported });
        }
        continue;
      }
      if (isAstNode(stmt.declaration)) {
        const names = recordDeclaration(stmt.declaration, localDecls, computeFingerprints ? localFingerprints : undefined);
        for (const name of names) exportedLocals.set(name, name);
      }
      const specifiers = Array.isArray(stmt.specifiers) ? (stmt.specifiers as AstNode[]) : [];
      for (const s of specifiers) {
        if (s.exportKind === "type") continue;
        const local = exportOrImportName(s.local);
        const exported = exportOrImportName(s.exported);
        if (local !== null && exported !== null) exportedLocals.set(exported, local);
      }
      continue;
    }

    if (stmt.type === "ExportDefaultDeclaration") {
      if (stmt.exportKind === "type" || !isAstNode(stmt.declaration) || isTypeOnlyNode(stmt.declaration)) continue;
      const decl = stmt.declaration;
      if (decl.type === "Identifier") {
        exportedLocals.set("default", decl.name as string);
      } else if ((decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && isAstNode(decl.id) && decl.id.type === "Identifier") {
        const names = recordDeclaration(decl, localDecls, computeFingerprints ? localFingerprints : undefined);
        if (names[0]) exportedLocals.set("default", names[0]);
      } else {
        const refs = new Set<string>();
        collectRuntimeRefs(decl, refs);
        localDecls.set("default", refs);
        if (computeFingerprints) localFingerprints.set("default", canonicalFingerprint(decl));
        exportedLocals.set("default", "default");
      }
      continue;
    }

    if (stmt.type === "VariableDeclaration" || stmt.type === "FunctionDeclaration" || stmt.type === "ClassDeclaration" || stmt.type === "TSEnumDeclaration") {
      recordDeclaration(stmt, localDecls, computeFingerprints ? localFingerprints : undefined);
      continue;
    }

    collectRuntimeRefs(stmt, topLevelSideEffectRefs);
    if (computeFingerprints) topLevelSideEffectFingerprints.push(canonicalFingerprint(stmt));
  }

  if (DYNAMIC_OR_MOCK_HINT.test(source)) {
    collectDynamicAndMockImports(parsed.program, file, knownFiles, addImport);
  }

  return {
    summary: { file, imports, reexports, localDecls, exportedLocals, topLevelSideEffectRefs, parseFailed: false },
    localFingerprints,
    importBindingFingerprints,
    sideEffectImportTargets,
    namedReexportFingerprints,
    wildcardReexportTargets,
    topLevelSideEffectFingerprints,
  };
}

export function extractModuleEdges(
  rawFile: string,
  source: string,
  knownFiles: ReadonlySet<string>,
): { imports: ModuleImportEdge[]; reexports: ModuleReexportEdge[]; parseFailed: boolean } {
  const file = toRepoPosixPath(rawFile);
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) return { imports: [], reexports: [], parseFailed: true };

  const imports: ModuleImportEdge[] = [];
  const seenImports = new Set<string>();
  const addImport = (edge: ModuleImportEdge): void => {
    const key = `${edge.target}\0${edge.imported}\0${edge.local ?? ""}`;
    if (seenImports.has(key)) return;
    seenImports.add(key);
    imports.push(edge);
  };
  const reexports: ModuleReexportEdge[] = [];
  const mod = parsed.module;

  for (const imp of mod.staticImports) {
    const target = resolveRelativeModule(file, imp.moduleRequest.value, knownFiles);
    if (target === null) continue;
    if (imp.entries.length === 0) {
      addImport({ target, imported: "*", local: null });
      continue;
    }
    for (const entry of imp.entries) {
      if (entry.isType) continue;
      const local = entry.localName.value;
      const kind = entry.importName.kind;
      if (kind === "Default") addImport({ target, imported: "default", local });
      else if (kind === "NamespaceObject") addImport({ target, imported: "*", local });
      else if (kind === "Name" && entry.importName.name !== null) addImport({ target, imported: entry.importName.name, local });
    }
  }

  for (const exp of mod.staticExports) {
    for (const entry of exp.entries) {
      if (entry.isType || !entry.moduleRequest) continue;
      const target = resolveRelativeModule(file, entry.moduleRequest.value, knownFiles);
      if (target === null) continue;
      const inKind = entry.importName.kind;
      if (inKind === "AllButDefault") reexports.push({ target, exported: "*", imported: "*" });
      else if (inKind === "All" && entry.exportName.name !== null) reexports.push({ target, exported: entry.exportName.name, imported: "*" });
      else if (inKind === "Name" && entry.importName.name !== null && entry.exportName.name !== null) {
        reexports.push({ target, exported: entry.exportName.name, imported: entry.importName.name });
      }
    }
  }

  // Only deserialize the full JS AST for files that actually contain dynamic imports or vi.* mock helpers.
  if (mod.dynamicImports.length > 0 || VI_MOCK_HINT.test(source)) {
    collectDynamicAndMockImports(parsed.program, file, knownFiles, addImport);
  }
  return { imports, reexports, parseFailed: false };
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function expandDirtyLocals(seeds: Iterable<string>, ...declMaps: readonly ReadonlyMap<string, ReadonlySet<string>>[]): Set<string> {
  const reverse = new Map<string, Set<string>>();
  for (const decls of declMaps) {
    for (const [name, refs] of decls) {
      for (const ref of refs) {
        let dependents = reverse.get(ref);
        if (!dependents) {
          dependents = new Set();
          reverse.set(ref, dependents);
        }
        dependents.add(name);
      }
    }
  }
  const dirty = new Set<string>();
  const queue: string[] = [];
  for (const seed of seeds) {
    if (!dirty.has(seed)) {
      dirty.add(seed);
      queue.push(seed);
    }
  }
  while (queue.length > 0) {
    const cur = queue.pop()!;
    const dependents = reverse.get(cur);
    if (!dependents) continue;
    for (const dep of dependents) {
      if (!dirty.has(dep)) {
        dirty.add(dep);
        queue.push(dep);
      }
    }
  }
  return dirty;
}

export function analyzeModuleSource(file: string, source: string, knownFiles: ReadonlySet<string>): ModuleSummary {
  return analyzeModuleDetailed(file, source, knownFiles, false).summary;
}

export function diffChangedExports(
  file: string,
  oldSource: string | undefined,
  newSource: string | undefined,
  knownFiles: ReadonlySet<string>,
): ExportChangeSet {
  if (oldSource === undefined) return { kind: "all", reason: "added file" };
  if (newSource === undefined) return { kind: "all", reason: "deleted file" };
  if (oldSource === newSource) return { kind: "none" };

  const prev = analyzeModuleDetailed(file, oldSource, knownFiles, true);
  if (prev.summary.parseFailed) return { kind: "all", reason: "base file failed to parse" };
  const next = analyzeModuleDetailed(file, newSource, knownFiles, true);
  if (next.summary.parseFailed) return { kind: "all", reason: "working-tree file failed to parse" };

  if (!setsEqual(prev.sideEffectImportTargets, next.sideEffectImportTargets)) {
    return { kind: "all", reason: "side-effect import changed" };
  }
  if (!arraysEqual(prev.topLevelSideEffectFingerprints, next.topLevelSideEffectFingerprints)) {
    return { kind: "all", reason: "top-level side effect changed" };
  }
  if (!setsEqual(prev.wildcardReexportTargets, next.wildcardReexportTargets)) {
    return { kind: "all", reason: "wildcard export * changed" };
  }

  const changedLocals = new Set<string>();
  for (const name of new Set([...prev.localFingerprints.keys(), ...next.localFingerprints.keys()])) {
    if (prev.localFingerprints.get(name) !== next.localFingerprints.get(name)) changedLocals.add(name);
  }
  for (const name of new Set([...prev.importBindingFingerprints.keys(), ...next.importBindingFingerprints.keys()])) {
    if (prev.importBindingFingerprints.get(name) !== next.importBindingFingerprints.get(name)) changedLocals.add(name);
  }

  const dirtyLocals = expandDirtyLocals(changedLocals, prev.summary.localDecls, next.summary.localDecls);
  for (const ref of [...prev.summary.topLevelSideEffectRefs, ...next.summary.topLevelSideEffectRefs]) {
    if (dirtyLocals.has(ref)) return { kind: "all", reason: `top-level side effect uses changed binding ${ref}` };
  }

  const changedExports = new Set<string>();
  for (const exp of new Set([...prev.summary.exportedLocals.keys(), ...next.summary.exportedLocals.keys()])) {
    const oldLocal = prev.summary.exportedLocals.get(exp);
    const newLocal = next.summary.exportedLocals.get(exp);
    if (oldLocal !== newLocal || (oldLocal !== undefined && dirtyLocals.has(oldLocal)) || (newLocal !== undefined && dirtyLocals.has(newLocal))) {
      changedExports.add(exp);
    }
  }
  for (const exp of new Set([...prev.namedReexportFingerprints.keys(), ...next.namedReexportFingerprints.keys()])) {
    if (prev.namedReexportFingerprints.get(exp) !== next.namedReexportFingerprints.get(exp)) changedExports.add(exp);
  }

  if (changedExports.size === 0) return { kind: "none" };
  return { kind: "symbols", symbols: [...changedExports].sort() };
}

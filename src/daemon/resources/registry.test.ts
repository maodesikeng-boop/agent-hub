import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import * as limits from "../../shared/limits.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import {
  RESOURCE_REGISTRY,
  findResourceEntry,
  validateResourceRegistry,
  type ResourceRegistryEntry,
} from "../../shared/resource-registry.ts";
import { openTestDb } from "../store/test-helpers.ts";

function migratedTableNames(): string[] {
  const db = openTestDb();
  try {
    return db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function hubPathStringKeys(): string[] {
  const resolved = resolveHubPaths({}, "/tmp/test-home");
  return Object.entries(resolved)
    .filter(([, value]) => typeof value === "string")
    .map(([key]) => key)
    .sort();
}

function exportedNumericLimitNames(): Set<string> {
  return new Set(
    Object.entries(limits)
      .filter(([, value]) => typeof value === "number")
      .map(([name]) => name),
  );
}

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

function productionSourceFiles(): string[] {
  const srcRoot = join(REPO_ROOT, "src");
  return (readdirSync(srcRoot, { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !/(^|[\\/])(test-helpers|test-utils)\.tsx?$/.test(file) && !file.includes("fixture"))
    .map((file) => relative(REPO_ROOT, join(srcRoot, file)).split(sep).join("/"));
}

const OWNER_TAG_MODULES = new Set(["src/daemon/platform/process-tag.ts", "src/daemon/platform/index.ts"]);
const OWNER_TAG_BUILDER_EXPORT = /^make[A-Z]\w*OwnerTag$/u;
const FORBIDDEN_BUILDER_DECL = /^(?:make[A-Z]\w*OwnerTag|\w*OwnerToken)$/u;
const OWNER_TAG_PREFILTER = /ENV_SESSION_OWNER_TAG|OwnerTag|OwnerToken|:\$\{[^}]*nonce/iu;
const WRAPPERS = new Set(["ParenthesizedExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"]);
const FUNC_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

type AstNode = { type: string; [key: string]: unknown };
const isAstNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as AstNode).type === "string";

function unwrap(node: unknown): AstNode | undefined {
  let current = isAstNode(node) ? node : undefined;
  while (current && WRAPPERS.has(current.type)) current = current.expression as AstNode | undefined;
  return current;
}

function isIdent(node: unknown, name: string): boolean {
  const expr = unwrap(node);
  return expr?.type === "Identifier" && expr.name === name;
}

function collectPatternNames(pattern: unknown, out: Set<string>): void {
  const node = isAstNode(pattern) ? pattern : undefined;
  if (!node) return;
  if (node.type === "Identifier") out.add(node.name as string);
  else if (node.type === "AssignmentPattern") collectPatternNames(node.left, out);
  else if (node.type === "RestElement") collectPatternNames(node.argument, out);
  else if (node.type === "ObjectPattern") {
    for (const prop of (node.properties as unknown[] | undefined) ?? []) {
      if (isAstNode(prop)) collectPatternNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
    }
  } else if (node.type === "ArrayPattern") {
    for (const elem of (node.elements as unknown[] | undefined) ?? []) collectPatternNames(elem, out);
  }
}

function exprContainsNonce(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(exprContainsNonce);
  if (!isAstNode(node)) return false;
  if (node.type === "Identifier" && /nonce/iu.test(node.name as string)) return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (exprContainsNonce(value)) return true;
  }
  return false;
}

function isRawNonSessionNonceTemplate(node: AstNode): boolean {
  if (node.type !== "TemplateLiteral") return false;
  const quasis = (node.quasis as AstNode[] | undefined) ?? [];
  const expressions = (node.expressions as AstNode[] | undefined) ?? [];
  for (let i = 0; i < expressions.length; i++) {
    const rawBefore = ((quasis[i]?.value as { raw?: string } | undefined)?.raw ?? "");
    if (!rawBefore.endsWith(":")) continue;
    // Allow daemon-wide suffix scan `:${tagNonce}` and single-session lookup `s${id}:${nonce}` outside ENV_SESSION_OWNER_TAG writes.
    if (i === 0 && rawBefore === ":") continue;
    if (i === 1 && rawBefore === ":" && ((quasis[0]?.value as { raw?: string } | undefined)?.raw ?? "") === "s") continue;
    if (exprContainsNonce(expressions[i])) return true;
  }
  return false;
}

interface OwnerTagScope {
  params: Set<string>;
  locals: Map<string, AstNode[]>;
}

function collectScopeLocals(root: unknown): Map<string, AstNode[]> {
  const locals = new Map<string, AstNode[]>();
  const add = (name: string, expr: AstNode) => {
    const list = locals.get(name) ?? [];
    list.push(expr);
    locals.set(name, list);
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isAstNode(node) || (node !== root && FUNC_TYPES.has(node.type))) return;
    if (node.type === "VariableDeclarator" && isAstNode(node.id) && node.id.type === "Identifier" && isAstNode(node.init)) {
      add(node.id.name as string, node.init);
    } else if (node.type === "AssignmentExpression" && isAstNode(node.left) && node.left.type === "Identifier" && isAstNode(node.right)) {
      add(node.left.name as string, node.right);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      visit(value);
    }
  };
  visit(root);
  return locals;
}

function isParamPassthrough(expr: AstNode, scopes: readonly OwnerTagScope[]): boolean {
  let current: AstNode | undefined = expr;
  while (current?.type === "MemberExpression" && !current.computed) {
    const prop = current.property as AstNode | undefined;
    if (prop?.type !== "Identifier" || /nonce/iu.test(prop.name as string)) return false;
    current = unwrap(current.object);
  }
  if (current?.type !== "Identifier") return false;
  const name = current.name as string;
  if (/nonce/iu.test(name)) return false;
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i]!;
    if (scope.locals.has(name)) return false;
    if (scope.params.has(name)) return true;
  }
  return false;
}

function isTrustedOwnerTagExpr(
  node: unknown,
  scopes: readonly OwnerTagScope[],
  builders: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
  visiting: Set<string>,
): boolean {
  const expr = unwrap(node);
  if (!expr) return false;
  if (expr.type === "CallExpression") {
    const callee = unwrap(expr.callee);
    if (callee?.type === "Identifier") return builders.has(callee.name as string);
    if (callee?.type === "MemberExpression" && !callee.computed) {
      const obj = unwrap(callee.object);
      const prop = callee.property as AstNode | undefined;
      return obj?.type === "Identifier" && namespaces.has(obj.name as string) && prop?.type === "Identifier" && OWNER_TAG_BUILDER_EXPORT.test(prop.name as string);
    }
    return false;
  }
  if (expr.type === "Identifier") {
    const name = expr.name as string;
    for (let i = scopes.length - 1; i >= 0; i--) {
      const scope = scopes[i]!;
      const inits = scope.locals.get(name);
      if (inits !== undefined) {
        if (visiting.has(name)) return false;
        visiting.add(name);
        const ok = inits.length > 0 && inits.every((init) => isTrustedOwnerTagExpr(init, scopes, builders, namespaces, visiting));
        visiting.delete(name);
        return ok;
      }
      if (scope.params.has(name)) return !/nonce/iu.test(name);
    }
    return false;
  }
  if (expr.type === "MemberExpression") return isParamPassthrough(expr, scopes);
  if (expr.type === "ConditionalExpression") {
    return isTrustedOwnerTagExpr(expr.consequent, scopes, builders, namespaces, visiting)
      && isTrustedOwnerTagExpr(expr.alternate, scopes, builders, namespaces, visiting);
  }
  if (expr.type === "LogicalExpression" && (expr.operator === "??" || expr.operator === "||")) {
    return isTrustedOwnerTagExpr(expr.left, scopes, builders, namespaces, visiting)
      && isTrustedOwnerTagExpr(expr.right, scopes, builders, namespaces, visiting);
  }
  return false;
}

function collectVerifiedBuilderImports(file: string, body: readonly AstNode[]): { builders: Set<string>; namespaces: Set<string> } {
  const builders = new Set<string>();
  const namespaces = new Set<string>();
  for (const stmt of body) {
    if (stmt.type !== "ImportDeclaration" || stmt.importKind === "type") continue;
    const spec = (stmt.source as { value?: string } | undefined)?.value;
    if (!spec || (!spec.startsWith("./") && !spec.startsWith("../"))) continue;
    const target = relative(REPO_ROOT, join(REPO_ROOT, dirname(file), spec)).split(sep).join("/");
    if (!OWNER_TAG_MODULES.has(target)) continue;
    for (const item of (stmt.specifiers as AstNode[] | undefined) ?? []) {
      if (item.type === "ImportNamespaceSpecifier" && isAstNode(item.local)) {
        namespaces.add(item.local.name as string);
      } else if (item.type === "ImportSpecifier" && item.importKind !== "type" && isAstNode(item.imported) && isAstNode(item.local)) {
        const importedName = (item.imported.name ?? item.imported.value) as string | undefined;
        if (importedName && OWNER_TAG_BUILDER_EXPORT.test(importedName)) builders.add(item.local.name as string);
      }
    }
  }
  return { builders, namespaces };
}

function hasRawOwnerTagBuilder(file: string, source: string): boolean {
  const { program, errors } = parseSync(file, source);
  if (errors.length > 0) throw new Error(`${file} does not parse: ${errors[0]!.message}`);
  const body = (program.body as unknown as AstNode[]) ?? [];
  const { builders, namespaces } = collectVerifiedBuilderImports(file, body);
  let violated = false;

  const walk = (node: unknown, scopes: readonly OwnerTagScope[]): void => {
    if (violated) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, scopes);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "ImportDeclaration") return;
    if (node.type === "FunctionDeclaration" && isAstNode(node.id) && FORBIDDEN_BUILDER_DECL.test(node.id.name as string)) {
      violated = true;
      return;
    }
    if (node.type === "VariableDeclarator" && isAstNode(node.id) && node.id.type === "Identifier" && FORBIDDEN_BUILDER_DECL.test(node.id.name as string)) {
      violated = true;
      return;
    }
    if (isRawNonSessionNonceTemplate(node)) {
      violated = true;
      return;
    }
    if (node.type === "Property" && node.computed === true && isIdent(node.key, "ENV_SESSION_OWNER_TAG")) {
      if (!isTrustedOwnerTagExpr(node.value, scopes, builders, namespaces, new Set())) {
        violated = true;
        return;
      }
    }
    if (
      node.type === "AssignmentExpression"
      && isAstNode(node.left)
      && node.left.type === "MemberExpression"
      && node.left.computed === true
      && isIdent(node.left.property, "ENV_SESSION_OWNER_TAG")
    ) {
      if (!isTrustedOwnerTagExpr(node.right, scopes, builders, namespaces, new Set())) {
        violated = true;
        return;
      }
    }
    if (FUNC_TYPES.has(node.type)) {
      const params = new Set<string>();
      for (const p of (node.params as unknown[] | undefined) ?? []) collectPatternNames(p, params);
      const nextScopes = [...scopes, { params, locals: collectScopeLocals(node.body) }];
      walk(node.body, nextScopes);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      walk(value, scopes);
    }
  };

  walk(program, [{ params: new Set(), locals: collectScopeLocals(program) }]);
  return violated;
}

function findRawOwnerTagBuilders(sources: ReadonlyMap<string, string>): string[] {
  const offenders: string[] = [];
  for (const [file, source] of sources) {
    if (file === "src/daemon/platform/process-tag.ts") continue;
    if (!OWNER_TAG_PREFILTER.test(source)) continue;
    if (hasRawOwnerTagBuilder(file, source)) offenders.push(file);
  }
  return offenders.sort();
}

describe("RESOURCE_REGISTRY structural guard", () => {
  it("registers every module that creates a temp directory, so each one names who removes it", () => {
    const owners = new Set(
      RESOURCE_REGISTRY.filter((e) => e.kind === "temp_dir").flatMap((e) => e.owner.split(",").map((part) => part.trim())),
    );
    const creators = productionSourceFiles().filter((file) => /\bmkdtemp(Sync)?\(/.test(readFileSync(join(REPO_ROOT, file), "utf8")));
    expect(creators.length).toBeGreaterThan(0);
    expect(creators.filter((file) => !owners.has(file))).toEqual([]);
  });

  it("constructs every ENV_SESSION_OWNER_TAG token through process-tag.ts so active processes are not misreported as leaked", () => {
    const sources = new Map(productionSourceFiles().map((file) => [file, readFileSync(join(REPO_ROOT, file), "utf8")]));
    expect(findRawOwnerTagBuilders(sources)).toEqual([]);
  });

  it("flags raw owner tag builders, upstream token helpers, wrong builder imports, and hand-concatenated parent chains", () => {
    const sample = new Map<string, string>([
      [
        "src/daemon/launch.ts",
        'import { makeSessionOwnerTag } from "./platform/index.ts"; export function f(id: number, tagNonce: string) { const ownerEnv = makeSessionOwnerTag(id, tagNonce); return { [ENV_SESSION_OWNER_TAG]: ownerEnv }; }',
      ],
      [
        "src/daemon/watches/valid.ts",
        'import { makeWatchOwnerTag as buildTag } from "../platform/process-tag.ts"; export function f(id: number, nonce: string, parent?: string) { return { [ENV_SESSION_OWNER_TAG]: buildTag(id, nonce, parent) }; }',
      ],
      [
        "src/daemon/setup/setup.ts",
        "export function f(paths: { sessionTagEnv?: string }) { return { [ENV_SESSION_OWNER_TAG]: paths.sessionTagEnv }; }",
      ],
      [
        "src/daemon/router/sandbox.ts",
        "export function f(options: { ownerEnv?: string }) { return { [ENV_SESSION_OWNER_TAG]: options.ownerEnv }; }",
      ],
      [
        "src/daemon/watches/raw-session-nonce.ts",
        "export function f(job: { watchId: number }, options: { sessionTagNonce: string }) { const ownTag = `watch${job.watchId}:${options.sessionTagNonce}`; return { [ENV_SESSION_OWNER_TAG]: ownTag }; }",
      ],
      [
        "src/daemon/watches/raw-plain-nonce.ts",
        "export function f(id: number, nonce: string) { const ownTag = `job${id}:${nonce}`; return { [ENV_SESSION_OWNER_TAG]: ownTag }; }",
      ],
      [
        "src/daemon/resources/raw-upstream.ts",
        "export const watchOwnerToken = (watchId: number, nonce: string): string => `watch${watchId}:${nonce}`;",
      ],
      [
        "src/daemon/resources/raw-helper.ts",
        "export const customTag = (id: number, nonce: string): string => `job${id}:${nonce}`;",
      ],
      [
        "src/daemon/fake-builder-def.ts",
        'export function makeJobOwnerTag(id: number, nonce: string) { return "job" + id + ":" + nonce; }',
      ],
      [
        "src/daemon/wrong-import.ts",
        'import { makeWatchOwnerTag } from "./fake-builder-def.ts"; export function f(id: number, nonce: string) { return { [ENV_SESSION_OWNER_TAG]: makeWatchOwnerTag(id, nonce) }; }',
      ],
      [
        "src/daemon/watches/hand-chain.ts",
        'import { makeWatchOwnerTag } from "../platform/index.ts"; export function f(id: number, nonce: string, parentTag?: string) { const ownTag = makeWatchOwnerTag(id, nonce); return { [ENV_SESSION_OWNER_TAG]: parentTag ? `${parentTag},${ownTag}` : ownTag }; }',
      ],
      ["src/daemon/inline-tag.ts", "const env = { [ENV_SESSION_OWNER_TAG]: `job${id}:${nonce}` };"],
    ]);
    expect(findRawOwnerTagBuilders(sample)).toEqual([
      "src/daemon/fake-builder-def.ts",
      "src/daemon/inline-tag.ts",
      "src/daemon/resources/raw-helper.ts",
      "src/daemon/resources/raw-upstream.ts",
      "src/daemon/watches/hand-chain.ts",
      "src/daemon/watches/raw-plain-nonce.ts",
      "src/daemon/watches/raw-session-nonce.ts",
      "src/daemon/wrong-import.ts",
    ]);
  });

  it("covers every non-internal SQLite table created by migrations/*.sql", () => {
    const tables = migratedTableNames();
    expect(tables.length).toBeGreaterThan(0);
    const violations = validateResourceRegistry(RESOURCE_REGISTRY, {
      sqliteTables: tables,
      hubPathKeys: hubPathStringKeys(),
      exportedLimitNames: exportedNumericLimitNames(),
    });
    expect(violations.filter((v) => v.code === "unregistered_table")).toEqual([]);
  });

  it("contains no stale sqlite_table entries missing from the migrated schema", () => {
    const violations = validateResourceRegistry(RESOURCE_REGISTRY, {
      sqliteTables: migratedTableNames(),
      hubPathKeys: hubPathStringKeys(),
      exportedLimitNames: exportedNumericLimitNames(),
    });
    expect(violations.filter((v) => v.code === "stale_table")).toEqual([]);
  });

  it("covers every data-directory path returned by resolveHubPaths", () => {
    const violations = validateResourceRegistry(RESOURCE_REGISTRY, {
      sqliteTables: migratedTableNames(),
      hubPathKeys: hubPathStringKeys(),
      exportedLimitNames: exportedNumericLimitNames(),
    });
    expect(violations).toEqual([]);
  });

  it("covers worker processes, worktrees, managed git branches, session temp directories, and logs", () => {
    expect(findResourceEntry("process", "worker_process_tree")).not.toBeNull();
    expect(findResourceEntry("worktree", "worktreesDir")).not.toBeNull();
    expect(findResourceEntry("git_branch", "managed_hub_branches")).not.toBeNull();
    expect(findResourceEntry("temp_dir", "session_tmp_dirs")).not.toBeNull();
    expect(findResourceEntry("log_file", "logsDir")).not.toBeNull();
    expect(findResourceEntry("log_file", "setupLogsDir")).not.toBeNull();
  });

  it("requires every growing resource to declare a non-empty cleaner and at least one positive limit exported by src/shared/limits.ts", () => {
    const exported = exportedNumericLimitNames();
    const growing = RESOURCE_REGISTRY.filter((e) => e.growth === "growing");
    expect(growing.length).toBeGreaterThan(20);
    for (const entry of growing) {
      expect(entry.cleaner.trim(), entry.id).not.toBe("");
      expect(entry.limits.length, entry.id).toBeGreaterThan(0);
      for (const ref of entry.limits) {
        expect(exported.has(ref.constantName), `${entry.id}:${ref.constantName}`).toBe(true);
        expect(ref.value, `${entry.id}:${ref.constantName}`).toBeGreaterThan(0);
      }
    }
  });

  it("rejects duplicate ids, unknown limit constants, and unregistered tables in validateResourceRegistry", () => {
    const badRegistry: ResourceRegistryEntry[] = [
      {
        id: "table:foo",
        kind: "sqlite_table",
        target: "foo",
        growth: "growing",
        owner: "a.ts",
        cleaner: "",
        cleanupMode: "automatic",
        limits: [],
      },
      {
        id: "table:foo",
        kind: "sqlite_table",
        target: "stale_one",
        growth: "growing",
        owner: "b.ts",
        cleaner: "b.ts",
        cleanupMode: "automatic",
        limits: [
          { constantName: "NO_SUCH_LIMIT", value: 10, unit: "rows" },
          { constantName: "WORKER_RETENTION_DAYS", value: 0, unit: "days" },
        ],
      },
    ];
    const violations = validateResourceRegistry(badRegistry, {
      sqliteTables: ["foo", "bar"],
      hubPathKeys: ["home"],
      exportedLimitNames: exportedNumericLimitNames(),
    });
    const codes = new Set(violations.map((v) => v.code));
    expect(codes).toEqual(
      new Set([
        "duplicate_id",
        "stale_table",
        "missing_cleaner",
        "missing_limit",
        "unknown_limit_constant",
        "non_positive_limit",
        "unregistered_table",
        "unregistered_path",
      ]),
    );
  });

  it("finds registered entries by kind and target via findResourceEntry", () => {
    const msgEntry = findResourceEntry("sqlite_table", "messages");
    expect(msgEntry).toMatchObject({ id: "table:messages", kind: "sqlite_table", target: "messages", growth: "growing" });
    expect(findResourceEntry("sqlite_table", "nonexistent_table")).toBeNull();
    expect(findResourceEntry("data_dir", "messages")).toBeNull();
  });
});

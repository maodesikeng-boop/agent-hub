import { QueryClient } from "@tanstack/react-query";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import type { AccountStatusView } from "../shared/index.ts";
import { ACCOUNT_QUERY_KEY, claimAccountTicket, commitAccountStatus, invalidateAccount, queryGenerationOf } from "./query-client.ts";

const WEB_DIR = resolve(import.meta.dirname);

const CACHE_WRITE = /\.setQueryData\s*[<(]/;
const SHARED_GENERATION = /\b(?:queryGenerationOf|guardedQueryFn)\b/;

// Legacy modules that write the query cache without the shared generation. The list may only shrink.
const LEGACY_UNGUARDED_WRITERS = new Set([
  "components/PmMemoryFilesGroup.tsx",
  "composer-suggest.ts",
  "models.tsx",
  "settings-model.ts",
]);

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };
const isAstNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as AstNode).type === "string";
const WRAPPERS = new Set(["ParenthesizedExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression"]);
const FUNC_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function unwrap(node: unknown): AstNode | undefined {
  let current = isAstNode(node) ? node : undefined;
  while (current && WRAPPERS.has(current.type)) current = current.expression as AstNode;
  return current;
}

function isQueryGenCall(node: unknown): boolean {
  const call = unwrap(node);
  if (call?.type !== "CallExpression") return false;
  const callee = unwrap(call.callee);
  return callee?.type === "Identifier" && callee.name === "queryGenerationOf";
}

function isQueryGenParam(param: unknown): string | null {
  const node = isAstNode(param) ? param : undefined;
  if (node?.type !== "Identifier") return null;
  const ann = (node.typeAnnotation as AstNode | undefined)?.typeAnnotation as AstNode | undefined;
  const typeName = ann?.type === "TSTypeReference" ? (ann.typeName as AstNode | undefined) : undefined;
  return typeName?.type === "Identifier" && typeName.name === "QueryGeneration" ? (node.name as string) : null;
}

function memberProp(node: unknown, names: ReadonlySet<string>): { object: string; prop: string } | null {
  const expr = unwrap(node);
  if (expr?.type !== "MemberExpression" || expr.computed) return null;
  const obj = unwrap(expr.object);
  const prop = expr.property as AstNode | undefined;
  if (obj?.type !== "Identifier" || !names.has(obj.name as string) || prop?.type !== "Identifier") return null;
  return { object: obj.name as string, prop: prop.name as string };
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function nonMonotonicGenerationWrites(file: string, source: string): string[] {
  if (!source.includes("queryGenerationOf")) return [];
  const { program, errors } = parseSync(file, source);
  if (errors.length > 0) throw new Error(`${file} does not parse: ${errors[0]!.message}`);

  const directLatestIncrements: number[] = [];
  const unsafeWithDecoupledLatest: { line: number; detail: string }[] = [];
  let hasDecoupledLatestWrite = false;

  function scanScope(node: unknown, inheritedGen: ReadonlySet<string>): void {
    const genNames = new Set(inheritedGen);
    const genSnapshotLocals = new Set<string>();
    let writesGen = false;
    let writesLatest = false;

    function visit(current: unknown): void {
      if (Array.isArray(current)) return current.forEach(visit);
      if (!isAstNode(current)) return;

      if (FUNC_TYPES.has(current.type) && current !== node) {
        const nextGen = new Set(genNames);
        for (const raw of (current.params as unknown[] | undefined) ?? []) {
          const p = isAstNode(raw) && raw.type === "AssignmentPattern" ? raw.left : raw;
          const genParam = isQueryGenParam(p);
          if (genParam) nextGen.add(genParam);
          else if (isAstNode(p) && p.type === "Identifier") nextGen.delete(p.name as string);
        }
        scanScope(current, nextGen);
        return;
      }

      if (current.type === "VariableDeclarator" && isAstNode(current.id) && current.id.type === "Identifier") {
        const name = current.id.name as string;
        if (isQueryGenCall(current.init)) {
          genNames.add(name);
        } else {
          genNames.delete(name);
          const read = memberProp(current.init, genNames);
          if (read?.prop === "gen") genSnapshotLocals.add(name);
          else genSnapshotLocals.delete(name);
        }
      }

      if (current.type === "UpdateExpression") {
        const target = memberProp(current.argument, genNames);
        if (target?.prop === "latest") {
          writesLatest = true;
          directLatestIncrements.push(lineOf(source, current.start));
        } else if (target?.prop === "gen") {
          writesGen = true;
          unsafeWithDecoupledLatest.push({ line: lineOf(source, current.start), detail: `${target.object}.gen${current.operator}` });
        }
      }

      if (current.type === "AssignmentExpression") {
        const target = memberProp(current.left, genNames);
        if (target?.prop === "latest") {
          writesLatest = true;
          const rhs = unwrap(current.right);
          const rhsMember = memberProp(rhs, genNames);
          if (current.operator !== "=") {
            directLatestIncrements.push(lineOf(source, current.start));
          } else if (rhs?.type === "BinaryExpression" && (rhs.operator === "+" || rhs.operator === "-") && (memberProp(rhs.left, genNames)?.prop === "latest" || memberProp(rhs.right, genNames)?.prop === "latest")) {
            directLatestIncrements.push(lineOf(source, current.start));
          } else if (rhs !== undefined && (rhsMember?.prop === "gen" || (rhs.type === "Identifier" && genSnapshotLocals.has(rhs.name as string)))) {
            unsafeWithDecoupledLatest.push({ line: lineOf(source, current.start), detail: `${target.object}.latest = ${source.slice(rhs.start, rhs.end)}` });
          }
        } else if (target?.prop === "gen") {
          writesGen = true;
          if (current.operator !== "=") {
            unsafeWithDecoupledLatest.push({ line: lineOf(source, current.start), detail: `${target.object}.gen ${current.operator} ...` });
          }
        }
      }

      for (const value of Object.values(current)) if (typeof value === "object") visit(value);
    }

    visit(node);
    if (writesLatest && !writesGen) hasDecoupledLatestWrite = true;
  }

  scanScope(program as unknown as AstNode, new Set());

  const problems: string[] = [];
  for (const line of directLatestIncrements) {
    problems.push(`${file}:${line} increments QueryGeneration.latest directly; advance from Math.max(state.gen, state.latest) + 1 so gen and latest stay strictly monotonic.`);
  }
  if (hasDecoupledLatestWrite) {
    for (const { line, detail } of unsafeWithDecoupledLatest) {
      problems.push(`${file}:${line} mutates QueryGeneration via ${detail} while another path advances .latest independently; compute next = Math.max(state.gen, state.latest) + 1 so tickets never collide or regress.`);
    }
  }
  return problems;
}

function productionSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...productionSources(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files.sort();
}

function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function unguardedCacheWriters(sources: ReadonlyMap<string, string>): string[] {
  const hits: string[] = [];
  for (const [file, source] of sources) {
    const code = codeOf(source);
    if (CACHE_WRITE.test(code) && !SHARED_GENERATION.test(code)) hits.push(file);
  }
  return hits.sort();
}

describe("query cache writes share one generation per query", () => {
  const sources = new Map(productionSources(WEB_DIR).map((file) => [relative(WEB_DIR, file).split("\\").join("/"), readFileSync(file, "utf8")]));
  const unguarded = unguardedCacheWriters(sources);

  it("a module that writes results into the query cache orders them with queryGenerationOf or guardedQueryFn", () => {
    expect(unguarded.filter((file) => !LEGACY_UNGUARDED_WRITERS.has(file))).toEqual([]);
  });

  it("every legacy entry still writes unguarded, so a fixed module leaves the list", () => {
    expect([...LEGACY_UNGUARDED_WRITERS].filter((file) => !unguarded.includes(file))).toEqual([]);
  });

  it("flags a manual write without the shared generation and ignores comments", () => {
    const sample = new Map([
      ["bad.ts", "export function save(qc) { qc.setQueryData<View>(KEY, view); }"],
      ["good.ts", 'import { guardedQueryFn } from "./query-client.ts";\nqc.setQueryData(KEY, view);'],
      ["comment.ts", "// qc.setQueryData(KEY, view)\nexport const x = 1;"],
    ]);
    expect(unguardedCacheWriters(sample)).toEqual(["bad.ts"]);
  });

  it("keeps QueryGeneration counters strictly monotonic across all web modules", () => {
    const violations = [...sources.entries()].flatMap(([file, source]) => nonMonotonicGenerationWrites(file, source));
    expect(violations).toEqual([]);
  });

  it("catches decoupled .latest increments and .latest = .gen regressions", () => {
    const colliding = [
      "export function claim(qc) { const state = queryGenerationOf(qc, 'a'); state.latest += 1; return state.latest; }",
      "export function invalidate(qc) { const state = queryGenerationOf(qc, 'a'); state.gen += 1; state.latest = state.gen; }",
    ].join("\n");
    const highWaterMismatch = [
      "export function claim(qc) { const state = queryGenerationOf(qc, 'a'); const next = Math.max(state.gen, state.latest) + 1; state.latest = next; return next; }",
      "export function invalidate(qc) { const state = queryGenerationOf(qc, 'a'); state.gen += 1; state.latest = state.gen; }",
    ].join("\n");
    const coupled = [
      "export function claim(qc) { const state = queryGenerationOf(qc, 'a'); state.gen += 1; state.latest = state.gen; return state.latest; }",
      "export function commit(qc) { const state = queryGenerationOf(qc, 'a'); state.gen += 1; }",
    ].join("\n");
    const highWaterBoth = [
      "function advance(state: QueryGeneration) { const next = Math.max(state.gen, state.latest) + 1; state.gen = next; state.latest = next; }",
      "export function claim(qc) { const state = queryGenerationOf(qc, 'a'); const next = Math.max(state.gen, state.latest) + 1; state.latest = next; return next; }",
      "export function invalidate(qc) { advance(queryGenerationOf(qc, 'a')); }",
    ].join("\n");

    expect(nonMonotonicGenerationWrites("colliding.ts", colliding)).toHaveLength(3);
    expect(nonMonotonicGenerationWrites("mismatch.ts", highWaterMismatch)).toHaveLength(2);
    expect(nonMonotonicGenerationWrites("coupled.ts", coupled)).toEqual([]);
    expect(nonMonotonicGenerationWrites("good.ts", highWaterBoth)).toEqual([]);
  });

  it("keeps account ticket and invalidation watermarks strictly increasing after failures", async () => {
    const qc = new QueryClient();
    const state = queryGenerationOf(qc, "account");
    const t1 = claimAccountTicket(qc);
    await invalidateAccount(qc);
    expect(state.gen).toBeGreaterThan(t1);
    expect(state.latest).toBeGreaterThan(t1);

    const staleView = { state: "signed_out" } as AccountStatusView;
    const freshView = { state: "signed_in" } as AccountStatusView;
    qc.setQueryData(ACCOUNT_QUERY_KEY, freshView);
    commitAccountStatus(qc, t1, staleView);
    expect(qc.getQueryData(ACCOUNT_QUERY_KEY)).toBe(freshView);

    const t2 = claimAccountTicket(qc);
    const t3 = claimAccountTicket(qc);
    const t4 = claimAccountTicket(qc);
    expect([t2, t3, t4]).toEqual([state.gen + 1, state.gen + 2, state.gen + 3]);

    let prev = t4;
    for (let i = 0; i < 3; i++) {
      await invalidateAccount(qc);
      expect(state.gen).toBeGreaterThan(prev);
      expect(state.latest).toBeGreaterThan(prev);
      prev = state.latest;
    }
    commitAccountStatus(qc, t4, staleView);
    expect(qc.getQueryData(ACCOUNT_QUERY_KEY)).toBe(freshView);
  });
});

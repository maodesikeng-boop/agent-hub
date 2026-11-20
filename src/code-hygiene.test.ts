import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

const FILE_MAX_LINES = 750;
const FUNCTION_MAX_LINES = 120;
const COMMENT_RATIO_MAX = 0.015;
const BASELINE_PATH = "src/code-hygiene.baseline.json";

const NON_PRODUCTION = /\.test\.tsx?$|(^|\/)(test|fake)-[\w-]+\.tsx?$|fixture/;
const COMMENT_RULES: readonly { pattern: RegExp; problem: string; fix: string }[] = [
  { pattern: /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/, problem: "non-English comment", fix: "rewrite it as one concise English line or delete it" },
  { pattern: /^[\s*]*(-{4,}|={4,})/, problem: "section banner", fix: "delete the banner" },
  { pattern: /(?<![\w./-])docs\/|\bM[0-4]\b/, problem: "doc or milestone reference", fix: "drop the reference and keep only the non-obvious why" },
];

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };
type FunctionSize = { key: string; line: number; lines: number };
type CommentIssue = { line: number; problem: string; fix: string };
type FileReport = { path: string; lines: number; commentLines: number; commentIssues: CommentIssue[]; functions: FunctionSize[] };
type Baseline = { files: Record<string, number>; functions: Record<string, number>; commentDebt: Record<string, number> };

const isAstNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as AstNode).type === "string";
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function lineIndex(source: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function propertyName(node: unknown): string | undefined {
  if (!isAstNode(node)) return undefined;
  if (node.type === "Identifier" || node.type === "PrivateIdentifier") return node.name as string;
  if (node.type === "Literal") return String(node.value);
  if (node.type === "MemberExpression") return propertyName(node.property);
  return undefined;
}

function functionName(fn: AstNode, parent: AstNode | undefined, enclosing: string): string {
  const own = propertyName(fn.id);
  if (own) return own;
  if (parent?.type === "VariableDeclarator") return propertyName(parent.id) ?? `${enclosing}>anonymous`;
  if (parent && /^(Property|MethodDefinition|PropertyDefinition)$/.test(parent.type)) return propertyName(parent.key) ?? `${enclosing}>anonymous`;
  if (parent?.type === "AssignmentExpression") return propertyName(parent.left) ?? `${enclosing}>anonymous`;
  const context = parent?.type === "CallExpression" ? propertyName(parent.callee) : parent?.type === "ReturnStatement" ? "return" : undefined;
  return `${enclosing}>${context ?? "anonymous"}`;
}

function measureFunctions(program: AstNode, lineOf: (offset: number) => number): FunctionSize[] {
  const found: FunctionSize[] = [];
  const seen = new Map<string, number>();
  const visit = (node: AstNode, parent: AstNode | undefined, enclosing: string): void => {
    let inner = enclosing;
    if (FUNCTION_TYPES.has(node.type)) {
      const name = functionName(node, parent, enclosing || "<module>");
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      const line = lineOf(node.start);
      found.push({ key: n === 1 ? name : `${name}~${n}`, line, lines: lineOf(node.end) - line + 1 });
      inner = name;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) if (isAstNode(child)) visit(child, node, inner);
      if (isAstNode(value)) visit(value, node, inner);
    }
  };
  visit(program, undefined, "");
  return found;
}

function inspectComments(comments: readonly AstNode[], lineOf: (offset: number) => number): { commentLines: number; issues: CommentIssue[] } {
  const covered = new Set<number>();
  const issues: CommentIssue[] = [];
  for (const comment of comments) {
    const first = lineOf(comment.start);
    for (let l = first; l <= lineOf(comment.end); l++) covered.add(l);
    (comment.value as string).split("\n").forEach((text, i) => {
      const rule = COMMENT_RULES.find((r) => r.pattern.test(text));
      if (rule) issues.push({ line: first + i, problem: rule.problem, fix: rule.fix });
    });
  }
  return { commentLines: covered.size, issues };
}

function analyzeSource(path: string, source: string): FileReport {
  const { program, comments, errors } = parseSync(path, source);
  if (errors.length > 0) throw new Error(`${path}: parse failed: ${errors[0]!.message}`);
  const lineOf = lineIndex(source);
  const { commentLines, issues } = inspectComments(comments as unknown as AstNode[], lineOf);
  const lines = source.endsWith("\n") ? lineOf(source.length - 1) : lineOf(source.length);
  return { path, lines, commentLines, commentIssues: issues, functions: measureFunctions(program as unknown as AstNode, lineOf) };
}

function ratchet(label: string, current: number, recorded: number | undefined, limit: number, howToFix: string): string[] {
  const allowed = recorded ?? limit;
  if (current > allowed) return [`${label}: ${current} exceeds the limit of ${allowed}. ${howToFix}`];
  if (recorded !== undefined && current < recorded) {
    const update = current > limit ? `lower it to ${current}` : "delete the entry";
    return [`${label}: shrank from ${recorded} to ${current}; ${update} in ${BASELINE_PATH} so it cannot grow back`];
  }
  return [];
}

function checkCommentIssues(report: FileReport, baseline: Baseline): string[] {
  const debt = baseline.commentDebt[report.path];
  const count = report.commentIssues.length;
  if (count > (debt ?? 0)) return report.commentIssues.map((i) => `${report.path}:${i.line}: ${i.problem}; ${i.fix}`);
  return ratchet(`${report.path} comment debt`, count, debt, 0, "");
}

function checkFile(report: FileReport, baseline: Baseline): string[] {
  const fileFix = "Move cohesive parts into focused modules.";
  const functionFix = "Extract named helpers with explicit typed parameters, or split the factory closure into small modules.";
  return [
    ...ratchet(`${report.path} file length`, report.lines, baseline.files[report.path], FILE_MAX_LINES, fileFix),
    ...report.functions.flatMap((f) =>
      ratchet(`${report.path}:${f.line} function ${f.key}`, f.lines, baseline.functions[`${report.path}#${f.key}`], FUNCTION_MAX_LINES, functionFix),
    ),
    ...checkCommentIssues(report, baseline),
  ];
}

function staleEntries(reports: readonly FileReport[], baseline: Baseline): string[] {
  const paths = new Set(reports.map((r) => r.path));
  const functions = new Set(reports.flatMap((r) => r.functions.map((f) => `${r.path}#${f.key}`)));
  const missing = [
    ...Object.keys(baseline.files).filter((p) => !paths.has(p)),
    ...Object.keys(baseline.commentDebt).filter((p) => !paths.has(p)),
    ...Object.keys(baseline.functions).filter((k) => !functions.has(k)),
  ];
  return missing.map((key) => `${key}: no longer exists; delete its entry in ${BASELINE_PATH}`);
}

function checkHygiene(reports: readonly FileReport[], baseline: Baseline): string[] {
  const violations = [...reports.flatMap((r) => checkFile(r, baseline)), ...staleEntries(reports, baseline)];
  const lines = reports.reduce((sum, r) => sum + r.lines, 0);
  const commentLines = reports.reduce((sum, r) => sum + r.commentLines, 0);
  if (lines > 0 && commentLines / lines > COMMENT_RATIO_MAX) {
    const ratio = ((commentLines / lines) * 100).toFixed(2);
    violations.push(`comment lines are ${ratio}% of production code, above ${COMMENT_RATIO_MAX * 100}%; delete comments that restate the code`);
  }
  return violations;
}

function productionFiles(dir: string, root: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return productionFiles(full, root);
    const rel = relative(root, full).split("\\").join("/");
    return /\.tsx?$/.test(entry.name) && !NON_PRODUCTION.test(rel) ? [rel] : [];
  });
}

const EMPTY: Baseline = { files: {}, functions: {}, commentDebt: {} };
const body = (n: number) => Array.from({ length: n }, (_, i) => `  const v${i} = ${i};`).join("\n");
const fn = (name: string, bodyLines: number) => `export function ${name}() {\n${body(bodyLines)}\n}\n`;

describe("code hygiene guard", () => {
  it("keeps every production file under src within the comment, file, and function limits", () => {
    const root = resolve(".");
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    const reports = productionFiles(join(root, "src"), root).map((path) => analyzeSource(path, readFileSync(join(root, path), "utf8")));
    expect(checkHygiene(reports, baseline)).toEqual([]);
  });

  it("reports non-English comments, banners, and doc references with file, line, and fix", () => {
    const source = "// 中文注释\nconst a = 1;\n// ----- Section -----\n/** See docs/plan.md for M2. */\nexport const b = a;\n";
    const violations = checkHygiene([analyzeSource("src/x.ts", source)], EMPTY);
    expect(violations).toEqual([
      "src/x.ts:1: non-English comment; rewrite it as one concise English line or delete it",
      "src/x.ts:3: section banner; delete the banner",
      "src/x.ts:4: doc or milestone reference; drop the reference and keep only the non-obvious why",
      expect.stringContaining("comment lines are 60.00% of production code"),
    ]);
  });

  it("allows English comments and external URLs under docs/ paths", () => {
    const source = `${body(200)}\n// Checked against https://example.com/docs/env (2026-11).\nexport const ok = 1;\n`;
    expect(checkHygiene([analyzeSource("src/x.ts", source)], EMPTY)).toEqual([]);
  });

  it("rejects a new function over the limit and a recorded function that grows by one line", () => {
    const source = `${fn("fresh", FUNCTION_MAX_LINES - 1)}${fn("legacy", 200)}`;
    const baseline: Baseline = { ...EMPTY, functions: { "src/x.ts#legacy": 201 } };
    const violations = checkHygiene([analyzeSource("src/x.ts", source)], baseline);
    expect(violations).toEqual([
      expect.stringMatching(/^src\/x\.ts:1 function fresh: 121 exceeds the limit of 120\. Extract named helpers/),
      expect.stringMatching(/^src\/x\.ts:122 function legacy: 202 exceeds the limit of 201\./),
    ]);
  });

  it("names anonymous callbacks after their enclosing function and callee", () => {
    const source = `export function outer() {\n  run(() => {\n${body(130)}\n  });\n}\n`;
    const keys = analyzeSource("src/x.ts", source).functions.map((f) => f.key);
    expect(keys).toEqual(["outer", "outer>run"]);
  });

  it("forces the baseline down when a recorded file or function shrinks, and drops stale entries", () => {
    const source = fn("legacy", 150);
    const baseline: Baseline = { files: { "src/x.ts": 800, "src/gone.ts": 900 }, functions: { "src/x.ts#legacy": 160 }, commentDebt: {} };
    expect(checkHygiene([analyzeSource("src/x.ts", source)], baseline)).toEqual([
      `src/x.ts file length: shrank from 800 to 152; delete the entry in ${BASELINE_PATH} so it cannot grow back`,
      `src/x.ts:1 function legacy: shrank from 160 to 152; lower it to 152 in ${BASELINE_PATH} so it cannot grow back`,
      `src/gone.ts: no longer exists; delete its entry in ${BASELINE_PATH}`,
    ]);
  });

  it("rejects a new file over the file length limit", () => {
    const violations = checkHygiene([analyzeSource("src/x.ts", `${body(FILE_MAX_LINES + 1)}\n`)], EMPTY);
    expect(violations).toEqual([expect.stringMatching(/^src\/x\.ts file length: 751 exceeds the limit of 750\. Move cohesive parts/)]);
  });
});

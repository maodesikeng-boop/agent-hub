import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

const FILE_MAX_LINES = 1000;
const TS_FUNCTION_MAX_LINES = 250;
const TSX_FUNCTION_MAX_LINES = 300;
const BASELINE_PATH = "src/code-hygiene.baseline.json";

const NON_PRODUCTION = /\.test\.tsx?$|Tests\.swift$|(^|\/)(Tests|tests)\/|(^|\/)(test|fake)-[\w-]+\.tsx?$|fixture/;
const SKIP_DIRS = new Set(["target", ".build", "DerivedData", "node_modules", "dist", "build", ".git"]);
const TS_SOURCE = /\.tsx?$/;
const NATIVE_SOURCE = /\.(swift|rs)$/;
const COMMENT_RULES: readonly { pattern: RegExp; problem: string; fix: string }[] = [
  { pattern: /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/, problem: "non-English comment", fix: "rewrite it as one concise English line or delete it" },
  { pattern: /^[\s*]*(-{4,}|={4,})/, problem: "section banner", fix: "delete the banner" },
  { pattern: /(?<![\w./-])docs\/|\bM[0-4]\b/, problem: "doc or milestone reference", fix: "drop the reference and keep only the non-obvious why" },
];

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };
type FunctionSize = { key: string; line: number; lines: number };
type CommentIssue = { line: number; problem: string; fix: string };
type FileReport = { path: string; lines: number; commentIssues: CommentIssue[]; functions: FunctionSize[] };
type Baseline = { files: Record<string, number>; functions: Record<string, number> };

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

function inspectComments(comments: readonly AstNode[], lineOf: (offset: number) => number): CommentIssue[] {
  const issues: CommentIssue[] = [];
  for (const comment of comments) {
    const first = lineOf(comment.start);
    (comment.value as string).split("\n").forEach((text, i) => {
      const rule = COMMENT_RULES.find((r) => r.pattern.test(text));
      if (rule) issues.push({ line: first + i, problem: rule.problem, fix: rule.fix });
    });
  }
  return issues;
}

function countLines(source: string, lineOf: (offset: number) => number): number {
  if (source.length === 0) return 0;
  return source.endsWith("\n") ? lineOf(source.length - 1) : lineOf(source.length);
}

function analyzeSource(path: string, source: string): FileReport {
  const lineOf = lineIndex(source);
  const lines = countLines(source, lineOf);
  if (!TS_SOURCE.test(path)) return { path, lines, commentIssues: [], functions: [] };
  const { program, comments, errors } = parseSync(path, source);
  if (errors.length > 0) throw new Error(`${path}: parse failed: ${errors[0]!.message}`);
  const issues = inspectComments(comments as unknown as AstNode[], lineOf);
  return { path, lines, commentIssues: issues, functions: measureFunctions(program as unknown as AstNode, lineOf) };
}

function ratchet(label: string, current: number, recorded: number | undefined, limit: number, howToFix: string): string[] {
  const allowed = Math.max(recorded ?? limit, limit);
  return current > allowed ? [`${label}: ${current} exceeds the limit of ${allowed}. ${howToFix}`] : [];
}

const functionLimit = (path: string): number => (path.endsWith(".tsx") ? TSX_FUNCTION_MAX_LINES : TS_FUNCTION_MAX_LINES);

function checkFile(report: FileReport, baseline: Baseline): string[] {
  const fileFix = "Move cohesive parts into focused modules.";
  const functionFix = "Extract named helpers with explicit typed parameters, or split the factory closure into small modules.";
  return [
    ...ratchet(`${report.path} file length`, report.lines, baseline.files[report.path], FILE_MAX_LINES, fileFix),
    ...report.functions.flatMap((f) =>
      ratchet(`${report.path}:${f.line} function ${f.key}`, f.lines, baseline.functions[`${report.path}#${f.key}`], functionLimit(report.path), functionFix),
    ),
    ...report.commentIssues.map((i) => `${report.path}:${i.line}: ${i.problem}; ${i.fix}`),
  ];
}

function checkHygiene(reports: readonly FileReport[], baseline: Baseline): string[] {
  return reports.flatMap((r) => checkFile(r, baseline));
}

function productionFiles(dir: string, root: string, matcher: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : productionFiles(join(dir, entry.name), root, matcher);
    }
    const full = join(dir, entry.name);
    const rel = relative(root, full).split("\\").join("/");
    return matcher.test(entry.name) && !NON_PRODUCTION.test(rel) ? [rel] : [];
  });
}

const EMPTY: Baseline = { files: {}, functions: {} };
const body = (n: number) => Array.from({ length: n }, (_, i) => `  const v${i} = ${i};`).join("\n");
const fn = (name: string, bodyLines: number) => `export function ${name}() {\n${body(bodyLines)}\n}\n`;

describe("code hygiene guard", () => {
  it("keeps every production file under src and apps within the file, function, and comment rules", () => {
    const root = resolve(".");
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    const files = [
      ...productionFiles(join(root, "src"), root, TS_SOURCE),
      ...productionFiles(join(root, "apps"), root, NATIVE_SOURCE),
    ];
    expect(files.some((path) => path.endsWith(".swift"))).toBe(true);
    expect(files.some((path) => path.endsWith(".rs"))).toBe(true);
    expect(files.some((path) => /(^|\/)Tests\//.test(path) || path.endsWith("Tests.swift"))).toBe(false);
    const reports = files.map((path) => analyzeSource(path, readFileSync(join(root, path), "utf8")));
    expect(checkHygiene(reports, baseline)).toEqual([]);
  });

  it("reports non-English comments, banners, and doc references with file, line, and fix", () => {
    const source = "// 中文注释\nconst a = 1;\n// ----- Section -----\n/** See docs/plan.md for M2. */\nexport const b = a;\n";
    const violations = checkHygiene([analyzeSource("src/x.ts", source)], EMPTY);
    expect(violations).toEqual([
      "src/x.ts:1: non-English comment; rewrite it as one concise English line or delete it",
      "src/x.ts:3: section banner; delete the banner",
      "src/x.ts:4: doc or milestone reference; drop the reference and keep only the non-obvious why",
    ]);
  });

  it("allows English comments and external URLs under docs/ paths", () => {
    const source = `${body(200)}\n// Checked against https://example.com/docs/env (2026-11).\nexport const ok = 1;\n`;
    expect(checkHygiene([analyzeSource("src/x.ts", source)], EMPTY)).toEqual([]);
  });

  it("rejects a new .ts function over 250 lines", () => {
    const violations = checkHygiene([analyzeSource("src/x.ts", fn("fresh", TS_FUNCTION_MAX_LINES - 1))], EMPTY);
    expect(violations).toEqual([expect.stringMatching(/^src\/x\.ts:1 function fresh: 251 exceeds the limit of 250\. Extract named helpers/)]);
  });

  it("allows a 280-line .tsx function but rejects one over 300 lines", () => {
    expect(checkHygiene([analyzeSource("src/x.tsx", fn("Ok", 278))], EMPTY)).toEqual([]);
    const violations = checkHygiene([analyzeSource("src/x.tsx", fn("Big", TSX_FUNCTION_MAX_LINES - 1))], EMPTY);
    expect(violations).toEqual([expect.stringMatching(/^src\/x\.tsx:1 function Big: 301 exceeds the limit of 300\./)]);
  });

  it("rejects a recorded function that grows by one line", () => {
    const baseline: Baseline = { ...EMPTY, functions: { "src/x.ts#legacy": 301 } };
    expect(checkHygiene([analyzeSource("src/x.ts", fn("legacy", 299))], baseline)).toEqual([]);
    expect(checkHygiene([analyzeSource("src/x.ts", fn("legacy", 300))], baseline)).toEqual([
      expect.stringMatching(/^src\/x\.ts:1 function legacy: 302 exceeds the limit of 301\./),
    ]);
  });

  it("names anonymous callbacks after their enclosing function and callee", () => {
    const source = `export function outer() {\n  run(() => {\n${body(130)}\n  });\n}\n`;
    const keys = analyzeSource("src/x.ts", source).functions.map((f) => f.key);
    expect(keys).toEqual(["outer", "outer>run"]);
  });

  it("lets recorded files and functions shrink or disappear without touching the baseline", () => {
    const baseline: Baseline = { files: { "src/x.ts": 1200, "src/gone.ts": 1500 }, functions: { "src/x.ts#legacy": 400, "src/gone.ts#old": 400 } };
    expect(checkHygiene([analyzeSource("src/x.ts", fn("legacy", 150))], baseline)).toEqual([]);
  });

  it("rejects a recorded file that grows by one line", () => {
    const baseline: Baseline = { ...EMPTY, files: { "src/x.ts": 1100 } };
    expect(checkHygiene([analyzeSource("src/x.ts", `${body(1100)}\n`)], baseline)).toEqual([]);
    expect(checkHygiene([analyzeSource("src/x.ts", `${body(1101)}\n`)], baseline)).toEqual([
      expect.stringMatching(/^src\/x\.ts file length: 1101 exceeds the limit of 1100\./),
    ]);
  });

  it("rejects a new file over the file length limit", () => {
    const violations = checkHygiene([analyzeSource("src/x.ts", `${body(FILE_MAX_LINES + 1)}\n`)], EMPTY);
    expect(violations).toEqual([expect.stringMatching(/^src\/x\.ts file length: 1001 exceeds the limit of 1000\. Move cohesive parts/)]);
  });

  it("enforces the file length limit and shrink ratchet on Swift and Rust files under apps", () => {
    const swiftLines = Array.from({ length: FILE_MAX_LINES + 1 }, (_, i) => `let v${i} = ${i}`).join("\n");
    const rustLines = Array.from({ length: 1101 }, (_, i) => `let v${i} = ${i};`).join("\n");
    const baseline: Baseline = { ...EMPTY, files: { "apps/windows/crates/old/src/lib.rs": 1100 } };

    expect(checkHygiene([analyzeSource("apps/macos/NewView.swift", `${swiftLines}\n`)], EMPTY)).toEqual([
      expect.stringMatching(/^apps\/macos\/NewView\.swift file length: 1001 exceeds the limit of 1000\. Move cohesive parts/),
    ]);
    expect(checkHygiene([analyzeSource("apps/windows/crates/old/src/lib.rs", `${rustLines}\n`)], baseline)).toEqual([
      expect.stringMatching(/^apps\/windows\/crates\/old\/src\/lib\.rs file length: 1101 exceeds the limit of 1100\./),
    ]);
  });
});

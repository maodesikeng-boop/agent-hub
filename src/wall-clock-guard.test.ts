import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

const SCAN_ROOTS = ["src", "scripts", "test"];
const TEST_FILE = /\.test\.tsx?$/;

/** Elapsed-time assertions that predate this guard. A count may only fall; lower the entry when you remove one. */
const BASELINE: Readonly<Record<string, number>> = {
  "src/daemon/agent-api/server.test.ts": 4,
  "src/daemon/driver/background-tasks.test.ts": 1,
  "src/daemon/driver/driver.test.ts": 3,
  "src/daemon/driver/model-catalog.test.ts": 3,
  "src/daemon/driver/process.test.ts": 1,
  "src/daemon/driver/write-scope.test.ts": 2,
  "src/daemon/feishu/service.test.ts": 2,
  "src/daemon/git/git.test.ts": 1,
  "src/daemon/ledger/handover.test.ts": 3,
  "src/daemon/ledger/snapshot-size.test.ts": 1,
  "src/daemon/peers/proxy-upload.test.ts": 1,
  "src/daemon/router/dispatcher.test.ts": 1,
  "src/daemon/sent-files.test.ts": 1,
  "src/daemon/setup/setup.test.ts": 3,
  "src/daemon/store/delivery-receipt.test.ts": 1,
  "src/daemon/workspace-files.test.ts": 1,
  "src/vendors/agy/handover.test.ts": 1,
  "src/web/components/BrowserSessions.test.tsx": 1,
  "test/e2e/account-mesh.test.ts": 2,
  "test/e2e/daemon.test.ts": 1,
  "test/e2e/m2.test.ts": 2,
  "test/e2e/setup.test.ts": 1,
  "test/windows/job-process-tree.test.ts": 1,
};

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };
type Hit = { line: number; text: string };

const isAstNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as AstNode).type === "string";
const WRAPPERS = new Set(["ParenthesizedExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression"]);

function unwrap(node: unknown): AstNode | undefined {
  let current = isAstNode(node) ? node : undefined;
  while (current && WRAPPERS.has(current.type)) current = current.expression as AstNode;
  return current;
}

function isClockRead(node: unknown): boolean {
  const call = unwrap(node);
  if (call?.type !== "CallExpression" || (call.arguments as unknown[]).length > 0) return false;
  const callee = unwrap(call.callee);
  if (callee?.type !== "MemberExpression") return false;
  const object = unwrap(callee.object);
  const property = callee.property as AstNode;
  return object?.type === "Identifier" && ["Date", "performance"].includes(object.name as string) && property.type === "Identifier" && property.name === "now";
}

function isElapsed(node: unknown): boolean {
  const expr = unwrap(node);
  return expr?.type === "BinaryExpression" && expr.operator === "-" && isClockRead(expr.left);
}

function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (!isAstNode(node)) return;
  visit(node);
  for (const value of Object.values(node)) if (typeof value === "object") walk(value, visit);
}

function elapsedNames(program: AstNode): Set<string> {
  const names = new Set<string>();
  walk(program, (node) => {
    if (node.type === "VariableDeclarator" && (node.id as AstNode).type === "Identifier" && isElapsed(node.init)) names.add((node.id as AstNode).name as string);
    if (node.type === "AssignmentExpression" && (node.left as AstNode).type === "Identifier" && isElapsed(node.right)) names.add((node.left as AstNode).name as string);
  });
  return names;
}

/** `expect(...)` calls whose subject is `Date.now()` or `performance.now()` minus a start time, directly or through a local. */
function findElapsedAssertions(fileName: string, source: string): Hit[] {
  const { program, errors } = parseSync(fileName, source);
  if (errors.length > 0) throw new Error(`${fileName} does not parse: ${errors[0]!.message}`);
  const names = elapsedNames(program as unknown as AstNode);
  const hits: Hit[] = [];
  walk(program, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = unwrap(node.callee);
    if (callee?.type !== "Identifier" || callee.name !== "expect") return;
    const subject = unwrap((node.arguments as unknown[])[0]);
    const viaLocal = subject?.type === "Identifier" && names.has(subject.name as string);
    if (!viaLocal && !isElapsed(subject)) return;
    hits.push({ line: source.slice(0, node.start).split("\n").length, text: source.slice(node.start, node.end) });
  });
  return hits;
}

function checkElapsedAssertions(counts: Readonly<Record<string, Hit[]>>, baseline: Readonly<Record<string, number>>): string[] {
  const problems: string[] = [];
  for (const [file, hits] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0;
    if (hits.length > allowed) {
      const where = hits.map((h) => `${file}:${h.line} ${h.text}`).join("; ");
      problems.push(`${file} asserts a wall-clock duration ${hits.length} time(s), ${allowed} allowed (${where}). Assert the observable cause of slowness, such as zero dials or zero spawned processes, or advance fake timers.`);
    } else if (hits.length < allowed) {
      problems.push(`${file} now has ${hits.length} wall-clock duration assertion(s); lower its BASELINE entry from ${allowed} to ${hits.length}.`);
    }
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    if (!(file in counts)) problems.push(`${file} has no wall-clock duration assertions left; delete its BASELINE entry (was ${allowed}).`);
  }
  return problems;
}

function collectTestFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return collectTestFiles(full);
    return TEST_FILE.test(entry.name) ? [full] : [];
  });
}

describe("wall-clock guard", () => {
  it("lets no test assert a new wall-clock duration", () => {
    const counts: Record<string, Hit[]> = {};
    for (const root of SCAN_ROOTS) {
      for (const full of collectTestFiles(resolve(root))) {
        const file = relative(process.cwd(), full).split("\\").join("/");
        const hits = findElapsedAssertions(file, readFileSync(full, "utf8"));
        if (hits.length > 0) counts[file] = hits;
      }
    }
    expect(checkElapsedAssertions(counts, BASELINE)).toEqual([]);
  });

  it("finds elapsed time asserted directly or through a local", () => {
    const source = [
      "const started = Date.now();",
      "expect(Date.now() - started).toBeLessThan(400);",
      "const t0 = performance.now();",
      "const elapsedMs = (performance.now() - t0) as number;",
      "expect(elapsedMs).toBeLessThan(100);",
    ].join("\n");
    expect(findElapsedAssertions("a.test.ts", source).map((h) => h.line)).toEqual([2, 5]);
  });

  it("ignores elapsed time that is only logged and clock reads that are not durations", () => {
    const source = [
      "const started = Date.now();",
      "console.log(Date.now() - started);",
      "expect(Date.now()).toBeGreaterThan(0);",
      "expect(deadline - Date.now()).toBeGreaterThan(0);",
      "expect(medianMs(21, () => run())).toBeLessThan(10);",
    ].join("\n");
    expect(findElapsedAssertions("a.test.ts", source)).toEqual([]);
  });

  it("ratchets the baseline down and never up", () => {
    const hit: Hit = { line: 1, text: "expect(Date.now() - s)" };
    expect(checkElapsedAssertions({ "a.test.ts": [hit] }, { "a.test.ts": 1 })).toEqual([]);
    expect(checkElapsedAssertions({ "a.test.ts": [hit, hit] }, { "a.test.ts": 1 })[0]).toMatch(/2 time\(s\), 1 allowed/u);
    expect(checkElapsedAssertions({ "a.test.ts": [hit] }, { "a.test.ts": 2 })).toEqual(["a.test.ts now has 1 wall-clock duration assertion(s); lower its BASELINE entry from 2 to 1."]);
    expect(checkElapsedAssertions({}, { "a.test.ts": 1 })).toEqual(["a.test.ts has no wall-clock duration assertions left; delete its BASELINE entry (was 1)."]);
  });
});

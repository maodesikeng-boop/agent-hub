import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const ALLOWED_IMPLEMENTERS = new Set(["src/daemon/platform/win32/fs-safe.ts"]);
const SHARED_HARNESS_FILES = [
  "test/tester/local-instance.ts",
  "test/fake-cli-shim.ts",
  "test/smoke/kit.ts",
  "test/eval/isolation.ts",
  "src/daemon/driver/data-dir-fixture.ts",
] as const;

type AstNode = { type: string; [key: string]: unknown };
const isAstNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as AstNode).type === "string";

function numericValue(node: unknown, constants: ReadonlyMap<string, number>): number | undefined {
  if (!isAstNode(node)) return undefined;
  if (node.type === "Literal" && typeof node.value === "number") return node.value;
  if (node.type === "Identifier" && typeof node.name === "string") return constants.get(node.name);
  return undefined;
}

function hasShebang(node: unknown): boolean {
  if (!isAstNode(node)) return false;
  if (node.type === "Literal" && typeof node.value === "string") return node.value.startsWith("#!");
  if (node.type === "TemplateLiteral") {
    const first = (node.quasis as AstNode[] | undefined)?.[0];
    const cooked = isAstNode(first?.value) ? first.value.cooked : undefined;
    return typeof cooked === "string" && cooked.startsWith("#!");
  }
  return false;
}

function calleeName(node: unknown): string | undefined {
  if (!isAstNode(node)) return undefined;
  if (node.type === "Identifier" && typeof node.name === "string") return node.name;
  if (node.type === "MemberExpression" && isAstNode(node.property) && node.property.type === "Identifier") {
    return node.property.name as string;
  }
  return undefined;
}

function targetId(node: unknown): string | undefined {
  return isAstNode(node) && node.type === "Identifier" && typeof node.name === "string" ? node.name : undefined;
}

function modeFromWriteOptions(node: unknown, constants: ReadonlyMap<string, number>): number | undefined {
  if (!isAstNode(node) || node.type !== "ObjectExpression") return undefined;
  for (const prop of (node.properties as AstNode[] | undefined) ?? []) {
    if (prop.type !== "Property" || !isAstNode(prop.key)) continue;
    const key = prop.key.type === "Identifier" ? prop.key.name : prop.key.type === "Literal" ? prop.key.value : undefined;
    if (key === "mode") return numericValue(prop.value, constants);
  }
  return undefined;
}

export function findDirectExecutableWrites(sources: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];

  for (const [file, source] of sources) {
    if (ALLOWED_IMPLEMENTERS.has(file)) continue;
    if (!/\b(?:writeFileSync|writeFile|chmodSync|chmod)\b/u.test(source)) continue;

    const { program, errors } = parseSync(file, source);
    if (errors.length > 0) throw new Error(`${file} parse failed: ${errors[0]!.message}`);

    const constants = new Map<string, number>();
    const writtenIds = new Set<string>();
    const chmodCalls: Array<{ target: string | undefined; mode: number | undefined }> = [];
    const fileViolations = new Set<string>();

    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) collect(item);
        return;
      }
      if (!isAstNode(node)) return;
      if (node.type === "VariableDeclarator" && isAstNode(node.id) && node.id.type === "Identifier") {
        if (isAstNode(node.init) && node.init.type === "Literal" && typeof node.init.value === "number") {
          constants.set(node.id.name as string, node.init.value);
        }
      }
      for (const [k, v] of Object.entries(node)) {
        if (k === "type" || k === "start" || k === "end") continue;
        collect(v);
      }
    };
    collect(program);

    const inspect = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) inspect(item);
        return;
      }
      if (!isAstNode(node)) return;
      if (node.type === "CallExpression") {
        const name = calleeName(node.callee);
        const args = (node.arguments as unknown[]) ?? [];
        if (name === "writeFileSync" || name === "writeFile") {
          const target = targetId(args[0]);
          if (target) writtenIds.add(target);
          const mode = modeFromWriteOptions(args[2], constants);
          if (mode !== undefined && (mode & 0o111) !== 0) {
            fileViolations.add(`${file}: ${name} with executable mode 0o${mode.toString(8)}`);
          } else if (hasShebang(args[1])) {
            fileViolations.add(`${file}: ${name} with shebang script`);
          }
        } else if (name === "chmodSync" || name === "chmod") {
          chmodCalls.push({ target: targetId(args[0]), mode: numericValue(args[1], constants) });
        }
      }
      for (const [k, v] of Object.entries(node)) {
        if (k === "type" || k === "start" || k === "end") continue;
        inspect(v);
      }
    };
    inspect(program);

    for (const call of chmodCalls) {
      if (call.target && writtenIds.has(call.target) && call.mode !== undefined && (call.mode & 0o111) !== 0) {
        fileViolations.add(`${file}: chmod on written script ${call.target} with mode 0o${call.mode.toString(8)}`);
      }
    }

    violations.push(...[...fileViolations].sort());
  }

  return violations.sort();
}

function productionAndHarnessFiles(): Map<string, string> {
  const srcRoot = join(REPO_ROOT, "src");
  const files = (readdirSync(srcRoot, { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/u.test(file) && !/\.test\.tsx?$/u.test(file) && !/(^|[\\/])(test-helpers|test-utils)\.tsx?$/u.test(file) && !file.includes("fixture"))
    .map((file) => relative(REPO_ROOT, join(srcRoot, file)).split("\\").join("/"));
  const all = [...new Set([...files, ...SHARED_HARNESS_FILES])].sort();
  return new Map(all.map((file) => [file, readFileSync(join(REPO_ROOT, file), "utf8")]));
}

describe("executable script write guard", () => {
  it("flags direct executable writes and written-file chmods while allowing directory chmods and non-executable files (unchanged rule)", () => {
    const synthetic = new Map<string, string>([
      ["src/daemon/platform/win32/fs-safe.ts", 'writeFileSync(tmp, "#!/bin/sh\\n", { mode: 0o755 }); chmodSync(tmp, 0o755);'],
      ["src/daemon/good-dir.ts", "mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);"],
      ["src/daemon/good-data.ts", 'writeFileSync(cfg, "{}", { mode: 0o600 });'],
      ["src/daemon/good-atomic.ts", 'writeExecutableFileAtomicSync(hook, "#!/bin/sh\\n", { mode: 0o755 });'],
      ["src/daemon/bad-mode.ts", 'writeFileSync(hook, "x", { mode: 0o755 });'],
      ["src/daemon/bad-const.ts", 'const SHIM_MODE = 0o700; writeFileSync(tmp, body, { mode: SHIM_MODE }); chmodSync(tmp, SHIM_MODE);'],
      ["src/daemon/bad-shebang.ts", 'writeFileSync(script, "#!/bin/sh\\necho hi\\n"); chmodSync(script, 0o755);'],
    ]);

    expect(findDirectExecutableWrites(synthetic)).toEqual([
      "src/daemon/bad-const.ts: chmod on written script tmp with mode 0o700",
      "src/daemon/bad-const.ts: writeFileSync with executable mode 0o700",
      "src/daemon/bad-mode.ts: writeFileSync with executable mode 0o755",
      "src/daemon/bad-shebang.ts: chmod on written script script with mode 0o755",
      "src/daemon/bad-shebang.ts: writeFileSync with shebang script",
    ]);
  });

  it("requires every production executable script and shared harness to use writeExecutableFileAtomicSync", () => {
    expect(findDirectExecutableWrites(productionAndHarnessFiles())).toEqual([]);
  });
});

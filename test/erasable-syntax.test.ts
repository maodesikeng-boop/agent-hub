import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const rootTsconfig = fileURLToPath(new URL("../tsconfig.json", import.meta.url));

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

// 在临时目录里放一个文件，借根 tsconfig 的设置跑一遍 tsc。
function runTsc(source: string): { status: number; output: string } {
  dir = mkdtempSync(join(tmpdir(), "agent-hub-tsc-"));
  writeFileSync(join(dir, "sample.ts"), source);
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ extends: rootTsconfig, compilerOptions: { types: [] }, include: ["sample.ts"] }),
  );
  try {
    const output = execFileSync(process.execPath, [tsc, "--noEmit", "-p", dir], { encoding: "utf8" });
    return { status: 0, output };
  } catch (error) {
    const e = error as { status: number; stdout: string };
    return { status: e.status, output: e.stdout };
  }
}

describe("erasableSyntaxOnly", () => {
  it("普通类型写法通过", () => {
    const result = runTsc('export type Color = "red" | "blue";\n');
    expect(result.status).toBe(0);
  });

  it("enum 会让 tsc 报错", () => {
    const result = runTsc("export enum Color { Red, Blue }\n");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("erasableSyntaxOnly");
  });

  it("构造函数参数属性也会报错", () => {
    const result = runTsc("export class A { constructor(private x: number) {} }\n");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("erasableSyntaxOnly");
  });
});

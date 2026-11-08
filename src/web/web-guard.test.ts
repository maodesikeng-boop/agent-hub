// 网页扫描守卫：防止 src/web 非测试代码里回潮“直接写定时器数字字面量”或“写死单家厂商名”。
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_DIR = resolve("src/web");

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files.sort();
}

/** 去掉块注释和行注释（保留换行，方便报出行号）。 */
function stripComments(source: string): string {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
  return withoutBlock
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");
}

describe("web-guard：src/web 代码守卫", () => {
  const files = collectSourceFiles(WEB_DIR);

  it("非测试、非注释代码里不直接写 setTimeout/setInterval 数字字面量（必须用具名常量）", () => {
    const hits: string[] = [];
    const pattern = /\bset(?:Timeout|Interval)\s*\([\s\S]*?,\s*\d[\d_]*\s*\)/g;
    for (const file of files) {
      const clean = stripComments(readFileSync(file, "utf8"));
      for (const match of clean.matchAll(pattern)) {
        const line = clean.slice(0, match.index).split("\n").length;
        hits.push(`${relative(WEB_DIR, file)}:${line}: ${match[0].replace(/\s+/g, " ")}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("非测试、非注释代码里不写死单家厂商名（claude / codex / agy / antigravity / gemini）", () => {
    const hits: string[] = [];
    const vendorPattern = /\b(claude|codex|agy|antigravity|gemini)\b/i;
    for (const file of files) {
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (vendorPattern.test(line)) {
          hits.push(`${relative(WEB_DIR, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});

// 网页扫描守卫：防止 src/web 非测试代码里回潮“直接写定时器数字字面量”“写死单家厂商名”“用标准外的圆角档”或“用 styles.css 没定义的底色”。
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import { VENDOR_LIST } from "../vendors/registry.ts";

const WEB_DIR = resolve("src/web");
// Common CSS/UI terms (`cursor`, `pi`) would false-positive unquoted, so they are guarded when quoted.
const UI_COLLISION_WORDS = new Set(["pi", "cursor"]);
const EXTRA_VENDOR_BRAND_WORDS = ["gemini"] as const;

interface VendorTermSource {
  id: string;
  label: string;
  cli: { command: string };
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildVendorPatterns(specs: readonly VendorTermSource[]): { vendorPattern: RegExp; quotedVendorIdPattern: RegExp } {
  const quotedTerms = [...new Set(specs.flatMap((s) => [s.id, s.cli.command]))];
  const wordTerms = [
    ...new Set([
      ...specs.flatMap((s) => [s.id, s.cli.command, s.label]).filter((term) => !UI_COLLISION_WORDS.has(term.toLowerCase())),
      ...EXTRA_VENDOR_BRAND_WORDS,
    ]),
  ];
  return {
    vendorPattern: new RegExp(`\\b(${wordTerms.map(escapeRe).join("|")})\\b`, "i"),
    quotedVendorIdPattern: new RegExp(`["'\`](${quotedTerms.map(escapeRe).join("|")})["'\`]`),
  };
}

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

/** oxc-parser 给出的 ESTree 节点：只用到 type、起止位置和子节点。 */
type AstNode = { type: string; start: number; end: number; [key: string]: unknown };
const isAstNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as AstNode).type === "string";

/**
 * 用 oxc-parser 的语法树找 setTimeout/setInterval（含 window./globalThis. 前缀）的调用，
 * 返回第二个参数是数字字面量（含 -1、`as` 断言、括号包裹）的位置。按调用节点切范围，不会像正则那样跨调用误吞。
 */
function findNumericTimerCalls(fileName: string, source: string): { line: number; text: string }[] {
  const { program, errors } = parseSync(fileName, source);
  if (errors.length > 0) throw new Error(`${fileName} 解析失败：${errors[0]!.message}`);
  const hits: { line: number; text: string }[] = [];
  const timerName = (callee: AstNode): string => {
    if (callee.type === "Identifier") return callee.name as string;
    if (callee.type === "MemberExpression" && (callee.property as AstNode).type === "Identifier") return (callee.property as AstNode).name as string;
    return "";
  };
  const isNumeric = (node: AstNode): boolean => {
    switch (node.type) {
      case "Literal":
        return typeof node.value === "number";
      case "UnaryExpression":
        return isNumeric(node.argument as AstNode);
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSNonNullExpression":
      case "TSSatisfiesExpression":
        return isNumeric(node.expression as AstNode);
      default:
        return false;
    }
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isAstNode(node)) return;
    if (node.type === "CallExpression") {
      const name = timerName(node.callee as AstNode);
      const second = (node.arguments as AstNode[])[1];
      if ((name === "setTimeout" || name === "setInterval") && second !== undefined && isNumeric(second)) {
        hits.push({ line: source.slice(0, node.start).split("\n").length, text: source.slice(node.start, node.end).replace(/\s+/g, " ") });
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(program);
  return hits;
}

describe("web-guard：src/web 代码守卫", () => {
  const files = collectSourceFiles(WEB_DIR);

  it("非测试、非注释代码里不直接写 setTimeout/setInterval 数字字面量（必须用具名常量）", () => {
    const hits: string[] = [];
    for (const file of files) {
      for (const hit of findNumericTimerCalls(file, readFileSync(file, "utf8"))) {
        hits.push(`${relative(WEB_DIR, file)}:${hit.line}: ${hit.text}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("定时器守卫按调用切范围：具名常量不误报，后面别处的数字也不被吞进来；数字字面量照样抓", () => {
    const ok = `
      const t = setTimeout(() => { run(); }, DEBOUNCE_MS);
      const f = (from: number, step: 1 | -1) => { for (let i = 0; i < 3; i++) g(from, 1); };
      setInterval(tick, POLL_MS);
      window.setTimeout(() => {}, DELAY_MS /* 100 */);
    `;
    expect(findNumericTimerCalls("a.ts", ok)).toEqual([]);
    const bad = `
      setTimeout(() => {}, 100);
      window.setInterval(tick, 1_000);
      setTimeout(fn, -1);
      setTimeout(() => { inner(); }, 5 as number);
    `;
    expect(findNumericTimerCalls("a.ts", bad).map((h) => h.line)).toEqual([2, 3, 4, 5]);
  });

  it("非测试、非注释代码里不写死单家厂商名（含全部已接入厂商字面量）", () => {
    const hits: string[] = [];
    const { vendorPattern, quotedVendorIdPattern } = buildVendorPatterns(VENDOR_LIST);
    for (const file of files) {
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (vendorPattern.test(line) || quotedVendorIdPattern.test(line)) {
          hits.push(`${relative(WEB_DIR, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("厂商正则从 VENDOR_LIST 动态生成：覆盖名单每家且自动拦住新接入厂商", () => {
    const { vendorPattern, quotedVendorIdPattern } = buildVendorPatterns(VENDOR_LIST);
    for (const spec of VENDOR_LIST) {
      expect(quotedVendorIdPattern.test(`vendor === "${spec.id}"`), spec.id).toBe(true);
      expect(quotedVendorIdPattern.test(`cmd = '${spec.cli.command}'`), spec.cli.command).toBe(true);
      if (!UI_COLLISION_WORDS.has(spec.id.toLowerCase())) {
        expect(vendorPattern.test(`const x = ${spec.id}Model;`), spec.id).toBe(false);
        expect(vendorPattern.test(`title: "${spec.label}"`), spec.label).toBe(true);
      }
    }
    expect(vendorPattern.test('className="cursor-pointer"')).toBe(false);
    const withAcme = buildVendorPatterns([...VENDOR_LIST, { id: "acme", label: "Acme Code", cli: { command: "acme-cli" } }]);
    expect(withAcme.vendorPattern.test("open acme-cli now")).toBe(true);
    expect(withAcme.vendorPattern.test("Acme Code settings")).toBe(true);
    expect(withAcme.quotedVendorIdPattern.test('vendor === "acme"')).toBe(true);
    expect(vendorPattern.test('vendor === "acme"')).toBe(false);
  });

  it("直角设计：src/web/ 非测试代码禁止使用 rounded-* 圆角类", () => {
    const hits: string[] = [];
    const bannedRadius = /(?:^|[\s"'`:])rounded-[a-z0-9[\]._-]+/i;
    for (const file of files) {
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (bannedRadius.test(line)) hits.push(`${relative(WEB_DIR, file)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("禁止在 src/web/ui/select.tsx 之外直接写原生 <select>", () => {
    const hits: string[] = [];
    const rawSelect = /<select(?:\s|>|\/?>)/;
    for (const file of files) {
      if (relative(WEB_DIR, file) === "ui/select.tsx") continue;
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (rawSelect.test(line)) hits.push(`${relative(WEB_DIR, file)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
  it("底色 bg-<名字> 只用 styles.css 定义了 --color-<名字> 的颜色（或 Tailwind 自带的色板），没定义的会渲染成透明", () => {
    const defined = new Set([...readFileSync(join(WEB_DIR, "styles.css"), "utf8").matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    const builtin = /^(?:transparent|current|inherit|black|white|(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3})$/;
    const bgColor = /(?:^|[\s"'`:])bg-([a-z][a-z0-9-]*)/g;
    const hits: string[] = [];
    for (const file of files) {
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        for (const [, name] of line.matchAll(bgColor)) {
          if (!defined.has(name!) && !builtin.test(name!)) hits.push(`${relative(WEB_DIR, file)}:${index + 1}: bg-${name}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});

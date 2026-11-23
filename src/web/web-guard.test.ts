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

function collectFiles(dir: string, predicate: (name: string) => boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full, predicate));
    } else if (predicate(entry.name)) {
      files.push(full);
    }
  }
  return files.sort();
}

function collectSourceFiles(dir: string): string[] {
  return collectFiles(dir, (name) => /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name));
}

function collectCssFiles(dir: string): string[] {
  return collectFiles(dir, (name) => /\.css$/.test(name));
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

const ALLOWED_INFINITE_KEYFRAME_PROPS = new Set(["transform", "opacity", "animation-timing-function"]);
const CSS_ANIMATION_KEYWORDS = new Set([
  "none",
  "infinite",
  "normal",
  "reverse",
  "alternate",
  "alternate-reverse",
  "forwards",
  "backwards",
  "both",
  "running",
  "paused",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "linear",
  "step-start",
  "step-end",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
]);
const CSS_TIME_OR_NUMBER_RE = /^[+-]?(?:\d+|\d*\.\d+)(?:m?s|%)?$/i;

interface KeyframePropEntry {
  prop: string;
  line: number;
}

interface KeyframeBlock {
  file: string;
  props: KeyframePropEntry[];
}

interface InfiniteAnimRef {
  file: string;
  line: number;
  name: string;
}

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
}

function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

function stripCssFunctionCalls(text: string): string {
  let out = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\" && i + 1 < text.length) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      if (depth === 0) out = out.replace(/[A-Za-z_-][\w-]*$/, "");
      depth += 1;
      continue;
    }
    if (ch === ")" && depth > 0) {
      depth -= 1;
      if (depth === 0) out += " ";
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\" && i + 1 < text.length) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")" && depth > 0) {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function unquoteCssIdent(token: string): string {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  return token;
}

function extractKeyframeNamesFromAnimationValue(value: string, requireInfiniteKeyword: boolean): string[] {
  const names: string[] = [];
  for (const layer of splitTopLevelCommas(value)) {
    if (requireInfiniteKeyword && !/\binfinite\b/i.test(layer)) continue;
    const stripped = stripCssFunctionCalls(layer).trim();
    if (stripped === "" || /\bnone\b/i.test(stripped)) continue;
    const tokens = stripped.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
    const candidates = tokens
      .map(unquoteCssIdent)
      .filter((tok) => tok !== "" && !CSS_ANIMATION_KEYWORDS.has(tok.toLowerCase()) && !CSS_TIME_OR_NUMBER_RE.test(tok));
    if (candidates.length === 0) {
      names.push("<unresolved>");
    } else {
      names.push(...candidates);
    }
  }
  return names;
}

function extractKeyframeNamesFromAnimationNameValue(value: string): string[] {
  const names: string[] = [];
  for (const layer of splitTopLevelCommas(value)) {
    const trimmed = unquoteCssIdent(layer.trim());
    if (trimmed === "" || CSS_ANIMATION_KEYWORDS.has(trimmed.toLowerCase())) continue;
    names.push(trimmed);
  }
  return names;
}

interface CssBlockSegment {
  header: string;
  body: string;
  bodyStartOffset: number;
  declarations: { prop: string; value: string; offset: number }[];
}

function splitCssBlocksAndDeclarations(css: string, start: number, end: number): { blocks: CssBlockSegment[]; declarations: { prop: string; value: string; offset: number }[] } {
  const blocks: CssBlockSegment[] = [];
  const declarations: { prop: string; value: string; offset: number }[] = [];
  let tokenStart = start;
  let quote: string | null = null;
  let parenDepth = 0;

  for (let i = start; i < end; i++) {
    const ch = css[i]!;
    if (quote !== null) {
      if (ch === "\\" && i + 1 < end) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }
    if (parenDepth > 0) continue;

    if (ch === ";") {
      const stmt = css.slice(tokenStart, i);
      const colon = stmt.indexOf(":");
      if (colon !== -1 && !stmt.trimStart().startsWith("@")) {
        declarations.push({
          prop: stmt.slice(0, colon).trim().toLowerCase(),
          value: stmt.slice(colon + 1).trim(),
          offset: tokenStart,
        });
      }
      tokenStart = i + 1;
    } else if (ch === "{") {
      const header = css.slice(tokenStart, i).trim();
      const bodyStart = i + 1;
      let depth = 1;
      let j = bodyStart;
      let innerQuote: string | null = null;
      while (j < end && depth > 0) {
        const inner = css[j]!;
        if (innerQuote !== null) {
          if (inner === "\\" && j + 1 < end) {
            j += 2;
            continue;
          }
          if (inner === innerQuote) innerQuote = null;
        } else if (inner === '"' || inner === "'") {
          innerQuote = inner;
        } else if (inner === "{") {
          depth += 1;
        } else if (inner === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        j += 1;
      }
      const body = css.slice(bodyStart, j);
      const innerParsed = splitCssBlocksAndDeclarations(css, bodyStart, j);
      blocks.push({ header, body, bodyStartOffset: bodyStart, declarations: innerParsed.declarations });
      i = j;
      tokenStart = j + 1;
    }
  }

  const trailing = css.slice(tokenStart, end);
  const trailingColon = trailing.indexOf(":");
  if (trailingColon !== -1 && !trailing.trimStart().startsWith("@")) {
    declarations.push({
      prop: trailing.slice(0, trailingColon).trim().toLowerCase(),
      value: trailing.slice(trailingColon + 1).trim(),
      offset: tokenStart,
    });
  }

  return { blocks, declarations };
}

function parseCssAnimations(file: string, rawCss: string): { keyframes: Map<string, KeyframeBlock>; infiniteRefs: InfiniteAnimRef[] } {
  const css = stripCssComments(rawCss);
  const keyframes = new Map<string, KeyframeBlock>();
  const infiniteRefs: InfiniteAnimRef[] = [];

  const walk = (start: number, end: number): void => {
    const { blocks } = splitCssBlocksAndDeclarations(css, start, end);
    for (const block of blocks) {
      const kfMatch = /^@(?:-\w+-)?keyframes\s+([A-Za-z_][\w-]*|"[^"]+"|'[^']+')$/i.exec(block.header);
      if (kfMatch !== null) {
        const name = unquoteCssIdent(kfMatch[1]!);
        const stopBlocks = splitCssBlocksAndDeclarations(css, block.bodyStartOffset, block.bodyStartOffset + block.body.length).blocks;
        const props: KeyframePropEntry[] = [];
        for (const stop of stopBlocks) {
          for (const decl of stop.declarations) {
            if (decl.prop !== "") props.push({ prop: decl.prop, line: lineNumberAt(css, decl.offset) });
          }
        }
        keyframes.set(name, { file, props });
        continue;
      }

      if (block.header.startsWith("@")) {
        walk(block.bodyStartOffset, block.bodyStartOffset + block.body.length);
        continue;
      }

      // Check animation declarations directly on this rule, then recurse in case CSS nesting is used.
      const hasInfiniteIterationCount = block.declarations.some(
        (d) => d.prop === "animation-iteration-count" && /\binfinite\b/i.test(d.value),
      );
      const animNameDecls = block.declarations.filter((d) => d.prop === "animation-name");
      const animShorthandDecls = block.declarations.filter((d) => d.prop === "animation");

      for (const decl of animShorthandDecls) {
        const names = extractKeyframeNamesFromAnimationValue(decl.value, !hasInfiniteIterationCount);
        for (const name of names) {
          infiniteRefs.push({ file, line: lineNumberAt(css, decl.offset), name });
        }
      }

      if (hasInfiniteIterationCount) {
        let foundName = animShorthandDecls.length > 0;
        for (const decl of animNameDecls) {
          const names = extractKeyframeNamesFromAnimationNameValue(decl.value);
          if (names.length > 0) foundName = true;
          for (const name of names) {
            infiniteRefs.push({ file, line: lineNumberAt(css, decl.offset), name });
          }
        }
        if (!foundName) {
          const iterDecl = block.declarations.find((d) => d.prop === "animation-iteration-count" && /\binfinite\b/i.test(d.value))!;
          infiniteRefs.push({ file, line: lineNumberAt(css, iterDecl.offset), name: "<unresolved>" });
        }
      }

      walk(block.bodyStartOffset, block.bodyStartOffset + block.body.length);
    }
  };

  walk(0, css.length);
  return { keyframes, infiniteRefs };
}

function staticStringValue(node: AstNode | undefined): string | null {
  if (node === undefined) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
    return (node.quasis as AstNode[]).map((q) => (q.value as { raw: string; cooked?: string }).cooked ?? (q.value as { raw: string }).raw).join("");
  }
  return null;
}

function objectPropKeyName(prop: AstNode): string | null {
  if (prop.type !== "Property" && prop.type !== "ObjectProperty") return null;
  const key = prop.key as AstNode | undefined;
  if (key === undefined) return null;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

function findInfiniteAnimationsInScript(file: string, source: string): InfiniteAnimRef[] {
  const { program, errors } = parseSync(file, source);
  if (errors.length > 0) throw new Error(`${file} parse failed: ${errors[0]!.message}`);
  const refs: InfiniteAnimRef[] = [];

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isAstNode(node)) return;

    if (node.type === "ObjectExpression") {
      const props = node.properties as AstNode[];
      let animVal: { value: string; start: number } | null = null;
      let animNameVal: { value: string; start: number } | null = null;
      let iterInfiniteStart: number | null = null;

      for (const prop of props) {
        const key = objectPropKeyName(prop);
        if (key === null) continue;
        const val = staticStringValue(prop.value as AstNode | undefined);
        if (key === "animation" && val !== null) animVal = { value: val, start: prop.start };
        if (key === "animationName" && val !== null) animNameVal = { value: val, start: prop.start };
        if (key === "animationIterationCount" && val !== null && /\binfinite\b/i.test(val)) {
          iterInfiniteStart = prop.start;
        }
      }

      if (animVal !== null) {
        for (const name of extractKeyframeNamesFromAnimationValue(animVal.value, iterInfiniteStart === null)) {
          refs.push({ file, line: lineNumberAt(source, animVal.start), name });
        }
      }
      if (iterInfiniteStart !== null) {
        if (animNameVal !== null) {
          for (const name of extractKeyframeNamesFromAnimationNameValue(animNameVal.value)) {
            refs.push({ file, line: lineNumberAt(source, animNameVal.start), name });
          }
        } else if (animVal === null) {
          refs.push({ file, line: lineNumberAt(source, iterInfiniteStart), name: "<unresolved>" });
        }
      }
    }

    const stringVal =
      node.type === "Literal" && typeof node.value === "string"
        ? node.value
        : node.type === "TemplateElement"
          ? ((node.value as { cooked?: string; raw: string }).cooked ?? (node.value as { raw: string }).raw)
          : null;
    if (stringVal !== null) {
      for (const match of stringVal.matchAll(/\banimate-\[([^\]]+)\]/g)) {
        const raw = match[1]!.replace(/_/g, " ");
        if (/\binfinite\b/i.test(raw)) {
          for (const name of extractKeyframeNamesFromAnimationValue(raw, true)) {
            refs.push({ file, line: lineNumberAt(source, node.start), name });
          }
        }
      }
    }

    for (const value of Object.values(node)) visit(value);
  };

  visit(program);
  return refs;
}

function checkInfiniteAnimations(
  cssInputs: readonly { file: string; content: string }[],
  scriptInputs: readonly { file: string; content: string }[],
): { infiniteRefs: InfiniteAnimRef[]; violations: string[] } {
  const allKeyframes = new Map<string, KeyframeBlock>();
  const allRefs: InfiniteAnimRef[] = [];

  for (const css of cssInputs) {
    const parsed = parseCssAnimations(css.file, css.content);
    for (const [name, block] of parsed.keyframes) allKeyframes.set(name, block);
    allRefs.push(...parsed.infiniteRefs);
  }
  for (const script of scriptInputs) {
    allRefs.push(...findInfiniteAnimationsInScript(script.file, script.content));
  }

  const checked = new Set<string>();
  const violations: string[] = [];
  for (const ref of allRefs) {
    if (ref.name === "<unresolved>") {
      violations.push(`${ref.file}:${ref.line}: infinite animation is missing a statically resolvable @keyframes name`);
      continue;
    }
    const kf = allKeyframes.get(ref.name);
    if (kf === undefined) {
      violations.push(`${ref.file}:${ref.line}: infinite animation references unknown @keyframes "${ref.name}"`);
      continue;
    }
    if (checked.has(ref.name)) continue;
    checked.add(ref.name);
    const seenDisallowed = new Set<string>();
    for (const entry of kf.props) {
      if (!ALLOWED_INFINITE_KEYFRAME_PROPS.has(entry.prop) && !seenDisallowed.has(entry.prop)) {
        seenDisallowed.add(entry.prop);
        violations.push(
          `${kf.file}:${entry.line}: @keyframes ${ref.name} (infinite) animates "${entry.prop}" (only transform, opacity, animation-timing-function allowed)`,
        );
      }
    }
  }
  return { infiniteRefs: allRefs, violations };
}

describe("web-guard：src/web 代码守卫", () => {
  const files = collectSourceFiles(WEB_DIR);
  const cssFiles = collectCssFiles(WEB_DIR);

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
    const rawSelect = /<select(?![A-Za-z0-9_-])/;
    for (const file of files) {
      if (relative(WEB_DIR, file).replaceAll("\\", "/") === "ui/select.tsx") continue;
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

  it("infinite animations in src/web only animate compositor-safe properties (transform, opacity, animation-timing-function)", () => {
    const cssInputs = cssFiles.map((file) => ({ file: relative(WEB_DIR, file), content: readFileSync(file, "utf8") }));
    const scriptInputs = files.map((file) => ({ file: relative(WEB_DIR, file), content: readFileSync(file, "utf8") }));
    const result = checkInfiniteAnimations(cssInputs, scriptInputs);
    expect(result.infiniteRefs.map((ref) => ref.name)).toEqual(
      expect.arrayContaining(["status-shimmer", "status-shimmer-counter", "slime-hop-working", "bell-swing-working"]),
    );
    expect(result.violations).toEqual([]);
  });

  it("infinite animation guard catches disallowed keyframe properties, split animationIterationCount, TSX inline styles, and unknown keyframes", () => {
    const okCss = `
      .good { animation: pulse-op 2s ease-in-out infinite; }
      @keyframes pulse-op {
        0%, 100% { opacity: 1; animation-timing-function: ease-out; }
        50% { opacity: 0.4; transform: translateY(-2px); }
      }
    `;
    expect(checkInfiniteAnimations([{ file: "styles.css", content: okCss }], []).violations).toEqual([]);

    const badCss = `
      .shimmer { animation: bg-slide 2s linear infinite; }
      .split { animation-name: box-grow; animation-iteration-count: infinite; }
      @keyframes bg-slide { 0% { background-position: 0 0; } 100% { background-position: 100% 0; } }
      @keyframes box-grow { from { width: 10px; } to { width: 20px; } }
    `;
    expect(checkInfiniteAnimations([{ file: "styles.css", content: badCss }], []).violations).toEqual([
      'styles.css:4: @keyframes bg-slide (infinite) animates "background-position" (only transform, opacity, animation-timing-function allowed)',
      'styles.css:5: @keyframes box-grow (infinite) animates "width" (only transform, opacity, animation-timing-function allowed)',
    ]);

    const tsxBad = `
      export const A = () => <div style={{ animation: "bad-tsx 1s infinite" }} />;
      export const B = () => <div style={{ animationName: "bad-tsx-2", animationIterationCount: "infinite" }} />;
    `;
    const tsxCss = `
      @keyframes bad-tsx { to { color: red; } }
      @keyframes bad-tsx-2 { to { box-shadow: 0 0 8px #000; } }
    `;
    expect(
      checkInfiniteAnimations([{ file: "styles.css", content: tsxCss }], [{ file: "App.tsx", content: tsxBad }]).violations,
    ).toEqual([
      'styles.css:2: @keyframes bad-tsx (infinite) animates "color" (only transform, opacity, animation-timing-function allowed)',
      'styles.css:3: @keyframes bad-tsx-2 (infinite) animates "box-shadow" (only transform, opacity, animation-timing-function allowed)',
    ]);

    const missingKf = `.ghost { animation: unknown-spin 1s linear infinite; }`;
    expect(checkInfiniteAnimations([{ file: "styles.css", content: missingKf }], []).violations).toEqual([
      'styles.css:1: infinite animation references unknown @keyframes "unknown-spin"',
    ]);
  });

  it("vendor pickers in src/web must use pickableVendorCatalogs and never call isListed or filter catalogs by availability directly", () => {
    const isListedHits: string[] = [];
    const directAvailabilityFilterHits: string[] = [];
    const isListedRe = /\bisListed\b/;
    const directFilterRe = /\.filter\([^)]*\.availability\b/;
    const allowedAvailabilityFilter = new Set(["components/ProvidersSettings.tsx", "settings-model.ts"]);
    for (const file of files) {
      const rel = relative(WEB_DIR, file).replaceAll("\\", "/");
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (isListedRe.test(line)) isListedHits.push(`${rel}:${index + 1}: ${line.trim()}`);
        if (!allowedAvailabilityFilter.has(rel) && directFilterRe.test(line)) {
          directAvailabilityFilterHits.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(isListedHits).toEqual([]);
    expect(directAvailabilityFilterHits).toEqual([]);
  });
});

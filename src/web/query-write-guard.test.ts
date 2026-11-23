import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_DIR = resolve("src/web");

const CACHE_WRITE = /\.setQueryData\s*[<(]/;
const SHARED_GENERATION = /\b(?:queryGenerationOf|guardedQueryFn)\b/;

// Legacy modules that write the query cache without the shared generation. The list may only shrink.
const LEGACY_UNGUARDED_WRITERS = new Set([
  "components/PmMemoryFilesGroup.tsx",
  "composer-suggest.ts",
  "models.tsx",
  "settings-model.ts",
]);

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
});

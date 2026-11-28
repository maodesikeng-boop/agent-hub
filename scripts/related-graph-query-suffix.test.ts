import { describe, expect, it } from "vitest";
import { analyzeModuleSource, diffChangedExports, resolveAffectedTests, type VitestProjectSpec } from "./related-graph.ts";
import { REPO_ROOT } from "./stage-runtime-common.ts";

const SYNTHETIC_PROJECTS: readonly VitestProjectSpec[] = [
  {
    name: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["test/clean-env.ts"],
  },
];

function makeBaseReader(baseSources: ReadonlyMap<string, string>): (path: string) => string | undefined {
  return (path) => baseSources.get(path);
}

describe("scripts/related-graph.ts module query-suffix identity", () => {
  it("selects consumers when a named re-export changes module query suffix while keeping file dependency edges on the canonical path", () => {
    const known = new Set(["src/data.ts", "src/index.ts", "src/consumer.test.ts", "test/clean-env.ts", "src/guard.test.ts"]);

    const oldBarrel = 'export { default as value } from "./data.ts";\n';
    const newBarrel = 'export { default as value } from "./data.ts?raw";\n';
    expect(diffChangedExports("src/index.ts", oldBarrel, newBarrel, known).kind).toBe("all");

    const baseSources = new Map<string, string>([
      ["src/data.ts", "export default 1;\nexport const other = 2;\n"],
      ["src/index.ts", oldBarrel],
      ["src/consumer.test.ts", 'import { value } from "./index.ts";\nvoid value;\n'],
      ["test/clean-env.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);
    const currentSources = new Map(baseSources);
    currentSources.set("src/index.ts", newBarrel);

    const suffixSwapResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/index.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: currentSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(suffixSwapResult.testFiles).toContain("src/consumer.test.ts");

    // Both `./data.ts` and `./data.ts?raw` stay in staticModuleDeps while `value` switches runtime module identity.
    const oldSharedBarrel = 'export { other, default as value } from "./data.ts";\nexport { default as rawText } from "./data.ts?raw";\n';
    const newSharedBarrel = 'export { other } from "./data.ts";\nexport { default as value, default as rawText } from "./data.ts?raw";\n';
    expect(diffChangedExports("src/index.ts", oldSharedBarrel, newSharedBarrel, known).kind).toBe("all");

    // Same-origin imports with distinct query suffixes keep distinct binding fingerprints.
    const oldImportSwap =
      'import val from "./data.ts";\nimport raw from "./data.ts?raw";\nexport const a = () => val;\nexport const b = () => raw;\n';
    const newImportSwap =
      'import raw from "./data.ts";\nimport val from "./data.ts?raw";\nexport const a = () => val;\nexport const b = () => raw;\n';
    expect(diffChangedExports("src/index.ts", oldImportSwap, newImportSwap, known)).toEqual({
      kind: "symbols",
      symbols: ["a", "b"],
    });

    // Unchanged query suffix with comment-only edit stays a no-op.
    expect(diffChangedExports("src/index.ts", newBarrel, `// keep\n${newBarrel}`, known)).toEqual({ kind: "none" });

    // File dependency edges still strip `?raw` so editing `src/data.ts` reaches consumers of the `?raw` re-export.
    const rawBaseSources = new Map(currentSources);
    const editedDataSources = new Map(currentSources);
    editedDataSources.set("src/data.ts", "export default 2;\nexport const other = 2;\n");
    const targetEditResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/data.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: editedDataSources,
      readBaseFile: makeBaseReader(rawBaseSources),
    });
    expect(targetEditResult.testFiles).toContain("src/consumer.test.ts");
  });

  it("models ?raw and similar whole-file query imports/re-exports as whole-file dependencies while keeping plain imports symbol-scoped", () => {
    const baseData = "export default 1;\nexport const other = 2;\n";
    const baseSources = new Map<string, string>([
      ["src/data.ts", baseData],
      ["src/raw-barrel.ts", 'export { default as rawText } from "./data.ts?raw";\n'],
      ["src/raw-hop.ts", 'export { rawText as forwardedRaw } from "./raw-barrel.ts";\n'],
      ["src/raw-reexport.test.ts", 'import { forwardedRaw } from "./raw-hop.ts";\nvoid forwardedRaw;\n'],
      ["src/raw-direct.test.ts", 'import raw from "./data.ts?raw";\nvoid raw;\n'],
      ["src/url-direct.test.ts", 'import assetUrl from "./data.ts?url";\nvoid assetUrl;\n'],
      ["src/inline-direct.test.ts", 'import inlined from "./data.ts?inline";\nvoid inlined;\n'],
      ["src/worker-direct.test.ts", 'import WorkerCtor from "./data.ts?worker";\nvoid WorkerCtor;\n'],
      ["src/raw-dynamic.test.ts", 'export const load = () => import("./data.ts?raw");\n'],
      ["src/raw-type-only.test.ts", 'import type rawType from "./data.ts?raw";\nexport type Kept = typeof rawType;\n'],
      ["src/plain-barrel.ts", 'export { default as plainValue } from "./data.ts";\n'],
      ["src/plain-default.test.ts", 'import { plainValue } from "./plain-barrel.ts";\nvoid plainValue;\n'],
      ["src/plain-other.test.ts", 'import { other } from "./data.ts";\nvoid other;\n'],
      ["src/asset-barrel.ts", 'export { default as noteText } from "./assets/note.txt?raw";\n'],
      ["src/asset-consumer.test.ts", 'import { noteText } from "./asset-barrel.ts";\nvoid noteText;\n'],
      ["test/clean-env.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);

    const runWithDataEdit = (nextData: string) => {
      const currentSources = new Map(baseSources);
      currentSources.set("src/data.ts", nextData);
      return resolveAffectedTests({
        repoRoot: REPO_ROOT,
        baseRef: "origin/main",
        changedFiles: ["src/data.ts"],
        projects: SYNTHETIC_PROJECTS,
        alwaysRunTests: ["src/guard.test.ts"],
        sources: currentSources,
        readBaseFile: makeBaseReader(baseSources),
      });
    };

    const expectedWholeFileConsumers = [
      "src/raw-reexport.test.ts",
      "src/raw-direct.test.ts",
      "src/url-direct.test.ts",
      "src/inline-direct.test.ts",
      "src/worker-direct.test.ts",
      "src/raw-dynamic.test.ts",
    ];

    // Non-default export change must hit every whole-file query consumer (including through re-export chains) without hitting plain default consumers.
    const nonDefaultResult = runWithDataEdit("export default 1;\nexport const other = 3;\n");
    for (const testFile of expectedWholeFileConsumers) {
      expect(nonDefaultResult.testFiles, `non-default edit should select ${testFile}`).toContain(testFile);
    }
    expect(nonDefaultResult.testFiles).toContain("src/plain-other.test.ts");
    expect(nonDefaultResult.testFiles).not.toContain("src/plain-default.test.ts");
    expect(nonDefaultResult.testFiles).not.toContain("src/raw-type-only.test.ts");

    // Comment-only edit must still hit every whole-file query consumer while skipping plain imports.
    const commentOnlyResult = runWithDataEdit(`// header comment\n${baseData}`);
    for (const testFile of expectedWholeFileConsumers) {
      expect(commentOnlyResult.testFiles, `comment-only edit should select ${testFile}`).toContain(testFile);
    }
    expect(commentOnlyResult.testFiles).not.toContain("src/plain-default.test.ts");
    expect(commentOnlyResult.testFiles).not.toContain("src/plain-other.test.ts");
    expect(commentOnlyResult.testFiles).not.toContain("src/raw-type-only.test.ts");

    // Whitespace-only edit must also hit every whole-file query consumer while skipping plain imports.
    const whitespaceOnlyResult = runWithDataEdit("export default 1;\n\nexport const other = 2;\n");
    for (const testFile of expectedWholeFileConsumers) {
      expect(whitespaceOnlyResult.testFiles, `whitespace-only edit should select ${testFile}`).toContain(testFile);
    }
    expect(whitespaceOnlyResult.testFiles).not.toContain("src/plain-default.test.ts");
    expect(whitespaceOnlyResult.testFiles).not.toContain("src/plain-other.test.ts");

    // Relative ?raw import of a non-code asset resolves via changedFiles without needing a repo-root path literal.
    const assetEditResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/assets/note.txt"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: baseSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(assetEditResult.testFiles).toContain("src/asset-consumer.test.ts");

    // Module summary fileDeps stays aligned with edge extraction on canonical target paths.
    const known = new Set(baseSources.keys());
    expect(analyzeModuleSource("src/raw-barrel.ts", baseSources.get("src/raw-barrel.ts")!, known).fileDeps).toEqual(["src/data.ts"]);
    expect(analyzeModuleSource("src/plain-barrel.ts", baseSources.get("src/plain-barrel.ts")!, known).fileDeps).toEqual([]);
  });
});

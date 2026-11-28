import { describe, expect, it } from "vitest";
import { diffChangedExports, resolveAffectedTests, type VitestProjectSpec } from "./related-graph.ts";
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
});

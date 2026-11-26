import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DOCS_DIR = join(REPO_ROOT, "docs");

const LIVING_NON_DESIGN_DOCS = new Set(["README.md", "dependencies.md", "review-and-merge.md", "plan-standard.md", "ui-standard.md", "linux.md"]);
const SNAPSHOT_LINE = /^> Snapshot: (\d{4}-\d{2}-\d{2}) \(commit `([0-9a-f]{7,40})`\)$/;

function listMarkdownFiles(dir: string, root: string = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listMarkdownFiles(full, root));
    else if (entry.name.endsWith(".md")) files.push(relative(root, full).split("\\").join("/"));
  }
  return files.sort();
}

function isValidIsoDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function validateDocsIndex(input: {
  readmeText: string;
  markdownFilesUnderDocs: readonly string[];
  linkExists: (targetRelativeToDocs: string) => boolean;
}): string[] {
  const problems: string[] = [];
  const rawTargets = [...input.readmeText.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1]!.trim());
  const localTargets = rawTargets.filter((target) => !/^(?:https?:|mailto:|#)/.test(target)).map((target) => target.split("#")[0]!);

  for (const target of localTargets) {
    if (!input.linkExists(target)) {
      problems.push(`docs/README.md links to missing file \`${target}\`.`);
    }
  }

  const indexedDocs = new Set(localTargets);
  for (const file of input.markdownFilesUnderDocs) {
    if (file === "README.md") continue;
    if (!indexedDocs.has(file)) {
      problems.push(`docs/${file} is missing from the index in docs/README.md.`);
    }
  }

  return problems;
}

export function isDesignDoc(relPathUnderDocs: string): boolean {
  if (relPathUnderDocs.includes("/")) return false;
  return !LIVING_NON_DESIGN_DOCS.has(relPathUnderDocs);
}

export function validateDesignDocSnapshots(
  docs: ReadonlyMap<string, string>,
  commitExists?: (sha: string) => boolean,
): string[] {
  const problems: string[] = [];
  for (const [relPath, text] of docs) {
    if (!isDesignDoc(relPath)) continue;
    const lines = text.split(/\r?\n/);
    const titleIdx = lines.findIndex((line) => line.startsWith("# "));
    if (titleIdx === -1) {
      problems.push(`docs/${relPath} is missing a top-level \`# Title\`.`);
      continue;
    }
    const headerSlice = lines.slice(titleIdx + 1, titleIdx + 6);
    const snapshotLine = headerSlice.find((line) => line.startsWith("> Snapshot:"));
    if (!snapshotLine) {
      problems.push(`docs/${relPath} must place \`> Snapshot: YYYY-MM-DD (commit \`<sha>\`)\` directly under its \`# Title\`.`);
      continue;
    }
    const match = SNAPSHOT_LINE.exec(snapshotLine);
    if (!match) {
      problems.push(`docs/${relPath} has malformed snapshot metadata \`${snapshotLine}\`; expected \`> Snapshot: YYYY-MM-DD (commit \`<sha>\`)\`.`);
      continue;
    }
    const [, date, sha] = match;
    if (!isValidIsoDate(date!)) {
      problems.push(`docs/${relPath} has invalid snapshot date \`${date}\`.`);
    }
    if (commitExists && !commitExists(sha!)) {
      problems.push(`docs/${relPath} references unknown git commit \`${sha}\`.`);
    }
  }
  return problems;
}

function fullHistoryCommitChecker(): ((sha: string) => boolean) | undefined {
  try {
    const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    if (shallow !== "false") return undefined;
    return (sha: string) => {
      try {
        execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: REPO_ROOT, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
  } catch {
    return undefined;
  }
}

describe("docs/ index and design snapshot guards", () => {
  const markdownFiles = listMarkdownFiles(DOCS_DIR);

  it("indexes every document under docs/ in docs/README.md and resolves every link", () => {
    const readmeText = readFileSync(join(DOCS_DIR, "README.md"), "utf8");
    const problems = validateDocsIndex({
      readmeText,
      markdownFilesUnderDocs: markdownFiles,
      linkExists: (target) => existsSync(resolve(DOCS_DIR, target)),
    });
    expect(problems).toEqual([]);
  });

  it("requires every design document under docs/ to record a snapshot date and commit", () => {
    const docs = new Map(markdownFiles.map((file) => [file, readFileSync(join(DOCS_DIR, file), "utf8")]));
    const problems = validateDesignDocSnapshots(docs, fullHistoryCommitChecker());
    expect(problems).toEqual([]);
  });

  it("rejects missing docs, broken README links, and missing or malformed design snapshots", () => {
    expect(
      validateDocsIndex({
        readmeText: "- [A](a.md)\n- [Gone](missing.md#sec)\n",
        markdownFilesUnderDocs: ["README.md", "a.md", "b.md"],
        linkExists: (t) => t === "a.md",
      }),
    ).toEqual(["docs/README.md links to missing file `missing.md`.", "docs/b.md is missing from the index in docs/README.md."]);

    const badDocs = new Map<string, string>([
      ["README.md", "# Docs\n"],
      ["no-meta-design.md", "# No meta\n\nBody.\n"],
      ["bad-date-design.md", "# Bad date\n\n> Snapshot: 2026-02-30 (commit `abcdef1`)\n"],
      ["bad-sha-design.md", "# Bad sha\n\n> Snapshot: 2026-11-22 (commit `abcdef1`)\n"],
      ["good-design.md", "# Good\n\n> Snapshot: 2026-11-22 (commit `12345678`)\n"],
    ]);
    expect(validateDesignDocSnapshots(badDocs, (sha) => sha === "12345678")).toEqual([
      "docs/no-meta-design.md must place `> Snapshot: YYYY-MM-DD (commit `<sha>`)` directly under its `# Title`.",
      "docs/bad-date-design.md has invalid snapshot date `2026-02-30`.",
      "docs/bad-date-design.md references unknown git commit `abcdef1`.",
      "docs/bad-sha-design.md references unknown git commit `abcdef1`.",
    ]);
  });
});

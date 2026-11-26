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

export function validateAgentsRuleScopes(input: {
  agentsMd: string;
  reviewAndMergeMd?: string;
  verifySkillMd?: string;
}): string[] {
  const problems: string[] = [];
  const { agentsMd, reviewAndMergeMd, verifySkillMd } = input;
  const ciWaitScope = /platform code that this machine cannot test[\s\S]{0,160}no immediately following review step/iu;

  if (!/push[\s\S]{0,40}hand off right away[\s\S]{0,160}Exception:/iu.test(agentsMd) || !ciWaitScope.test(agentsMd)) {
    problems.push("AGENTS.md must scope CI wait exceptions to platform code this machine cannot test or PRs with no immediately following review step.");
  }
  if (reviewAndMergeMd !== undefined && !ciWaitScope.test(reviewAndMergeMd)) {
    problems.push("docs/review-and-merge.md must scope CI wait exceptions to platform code this machine cannot test or PRs with no immediately following review step.");
  }
  if (
    verifySkillMd !== undefined &&
    (!ciWaitScope.test(verifySkillMd) || /After you push,\s*wait for the PR's CI checks/iu.test(verifySkillMd))
  ) {
    problems.push(".agents/skills/verify/SKILL.md must align CI wait exceptions with AGENTS.md instead of waiting unconditionally after push.");
  }

  if (
    !/docs\/dependencies\.md(?:(?!\.\s)[^\n])*whenever dependencies change/iu.test(agentsMd) ||
    /docs\/dependencies\.md(?:(?!\.\s)[^\n])*when `(?:package\.json|apps\/windows\/Cargo\.toml)`/iu.test(agentsMd)
  ) {
    problems.push("AGENTS.md must require updating docs/dependencies.md whenever dependencies change, not only when manifest files change.");
  }

  if (!/cite doc section numbers/iu.test(agentsMd)) {
    problems.push("AGENTS.md must forbid citing doc section numbers in comments.");
  }
  if (!/that types and names cannot express/iu.test(agentsMd)) {
    problems.push("AGENTS.md must keep the comment boundary `that types and names cannot express`.");
  }
  if (!/multi-thousand-line factory closures/iu.test(agentsMd) || !/large shared mutable closures/iu.test(agentsMd)) {
    problems.push("AGENTS.md must forbid multi-thousand-line factory closures and large shared mutable closures.");
  }
  if (!/Legacy oversized entries in `src\/code-hygiene\.baseline\.json` cannot grow/iu.test(agentsMd)) {
    problems.push("AGENTS.md must specify that legacy oversized entries in src/code-hygiene.baseline.json cannot grow.");
  }

  if (
    !/design doc(?:ument)?s \(`docs\/\*-design\.md`\) may name reference products[;.]\s*PR descriptions, commit messages, UI copy, and code comments must not/iu.test(agentsMd) ||
    /\bonly\s+design doc(?:ument)?s\b(?:(?!\.\s)[^\n])*may name reference products/iu.test(agentsMd)
  ) {
    problems.push("AGENTS.md must allow reference products in docs/*-design.md and forbid them in PR descriptions, commit messages, UI copy, and code comments without banning ordinary docs.");
  }

  if (
    !/update a PR description(?:(?!\.\s)[^\n])*`pr-body\/<PR>`/iu.test(agentsMd) ||
    /update a PR description\s+from a Worker branch/iu.test(agentsMd)
  ) {
    problems.push("AGENTS.md must not narrow PR description sync via pr-body/<PR> to Worker branches.");
  }
  if (reviewAndMergeMd !== undefined && /update a PR description\s+from a Worker branch/iu.test(reviewAndMergeMd)) {
    problems.push("docs/review-and-merge.md must not narrow PR description sync to Worker branches.");
  }

  return problems;
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

describe("AGENTS.md rule scope guards", () => {
  it("preserves rule scopes across AGENTS.md, docs/review-and-merge.md, and .agents/skills/verify/SKILL.md", () => {
    const problems = validateAgentsRuleScopes({
      agentsMd: readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8"),
      reviewAndMergeMd: readFileSync(join(REPO_ROOT, "docs/review-and-merge.md"), "utf8"),
      verifySkillMd: readFileSync(join(REPO_ROOT, ".agents/skills/verify/SKILL.md"), "utf8"),
    });
    expect(problems).toEqual([]);
  });

  it("rejects narrowed CI wait, dependency, comment/size, reference-product, and PR-body sync scopes", () => {
    const regressedAgents = [
      "Check `docs/dependencies.md` before adding a package and update it in the same PR when `package.json` or `apps/windows/Cargo.toml` changes.",
      "Never write comments that restate code, echo type signatures, add section banners (`// ----`), or cite doc sections. Write a concise one-line English comment only for a non-obvious *why*.",
      "Keep modules focused and functions short with explicit typed parameters instead of giant factory closures. Entries in `src/code-hygiene.baseline.json` cannot grow.",
      "Push and hand off right away so parallel review and cloud CI run together. Exception: wait for CI when touching Linux `bwrap`, Windows native, or desktop packaging, or when no review step follows immediately.",
      "Only design docs (`docs/*-design.md`) may name reference products; PR descriptions, commit messages, UI copy, and code comments must not.",
      "Update a PR description from a Worker branch by pushing an annotated `pr-body/<PR>` tag.",
    ].join("\n");
    const regressedReviewAndMerge = [
      "Exception: wait when touching Linux `bwrap`.",
      "To update a PR description from a Worker branch, write the Markdown body to `<file>`.",
    ].join("\n");
    const regressedVerifySkill = "After you push, wait for the PR's CI checks with `node scripts/wait-checks.ts <PR>`.";

    expect(
      validateAgentsRuleScopes({
        agentsMd: regressedAgents,
        reviewAndMergeMd: regressedReviewAndMerge,
        verifySkillMd: regressedVerifySkill,
      }),
    ).toEqual([
      "AGENTS.md must scope CI wait exceptions to platform code this machine cannot test or PRs with no immediately following review step.",
      "docs/review-and-merge.md must scope CI wait exceptions to platform code this machine cannot test or PRs with no immediately following review step.",
      ".agents/skills/verify/SKILL.md must align CI wait exceptions with AGENTS.md instead of waiting unconditionally after push.",
      "AGENTS.md must require updating docs/dependencies.md whenever dependencies change, not only when manifest files change.",
      "AGENTS.md must forbid citing doc section numbers in comments.",
      "AGENTS.md must keep the comment boundary `that types and names cannot express`.",
      "AGENTS.md must forbid multi-thousand-line factory closures and large shared mutable closures.",
      "AGENTS.md must specify that legacy oversized entries in src/code-hygiene.baseline.json cannot grow.",
      "AGENTS.md must allow reference products in docs/*-design.md and forbid them in PR descriptions, commit messages, UI copy, and code comments without banning ordinary docs.",
      "AGENTS.md must not narrow PR description sync via pr-body/<PR> to Worker branches.",
      "docs/review-and-merge.md must not narrow PR description sync to Worker branches.",
    ]);
  });
});

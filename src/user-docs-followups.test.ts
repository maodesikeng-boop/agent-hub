import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALWAYS_RUN_TESTS } from "../scripts/test-related.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function readRepoFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

function sectionBetween(markdown: string, startHeading: RegExp, endHeading: RegExp): string {
  const startMatch = startHeading.exec(markdown);
  if (!startMatch) return "";
  const rest = markdown.slice(startMatch.index);
  const nextMatch = endHeading.exec(rest.slice(startMatch[0].length));
  return nextMatch ? rest.slice(0, startMatch[0].length + nextMatch.index) : rest;
}

describe("user documentation review follow-up guards", () => {
  it("docs/linux.md requires a separate AGENT_HUB_HOME and explains the state/lock conflict for multi-instance hosts", () => {
    const linuxDoc = readRepoFile("docs/linux.md");
    const multiInstanceMatch = /If you run more than one Bellwood instance[^\n]*/.exec(linuxDoc);
    expect(multiInstanceMatch, "docs/linux.md must include a multi-instance guidance sentence").not.toBeNull();
    const sentence = multiInstanceMatch![0];

    expect(sentence, "multi-instance guidance must require a separate AGENT_HUB_HOME").toMatch(
      /(?:separate|distinct|own)[^\n.]*`AGENT_HUB_HOME`|`AGENT_HUB_HOME`[^\n.]*(?:separate|distinct|per instance|per service)/i,
    );
    expect(sentence, "multi-instance guidance must explain the state/lock or DaemonAlreadyRunningError conflict").toMatch(
      /state\/lock|DaemonAlreadyRunningError/,
    );
    expect(sentence).toContain("AGENT_HUB_PORT");
    expect(sentence).toContain("FUSA_MESH_PORT");
  });

  it("README.md and README.zh-CN.md Quick start guide users through creating their first project between CLI login and optional setup", () => {
    const enQuickStart = sectionBetween(readRepoFile("README.md"), /^## Quick start$/m, /^## /m);
    const enStep2Idx = enQuickStart.indexOf("### 2.");
    const enOptionalIdx = enQuickStart.search(/^### \d+\. Connect Feishu/m);
    expect(enStep2Idx).toBeGreaterThan(-1);
    expect(enOptionalIdx).toBeGreaterThan(enStep2Idx);
    const enBetween = enQuickStart.slice(enStep2Idx, enOptionalIdx);
    expect(enBetween, "README.md Quick start must add a step between CLI sign-in and optional setup").toMatch(/^### 3\./m);
    expect(enBetween).toContain("`+`");
    expect(enBetween).toContain("New project manager");
    expect(enBetween).toContain("Main folder");
    expect(enBetween).toContain("Create");

    const zhQuickStart = sectionBetween(readRepoFile("README.zh-CN.md"), /^## 快速开始$/m, /^## /m);
    const zhStep2Idx = zhQuickStart.indexOf("### 2.");
    const zhOptionalIdx = zhQuickStart.search(/^### \d+\. 接入飞书/m);
    expect(zhStep2Idx).toBeGreaterThan(-1);
    expect(zhOptionalIdx).toBeGreaterThan(zhStep2Idx);
    const zhBetween = zhQuickStart.slice(zhStep2Idx, zhOptionalIdx);
    expect(zhBetween, "README.zh-CN.md Quick start must add a step between CLI sign-in and optional setup").toMatch(
      /^### 3\./m,
    );
    expect(zhBetween).toContain("`+`");
    expect(zhBetween).toContain("New project manager");
    expect(zhBetween).toContain("Main folder");
    expect(zhBetween).toContain("Create");
  });

  it("README.md and README.zh-CN.md document the Windows no-MXC read-only fallback and Antigravity modelProvider setting", () => {
    for (const file of ["README.md", "README.zh-CN.md"] as const) {
      const text = readRepoFile(file);
      const readonlyLine = text.split(/\r?\n/).find((line) => /Read-only Workers|只读 Worker/.test(line)) ?? "";
      expect(readonlyLine, `${file} read-only Worker bullet must note Windows MXC fallback`).toContain("MXC");
      expect(readonlyLine, `${file} read-only Worker bullet must mention Windows fallback limitation`).toMatch(
        /Windows/i,
      );

      const agyLine = text.split(/\r?\n/).find((line) => line.includes("**Antigravity (`agy`)")) ?? "";
      expect(agyLine, `${file} Antigravity manual login must document modelProvider`).toContain("modelProvider");
      expect(agyLine, `${file} Antigravity manual login must set modelProvider to gemini`).toContain("gemini");
    }
  });

  it("README.md and README.zh-CN.md align hub ask example with --recommended A and omit unmeasured Router latency claims", () => {
    for (const file of ["README.md", "README.zh-CN.md"] as const) {
      const text = readRepoFile(file);
      const askLine = text.split(/\r?\n/).find((line) => line.trimStart().startsWith("hub ask ")) ?? "";
      expect(askLine, `${file} hub ask example must include --recommended A`).toContain("--recommended A");
    }

    const en = readRepoFile("README.md");
    expect(en, "README.md must not make an unmeasured Router latency claim").not.toMatch(/response latency stays steady/i);
  });

  it("scripts/test-related.ts registers src/user-docs-followups.test.ts in ALWAYS_RUN_TESTS", () => {
    expect(ALWAYS_RUN_TESTS).toContain("src/user-docs-followups.test.ts");
  });
});

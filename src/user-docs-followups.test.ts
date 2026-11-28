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

  it("docs/linux.md documents AGENT_HUB_HOME for mesh/feishu commands and multi-instance SSH, journalctl, and ui-token mapping", () => {
    const linuxDoc = readRepoFile("docs/linux.md");
    const connectSection = sectionBetween(linuxDoc, /^## 4\. Connect from your laptop or phone$/m, /^## /m);
    expect(connectSection, "docs/linux.md must include section 4").not.toBe("");

    expect(connectSection, "docs/linux.md must show AGENT_HUB_HOME example for mesh CLI").toMatch(
      /AGENT_HUB_HOME=\S+\s+node src\/mesh\/main\.ts\b/,
    );
    expect(connectSection, "docs/linux.md must show AGENT_HUB_HOME example for feishu CLI").toMatch(
      /AGENT_HUB_HOME=\S+\s+node src\/feishu\/main\.ts\b/,
    );
    expect(
      connectSection,
      "docs/linux.md must warn that omitting AGENT_HUB_HOME accesses default admin.sock and state/ui-token",
    ).toMatch(/Omitting `AGENT_HUB_HOME`[\s\S]*~\/\.agent-hub\/run\/admin\.sock[\s\S]*~\/\.agent-hub\/state\/ui-token/);
    expect(connectSection, "docs/linux.md must show per-instance SSH port mapping for AGENT_HUB_PORT").toMatch(
      /-L\s+<port>:127\.0\.0\.1:<port>/,
    );
    expect(connectSection, "docs/linux.md must show per-instance systemd unit name for journalctl").toMatch(
      /journalctl --user -u <unit>/,
    );
    expect(connectSection, "docs/linux.md must document <AGENT_HUB_HOME>/state/ui-token path").toContain(
      "<AGENT_HUB_HOME>/state/ui-token",
    );
  });

  it("README.md and README.zh-CN.md document Windows no-MXC fail-closed behavior and Codex exception", () => {
    const enReadonly = readRepoFile("README.md")
      .split(/\r?\n/)
      .find((line) => line.includes("Read-only Workers")) ?? "";
    expect(enReadonly, "README.md read-only Worker bullet must scope Windows MXC requirement to outer-sandbox Workers").toMatch(
      /outer sandbox/i,
    );
    expect(enReadonly).toContain("MXC");
    expect(enReadonly, "README.md must state fail-closed refusal when MXC is unavailable").toMatch(
      /fails closed[\s\S]*refuses to start[\s\S]*instead of degrading/i,
    );
    expect(enReadonly, "README.md must not document the removed fallback path").not.toMatch(/falls back/i);
    expect(enReadonly, "README.md must document the Codex built-in read-only sandbox exception").toMatch(
      /Codex \(`codex`\)[\s\S]*built-in read-only sandbox[\s\S]*without MXC/i,
    );

    const zhReadonly = readRepoFile("README.zh-CN.md")
      .split(/\r?\n/)
      .find((line) => line.includes("只读 Worker")) ?? "";
    expect(zhReadonly, "README.zh-CN.md read-only Worker bullet must scope Windows MXC requirement to outer-sandbox Workers").toContain(
      "外层沙箱",
    );
    expect(zhReadonly).toContain("MXC");
    expect(zhReadonly, "README.zh-CN.md must state fail-closed refusal when MXC is unavailable").toMatch(
      /失败关闭[\s\S]*拒绝启动[\s\S]*不再降级/,
    );
    expect(zhReadonly, "README.zh-CN.md must document the Codex built-in read-only sandbox exception").toMatch(
      /Codex（`codex`）[\s\S]*自带的只读沙箱[\s\S]*无需 MXC/,
    );
  });

  it("README.md, README.zh-CN.md, and docs/linux.md guide Antigravity API key via Settings -> Providers first and explain daemon env for manual setup", () => {
    for (const file of ["README.md", "README.zh-CN.md", "docs/linux.md"] as const) {
      const agyLine = readRepoFile(file)
        .split(/\r?\n/)
        .find((line) => line.includes("Antigravity (`agy`)")) ?? "";
      expect(agyLine, `${file} must point to Settings -> Providers -> Antigravity -> API key`).toContain(
        "Settings → Providers → Antigravity → API key",
      );
      expect(agyLine, `${file} must document GEMINI_API_KEY`).toContain("GEMINI_API_KEY");
      expect(agyLine, `${file} must document modelProvider`).toContain("modelProvider");
      expect(agyLine, `${file} must set modelProvider to gemini`).toContain("gemini");
      expect(agyLine, `${file} must document systemd Environment= and EnvironmentFile=`).toContain("Environment=");
      expect(agyLine, `${file} must document systemd EnvironmentFile=`).toContain("EnvironmentFile=");
      expect(agyLine, `${file} must explain GEMINI_API_KEY must enter the daemon environment`).toMatch(
        /daemon|守护进程/,
      );
      expect(agyLine, `${file} must warn against exporting GEMINI_API_KEY only after startup`).toMatch(
        /after (?:Bellwood|the service)|启动 Bellwood 后/i,
      );
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

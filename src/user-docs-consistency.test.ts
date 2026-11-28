import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALWAYS_RUN_TESTS } from "../scripts/test-related.ts";
import { HUB_CLI_REGISTRY } from "./hub/registry.ts";
import { FEISHU_GUEST_TIERS } from "./shared/feishu.ts";
import { ENV_HUB_TOKEN } from "./shared/hub.ts";
import {
  DEFAULT_UI_PORT,
  FEISHU_CONTEXT_MAX_CHARS,
  FEISHU_CONTEXT_MAX_LINES,
  MESH_LISTEN_PORT,
} from "./shared/limits.ts";
import { RELEASE_INSTALLER_FILES } from "./shared/update.ts";
import { VENDOR_PATHS } from "./vendors/paths-registry.ts";
import { VENDOR_LIST } from "./vendors/registry.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const PUBLIC_USER_DOCS = [
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "docs/linux.md",
  "docs/write-scope.md",
  "docs/README.md",
] as const;

const ARCHITECTURE_SVGS = [
  "docs/screenshots/readme/architecture.svg",
  "docs/screenshots/readme/architecture-dark.svg",
  "docs/screenshots/readme/architecture-zh.svg",
  "docs/screenshots/readme/architecture-zh-dark.svg",
] as const;

const FEISHU_SVGS = [
  "docs/screenshots/readme/feishu-group.svg",
  "docs/screenshots/readme/feishu-group-dark.svg",
  "docs/screenshots/readme/feishu-group-zh.svg",
  "docs/screenshots/readme/feishu-group-zh-dark.svg",
] as const;

// SHA-256 digests of the retired pre-wood-shell (9dd20f40) PNG screenshots that Step 2 must refresh.
const RETIRED_PRE_WOOD_SHELL_PNG_SHA256: Readonly<Record<string, string>> = {
  "docs/screenshots/readme/workspace-en.png": "6a53a625e89204e21637fe3bef6f291a21bee96b72ff56afa5fa13a6b6fd5449",
  "docs/screenshots/readme/workspace-zh.png": "5cbe425e966d08f3324881cfc4b3c2760385402044f5d8f6f454fbd15a0f83c2",
  "docs/screenshots/readme/task-graph-en.png": "5c74d9a903d4da799e9d9ea0d8e056212128a67065088208a0bf1ea521136c36",
  "docs/screenshots/readme/task-graph-zh.png": "d6063e5dd8f2c12ddc6226d95641c7ac52b657c32e3b7d32a7d3452b7e2f9788",
  "docs/screenshots/readme/memory-en.png": "309c1a392979f68ff70202afd492d0d8d49a0d8ea5cef06c5dd7ca77a682e06d",
  "docs/screenshots/readme/memory-zh.png": "0b942c51152a07f8daa246484666bcda34d9cc546da842b051a1bffef482ff8d",
  "docs/screenshots/readme/router-en.png": "cfe33ed02c8b8dae68a0b3f496db68771f53267f794da4d63bda7265bd8493cd",
  "docs/screenshots/readme/router-zh.png": "765301d7402caf240be09e870a30eae81db353bd3f00587776e1a84d3c05752b",
  "docs/screenshots/readme/providers.png": "14e9fb70605385700c80e6ed232770802478aaf2ee785a2a73094e7acf282dc2",
};

function readRepoFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

function sha256RepoFile(relPath: string): string {
  return createHash("sha256").update(readFileSync(join(REPO_ROOT, relPath))).digest("hex");
}

export function slugifyMarkdownHeading(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

export function extractHeadingAnchors(markdown: string): Set<string> {
  const counts = new Map<string, number>();
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#{1,6}\s+(.+)$/.exec(line);
    if (!match) continue;
    const base = slugifyMarkdownHeading(match[1]!);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

export function extractLocalDocTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1]!.trim();
    if (raw !== "" && !/^(?:https?:|mailto:)/i.test(raw)) targets.push(raw);
  }
  for (const match of markdown.matchAll(/(?:src|srcset)="([^"]+)"/g)) {
    const raw = match[1]!.trim();
    if (raw !== "" && !/^(?:https?:|data:)/i.test(raw)) targets.push(raw);
  }
  return targets;
}

export function validateUserDocLinks(input: {
  relPath: string;
  markdown: string;
  exists: (absPath: string) => boolean;
  readText: (absPath: string) => string;
  repoRoot?: string;
}): string[] {
  const root = input.repoRoot ?? REPO_ROOT;
  const problems: string[] = [];
  const ownAnchors = extractHeadingAnchors(input.markdown);
  const baseDir = dirname(join(root, input.relPath));

  for (const target of extractLocalDocTargets(input.markdown)) {
    if (target.startsWith("#")) {
      const anchor = target.slice(1);
      if (!ownAnchors.has(anchor)) {
        problems.push(`${input.relPath}: broken anchor ${target}`);
      }
      continue;
    }
    const [pathPart = "", anchor] = target.split("#");
    const absTarget = resolve(baseDir, pathPart);
    if (!input.exists(absTarget)) {
      problems.push(`${input.relPath}: missing target ${target}`);
      continue;
    }
    if (anchor && absTarget.endsWith(".md")) {
      const targetAnchors = extractHeadingAnchors(input.readText(absTarget));
      if (!targetAnchors.has(anchor)) {
        problems.push(`${input.relPath}: broken cross-file anchor ${target}`);
      }
    }
  }
  return problems;
}

export function extractHubCommandsFromMarkdown(markdown: string): string[] {
  const commands: string[] = [];
  const fenceRegex = /```(?:sh|bash|shell|zsh|powershell|pwsh)?\r?\n([\s\S]*?)```/g;
  for (const fence of markdown.matchAll(fenceRegex)) {
    for (const rawLine of fence[1]!.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      const match = /^hub\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/.exec(line);
      if (!match) continue;
      const first = match[1]!;
      const second = match[2];
      commands.push(second && !second.startsWith("-") ? `${first} ${second}` : first);
    }
  }
  return commands;
}

function knownHubCliCommands(): Set<string> {
  const known = new Set<string>(["help"]);
  for (const entry of HUB_CLI_REGISTRY) {
    known.add(entry.cli);
    known.add(entry.group);
  }
  return known;
}

function normalizeMarkdownTablePipes(text: string): string {
  return text.replace(/\\\|/g, "|");
}

describe("new behavior: README and user documentation rewrite (expected to fail before implementation)", () => {
  it("A1: README.md and README.zh-CN.md remove retired Pieces terminology and document the Work panel tabs", () => {
    for (const file of ["README.md", "README.zh-CN.md"] as const) {
      const text = readRepoFile(file);
      expect(text, `${file} must not refer to retired Pieces UI terminology`).not.toMatch(/\bPieces\b/);
      expect(text, `${file} must name the Active tab`).toContain("Active");
      expect(text, `${file} must name the Completed tab`).toContain("Completed");
      expect(text, `${file} must name the Info tab`).toContain("Info");
    }
    expect(readRepoFile("README.md")).toMatch(/work panel/i);
  });

  it("A2: README.md and README.zh-CN.md stay workflow-neutral and present independent review as opt-in", () => {
    const en = readRepoFile("README.md");
    const zh = readRepoFile("README.zh-CN.md");

    expect(en).not.toMatch(/merges their PRs/i);
    expect(en).not.toMatch(/critical changes run through an independent read-only review/i);
    expect(en).toMatch(/opt-in|optional|when you ask|project rules/i);

    expect(zh).not.toContain("合 PR");
    expect(zh).not.toContain("碰到关键改动，还会自动排入另一家模型的独立只读审查");
    expect(zh).toMatch(/可选|按需|需要时|项目规矩|项目约定/);
  });

  it("A3: README.md and README.zh-CN.md use accurate hub CLI commands and cover newly shipped capabilities", () => {
    const known = knownHubCliCommands();
    for (const file of ["README.md", "README.zh-CN.md"] as const) {
      const text = readRepoFile(file);
      expect(text, `${file} must not claim hub persona edit updates project memory`).not.toMatch(
        /hub persona edit[^\n]*(?:project memory|项目记忆)/i,
      );

      for (const cmd of extractHubCommandsFromMarkdown(text)) {
        const groupOnly = cmd.split(" ")[0]!;
        expect(known.has(cmd) || known.has(groupOnly), `${file} references unknown hub command "${cmd}"`).toBe(true);
      }

      expect(text, `${file} must document Settings Capabilities`).toContain("Capabilities");
      expect(text, `${file} must document Settings Resources`).toContain("Resources");
      expect(text, `${file} must document gh attestation verify`).toContain("gh attestation verify");
      expect(text, `${file} must document hub watch or daemon-managed waits`).toMatch(/hub watch|watch/i);
      expect(text, `${file} must document Computer Use --no-outer-sandbox`).toContain("--no-outer-sandbox");
    }

    const en = readRepoFile("README.md");
    expect(en, "README.md must document top-bar quick Router input").toMatch(/top bar|top-bar/i);
    expect(en, "README.md must document live progress checklists").toMatch(/checklist/i);

    const zh = readRepoFile("README.zh-CN.md");
    expect(zh, "README.zh-CN.md must document top-bar quick Router input").toMatch(/顶部/);
    expect(zh, "README.zh-CN.md must document live progress checklists").toMatch(/进度清单|清单/);
  });

  it("A4: all four architecture SVGs cover every registered vendor CLI and all three platforms", () => {
    for (const svgPath of ARCHITECTURE_SVGS) {
      const svg = readRepoFile(svgPath);
      for (const vendor of VENDOR_LIST) {
        expect(svg, `${svgPath} must list vendor CLI "${vendor.cli.command}" (${vendor.id})`).toContain(vendor.cli.command);
      }
      expect(svg, `${svgPath} must mention macOS`).toMatch(/macOS|Mac/i);
      expect(svg, `${svgPath} must mention Windows`).toMatch(/Windows|Win/i);
      expect(svg, `${svgPath} must mention Linux`).toMatch(/Linux/i);
    }
  });

  it("A5: public user-facing documentation contains no third-party reference product names", () => {
    for (const file of PUBLIC_USER_DOCS) {
      const text = readRepoFile(file);
      expect(text, `${file} must not name third-party reference products`).not.toMatch(/\b(?:openclaw|magpie)\b/i);
    }
  });

  it("A6: SECURITY.md and docs/write-scope.md match current sandbox boundaries, token name, and vendor count", () => {
    const security = readRepoFile("SECURITY.md");
    const [enSection = "", zhSection = ""] = security.split("## 安全策略");

    expect(enSection, "SECURITY.md English must document --no-outer-sandbox").toContain("--no-outer-sandbox");
    expect(enSection, "SECURITY.md English must document per-app Computer Use approval").toMatch(/per-app|app approval/i);
    expect(zhSection, "SECURITY.md Chinese must document --no-outer-sandbox").toContain("--no-outer-sandbox");
    expect(zhSection, "SECURITY.md Chinese must document per-app Computer Use approval").toMatch(/应用.*(?:确认|批准)|逐应用/);

    const writeScope = readRepoFile("docs/write-scope.md");
    expect(writeScope, "docs/write-scope.md must not use outdated AGENT_HUB_TOKEN name").not.toContain("AGENT_HUB_TOKEN");
    expect(writeScope, "docs/write-scope.md must use exact ENV_HUB_TOKEN name").toContain(ENV_HUB_TOKEN);
    expect(writeScope, "docs/write-scope.md must not say 'other five vendors'").not.toMatch(/other five vendors/i);
    expect(writeScope, "docs/write-scope.md must reflect all non-Codex Windows vendors").toMatch(/other seven vendors|other 7 vendors/i);
  });

  it("A7: docs/README.md leads with user guides, READMEs list complete env vars, accurate rail UI, and no internal design links in manual install", () => {
    const docsIndex = readRepoFile("docs/README.md");
    const userSectionIdx = docsIndex.search(/^##\s+User\b/m);
    const standardsIdx = docsIndex.search(/^##\s+Standards\b/m);
    expect(userSectionIdx, "docs/README.md must have a User guides section").toBeGreaterThan(-1);
    expect(standardsIdx).toBeGreaterThan(-1);
    expect(userSectionIdx, "docs/README.md must place User guides before Standards").toBeLessThan(standardsIdx);
    const userSlice = docsIndex.slice(userSectionIdx, standardsIdx);
    expect(userSlice).toContain("linux.md");
    expect(userSlice).toContain("write-scope.md");

    for (const file of ["README.md", "README.zh-CN.md"] as const) {
      const text = readRepoFile(file);
      for (const vendor of VENDOR_LIST) {
        expect(text, `${file} must spell out env var ${vendor.cli.envVar}`).toContain(vendor.cli.envVar);
      }
      expect(text, `${file} must document FUSA_MESH_PORT`).toContain("FUSA_MESH_PORT");
      expect(text, `${file} must document default mesh port ${MESH_LISTEN_PORT}`).toContain(String(MESH_LISTEN_PORT));
      expect(text, `${file} must not link manual vendor installs to internal vendor-plugin-design.md`).not.toContain(
        "docs/vendor-plugin-design.md",
      );
    }

    expect(readRepoFile("README.md")).not.toMatch(/paired computers with status dots and attention badges/i);
    expect(readRepoFile("README.zh-CN.md")).not.toContain("各台已配对电脑及待处理角标");
  });

  it("A8: README.md and README.zh-CN.md follow technical-writing and unslop hygiene", () => {
    const en = readRepoFile("README.md");
    expect(en, "README.md must not use em dashes").not.toContain("—");
    for (const banned of [
      "seamlessly",
      "plumbing underneath",
      "zero downtime",
      "stays crisp",
      "utilize",
      "leverage",
      "delve",
      "tapestry",
    ]) {
      expect(en.toLowerCase(), `README.md must avoid slop phrase "${banned}"`).not.toContain(banned);
    }

    const zh = readRepoFile("README.zh-CN.md");
    for (const banned of ["彻底告别", "硬啃百万字", "绝不插嘴刷屏", "像刚装好第一天一样快"]) {
      expect(zh, `README.zh-CN.md must avoid marketing filler "${banned}"`).not.toContain(banned);
    }
  });

  it("A9: all nine README workbench PNG screenshots are refreshed off the retired pre-wood-shell captures", () => {
    for (const [relPath, retiredSha] of Object.entries(RETIRED_PRE_WOOD_SHELL_PNG_SHA256)) {
      const full = join(REPO_ROOT, relPath);
      expect(existsSync(full), `${relPath} must exist`).toBe(true);
      const currentSha = sha256RepoFile(relPath);
      expect(currentSha, `${relPath} is still the retired pre-wood-shell capture`).not.toBe(retiredSha);
    }
  });

  it("A10: scripts/test-related.ts registers src/user-docs-consistency.test.ts in ALWAYS_RUN_TESTS", () => {
    expect(ALWAYS_RUN_TESTS).toContain("src/user-docs-consistency.test.ts");
  });
});

describe("regression: unchanged user documentation contracts (expected to pass before and after implementation)", () => {
  it("R1: every local link, anchor, and image reference resolves across all public user docs", () => {
    const allProblems: string[] = [];
    for (const file of PUBLIC_USER_DOCS) {
      allProblems.push(
        ...validateUserDocLinks({
          relPath: file,
          markdown: readRepoFile(file),
          exists: existsSync,
          readText: (abs) => readFileSync(abs, "utf8"),
        }),
      );
    }
    expect(allProblems).toEqual([]);
  });

  it("R2: README.md, README.zh-CN.md, and docs/linux.md stay synced with every vendor CLI and install command", () => {
    const en = normalizeMarkdownTablePipes(readRepoFile("README.md"));
    const zh = normalizeMarkdownTablePipes(readRepoFile("README.zh-CN.md"));
    const linux = normalizeMarkdownTablePipes(readRepoFile("docs/linux.md"));

    for (const vendor of VENDOR_LIST) {
      const paths = VENDOR_PATHS[vendor.id];
      for (const [name, text] of [
        ["README.md", en],
        ["README.zh-CN.md", zh],
        ["docs/linux.md", linux],
      ] as const) {
        expect(text, `${name} must include CLI command "${vendor.cli.command}"`).toContain(vendor.cli.command);
        if (paths.installCommand) {
          expect(text, `${name} must include POSIX install command for ${vendor.id}`).toContain(paths.installCommand);
        }
      }
      if (paths.windowsInstallCommand) {
        expect(en, `README.md must include Windows install command for ${vendor.id}`).toContain(paths.windowsInstallCommand);
        expect(zh, `README.zh-CN.md must include Windows install command for ${vendor.id}`).toContain(paths.windowsInstallCommand);
      }
    }
  });

  it("R3: release installer and checksum filenames stay synced with RELEASE_INSTALLER_FILES", () => {
    for (const file of ["README.md", "README.zh-CN.md", ".github/release-downloads.md"] as const) {
      const text = readRepoFile(file);
      for (const installer of Object.values(RELEASE_INSTALLER_FILES)) {
        expect(text, `${file} must include installer ${installer}`).toContain(installer);
        expect(text, `${file} must include checksum ${installer}.sha256`).toContain(`${installer}.sha256`);
      }
    }
  });

  it("R4: SECURITY.md preserves supported version series, loopback port, hub token name, and Feishu guest tiers", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as { version: string };
    const expectedSeries = `${pkg.version.split(".").slice(0, 2).join(".")}.x`;
    const security = readRepoFile("SECURITY.md");
    const declaredSeries = Array.from(security.matchAll(/`(\d+\.\d+\.x)`/g), (m) => m[1]!);
    expect(declaredSeries.length).toBeGreaterThanOrEqual(2);
    for (const series of declaredSeries) expect(series).toBe(expectedSeries);

    expect(security).toContain(String(DEFAULT_UI_PORT));
    expect(security).toContain(ENV_HUB_TOKEN);
    for (const tier of FEISHU_GUEST_TIERS) {
      expect(security, `SECURITY.md must document Feishu guest tier "${tier}"`).toContain(tier);
    }
  });

  it("R5: Feishu group workflow SVGs stay consistent with buffer limits in src/shared/limits.ts", () => {
    for (const svgPath of FEISHU_SVGS) {
      const svg = readRepoFile(svgPath);
      expect(svg, `${svgPath} must match FEISHU_CONTEXT_MAX_LINES`).toContain(String(FEISHU_CONTEXT_MAX_LINES));
      if (!svgPath.includes("-zh")) {
        expect(svg, `${svgPath} must match FEISHU_CONTEXT_MAX_CHARS`).toContain(
          FEISHU_CONTEXT_MAX_CHARS.toLocaleString("en-US"),
        );
      }
    }
  });

  it("R6: doc-consistency helpers handle empty, malformed, and broken markdown inputs cleanly", () => {
    expect(extractLocalDocTargets("")).toEqual([]);
    expect(extractHubCommandsFromMarkdown("not a code fence")).toEqual([]);
    expect(slugifyMarkdownHeading("Router: one entry point (v0.4)")).toBe("router-one-entry-point-v04");

    const dupAnchors = extractHeadingAnchors("# Title\n\n## Setup\n\n## Setup\n\n```sh\n## Not a heading\n```\n");
    expect(dupAnchors.has("setup")).toBe(true);
    expect(dupAnchors.has("setup-1")).toBe(true);
    expect(dupAnchors.has("not-a-heading")).toBe(false);

    const problems = validateUserDocLinks({
      relPath: "README.md",
      markdown: [
        "# Home",
        "[OK](#home)",
        "[Bad anchor](#missing-section)",
        "[Missing file](docs/does-not-exist.md)",
        "[Bad cross anchor](docs/target.md#nope)",
        "[Good cross anchor](docs/target.md#real)",
        `<img src="docs/missing.png">`,
      ].join("\n"),
      exists: (abs) => abs.endsWith("/docs/target.md"),
      readText: () => "# Target\n\n## Real\n",
      repoRoot: "/virtual-repo",
    });
    expect(problems).toEqual([
      "README.md: broken anchor #missing-section",
      "README.md: missing target docs/does-not-exist.md",
      "README.md: broken cross-file anchor docs/target.md#nope",
      "README.md: missing target docs/missing.png",
    ]);
  });
});

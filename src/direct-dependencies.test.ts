import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml } from "@decimalturn/toml-patch";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const NON_PACKAGE_BACKTICKS = new Set(["fsync", "rename", "normalize", "codesign", "hdiutil"]);
const PACKAGE_TOKEN = /^(@[a-z0-9-]+\/[a-z0-9._-]+|[a-z][a-z0-9_-]*)$/;
const WILDCARD_PACKAGE = /`(@[^`\s]+\*[^`]*)`/;

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface CargoTomlShape {
  workspace?: {
    members?: string[];
    dependencies?: Record<string, unknown>;
  };
  dependencies?: Record<string, unknown>;
  "dev-dependencies"?: Record<string, unknown>;
  "build-dependencies"?: Record<string, unknown>;
  target?: Record<string, { dependencies?: Record<string, unknown>; "dev-dependencies"?: Record<string, unknown> }>;
}

function extractDirectDependenciesSection(agentsMd: string): string {
  const start = agentsMd.indexOf("\n## Direct dependencies");
  const headerStart = start !== -1 ? start + 1 : agentsMd.startsWith("## Direct dependencies") ? 0 : -1;
  if (headerStart === -1) throw new Error("AGENTS.md is missing the `## Direct dependencies` section");
  const nextSection = agentsMd.indexOf("\n## ", headerStart + 1);
  return nextSection === -1 ? agentsMd.slice(headerStart) : agentsMd.slice(headerStart, nextSection);
}

function collectNpmDeps(pkg: PackageManifest): string[] {
  return [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])].sort();
}

function isExternalCargoDep(spec: unknown): boolean {
  if (typeof spec === "object" && spec !== null) {
    const table = spec as Record<string, unknown>;
    if (table.workspace === true || typeof table.path === "string") return false;
  }
  return true;
}

function collectCargoDeps(rootToml: string, crateTomls: readonly string[]): { deps: string[]; members: string[] } {
  const parsedRoot = parseToml(rootToml) as CargoTomlShape;
  const members = (parsedRoot.workspace?.members ?? []).map((m) => m.split("/").at(-1)!);
  const deps = new Set<string>(Object.keys(parsedRoot.workspace?.dependencies ?? {}));
  for (const raw of crateTomls) {
    const crate = parseToml(raw) as CargoTomlShape;
    const sections = [
      crate.dependencies,
      crate["dev-dependencies"],
      crate["build-dependencies"],
      ...Object.values(crate.target ?? {}).flatMap((t) => [t.dependencies, t["dev-dependencies"]]),
    ];
    for (const table of sections) {
      if (!table) continue;
      for (const [name, spec] of Object.entries(table)) {
        if (isExternalCargoDep(spec)) deps.add(name);
      }
    }
  }
  return { deps: [...deps].sort(), members };
}

export function checkDirectDependenciesSync(input: {
  agentsMd: string;
  packageJson: PackageManifest;
  rootCargoToml: string;
  crateCargoTomls?: readonly string[];
  uiPrimitiveNames: readonly string[];
}): string[] {
  const section = extractDirectDependenciesSection(input.agentsMd);
  const problems: string[] = [];

  const wildcard = WILDCARD_PACKAGE.exec(section);
  if (wildcard) {
    problems.push(`AGENTS.md Direct dependencies uses wildcard \`${wildcard[1]}\`; list every direct dependency explicitly.`);
  }

  const npmDeps = collectNpmDeps(input.packageJson);
  const { deps: cargoDeps, members } = collectCargoDeps(input.rootCargoToml, input.crateCargoTomls ?? []);
  const backticks = [...new Set([...section.matchAll(/`([^`]+)`/g)].map((m) => m[1]!))];
  const backtickSet = new Set(backticks);

  for (const dep of npmDeps) {
    if (!backtickSet.has(dep)) {
      problems.push(`package.json dependency \`${dep}\` is missing from AGENTS.md Direct dependencies.`);
    }
  }
  for (const dep of cargoDeps) {
    if (!backtickSet.has(dep)) {
      problems.push(`apps/windows/Cargo.toml dependency \`${dep}\` is missing from AGENTS.md Direct dependencies.`);
    }
  }

  const declared = new Set([...npmDeps, ...cargoDeps]);
  const allowedNonPackages = new Set([...NON_PACKAGE_BACKTICKS, ...members, ...input.uiPrimitiveNames]);
  for (const token of backticks) {
    if (PACKAGE_TOKEN.test(token) && !declared.has(token) && !allowedNonPackages.has(token)) {
      problems.push(`AGENTS.md Direct dependencies lists \`${token}\`, which is not in package.json or apps/windows/Cargo.toml.`);
    }
  }

  return problems;
}

function readRepoUiPrimitiveNames(): string[] {
  return readdirSync(join(REPO_ROOT, "src", "web", "ui"))
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => file.replace(/\.tsx$/, ""));
}

function readRepoCargoInputs(): { rootCargoToml: string; crateCargoTomls: string[] } {
  const winDir = join(REPO_ROOT, "apps", "windows");
  const rootCargoToml = readFileSync(join(winDir, "Cargo.toml"), "utf8");
  const parsed = parseToml(rootCargoToml) as CargoTomlShape;
  const crateCargoTomls = (parsed.workspace?.members ?? []).map((member) => readFileSync(join(winDir, member, "Cargo.toml"), "utf8"));
  return { rootCargoToml, crateCargoTomls };
}

describe("AGENTS.md Direct dependencies guard", () => {
  it("matches package.json and apps/windows/Cargo.toml direct dependencies exactly", () => {
    const agentsMd = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as PackageManifest;
    const { rootCargoToml, crateCargoTomls } = readRepoCargoInputs();
    const problems = checkDirectDependenciesSync({
      agentsMd,
      packageJson,
      rootCargoToml,
      crateCargoTomls,
      uiPrimitiveNames: readRepoUiPrimitiveNames(),
    });
    expect(problems).toEqual([]);
  });

  it("fails when a package.json or Cargo.toml dependency is missing, stale, or wildcarded in AGENTS.md", () => {
    const baseAgents = [
      "## Direct dependencies",
      "",
      "- `fastify` and `vitest` and `@types/node`.",
      "- `serde` and `tauri`.",
    ].join("\n");
    const baseCargo = [
      "[workspace]",
      'members = ["crates/fusa-desktop"]',
      "[workspace.dependencies]",
      'serde = "1.0"',
      'tauri = "2.12"',
    ].join("\n");
    const basePkg: PackageManifest = { dependencies: { fastify: "^5.0.0" }, devDependencies: { vitest: "^5.0.0", "@types/node": "^24.0.0" } };

    expect(
      checkDirectDependenciesSync({
        agentsMd: baseAgents,
        packageJson: basePkg,
        rootCargoToml: baseCargo,
        uiPrimitiveNames: [],
      }),
    ).toEqual([]);

    expect(
      checkDirectDependenciesSync({
        agentsMd: baseAgents,
        packageJson: { ...basePkg, dependencies: { ...basePkg.dependencies, zod: "^4.0.0" } },
        rootCargoToml: baseCargo,
        uiPrimitiveNames: [],
      }),
    ).toEqual(["package.json dependency `zod` is missing from AGENTS.md Direct dependencies."]);

    expect(
      checkDirectDependenciesSync({
        agentsMd: baseAgents,
        packageJson: basePkg,
        rootCargoToml: `${baseCargo}\nureq = "3.5"\n`,
        uiPrimitiveNames: [],
      }),
    ).toEqual(["apps/windows/Cargo.toml dependency `ureq` is missing from AGENTS.md Direct dependencies."]);

    expect(
      checkDirectDependenciesSync({
        agentsMd: baseAgents,
        packageJson: { dependencies: {}, devDependencies: basePkg.devDependencies },
        rootCargoToml: baseCargo,
        uiPrimitiveNames: [],
      }),
    ).toEqual(["AGENTS.md Direct dependencies lists `fastify`, which is not in package.json or apps/windows/Cargo.toml."]);

    expect(
      checkDirectDependenciesSync({
        agentsMd: `${baseAgents}\n- \`@types/*\`.\n`,
        packageJson: basePkg,
        rootCargoToml: baseCargo,
        uiPrimitiveNames: [],
      })[0],
    ).toMatch(/wildcard `@types\/\*`/);
  });
});

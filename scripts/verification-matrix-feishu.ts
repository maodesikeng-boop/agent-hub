// Derives packaged desktop Feishu CLI paths from actual packaging scripts and Tauri configs so README cannot drift.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PackagedFeishuLayout {
  macAppPath: string;
  macRuntimeRelativeDir: string;
  macNodeRelativePath: string;
  macFeishuEntryRelativePath: string;
  winInstallDirEnv: string;
  winNodeRelativePath: string;
  winFeishuEntryRelativePath: string;
  sourceFeishuEntryRelativePath: string;
}

export interface PackagedFeishuCommands {
  macConnect: string;
  macStatus: string;
  winConnectPowerShell: string;
  winStatusPowerShell: string;
  sourceConnect: string;
  sourceStatus: string;
}

function requireMatch(source: string, pattern: RegExp, description: string): string {
  const match = pattern.exec(source);
  if (!match?.[1]) throw new Error(`Unable to derive ${description} from packaging sources`);
  return match[1];
}

export function readPackagedFeishuLayout(repoRoot: string): PackagedFeishuLayout {
  const sourceFeishuEntry = "src/feishu/main.ts";
  if (!existsSync(join(repoRoot, sourceFeishuEntry))) {
    throw new Error(`Missing Feishu CLI entrypoint: ${sourceFeishuEntry}`);
  }

  const stageCommon = readFileSync(join(repoRoot, "scripts", "stage-runtime-common.ts"), "utf8");
  const daemonSubdirs = requireMatch(stageCommon, /const\s+DAEMON_SOURCE_SUBDIRS\s*=\s*\[([^\]]+)\]/, "DAEMON_SOURCE_SUBDIRS");
  if (!/["']feishu["']/.test(daemonSubdirs)) {
    throw new Error('scripts/stage-runtime-common.ts DAEMON_SOURCE_SUBDIRS must include "feishu"');
  }

  const macBuild = readFileSync(join(repoRoot, "scripts", "build-mac-app.sh"), "utf8");
  const macAppName = requireMatch(macBuild, /^APP_NAME="([^"]+)"/m, "macOS APP_NAME in scripts/build-mac-app.sh");
  const macContentsSeg = requireMatch(macBuild, /^CONTENTS_DIR="\$APP_DIR\/([^"]+)"/m, "macOS CONTENTS_DIR");
  const macResourcesSeg = requireMatch(macBuild, /^RESOURCES_DIR="\$CONTENTS_DIR\/([^"]+)"/m, "macOS RESOURCES_DIR");
  const macRuntimeSeg = requireMatch(macBuild, /^RUNTIME_DIR="\$RESOURCES_DIR\/([^"]+)"/m, "macOS RUNTIME_DIR");
  if (!macBuild.includes("/Applications")) {
    throw new Error("scripts/build-mac-app.sh must install or link against /Applications");
  }

  const macStage = readFileSync(join(repoRoot, "scripts", "stage-mac-runtime.ts"), "utf8");
  const macNodeDir = requireMatch(macStage, /const\s+nodeOutDir\s*=\s*join\(outDir,\s*["']([^"']+)["']\)/, "macOS nodeOutDir");
  const macDaemonDir = requireMatch(macStage, /const\s+daemonOutDir\s*=\s*join\(outDir,\s*["']([^"']+)["']\)/, "macOS daemonOutDir");
  const macNodeBinDir = requireMatch(macStage, /const\s+binOut\s*=\s*join\(nodeOutDir,\s*["']([^"']+)["']\)/, "macOS node bin dir");
  const macNodeExe = requireMatch(macStage, /const\s+stagedNode\s*=\s*join\(binOut,\s*["']([^"']+)["']\)/, "macOS node binary");
  const macNodeRelativePath = `${macNodeDir}/${macNodeBinDir}/${macNodeExe}`;
  if (!macBuild.includes(`$RUNTIME_DIR/${macNodeRelativePath}`)) {
    throw new Error(`scripts/build-mac-app.sh does not reference $RUNTIME_DIR/${macNodeRelativePath}`);
  }

  const tauriConf = JSON.parse(
    readFileSync(join(repoRoot, "apps", "windows", "crates", "fusa-desktop", "tauri.conf.json"), "utf8"),
  ) as { productName?: string; bundle?: { windows?: { nsis?: { installMode?: string } } } };
  const productName = tauriConf.productName?.trim();
  if (!productName) throw new Error("tauri.conf.json missing productName");
  const installMode = tauriConf.bundle?.windows?.nsis?.installMode;

  const tauriBundleConf = JSON.parse(
    readFileSync(join(repoRoot, "apps", "windows", "crates", "fusa-desktop", "tauri.bundle.conf.json"), "utf8"),
  ) as { bundle?: { resources?: Record<string, string>; windows?: { nsis?: { installMode?: string } } } };
  const bundleInstallMode = tauriBundleConf.bundle?.windows?.nsis?.installMode;
  if (bundleInstallMode && installMode && bundleInstallMode !== installMode) {
    throw new Error(`NSIS installMode mismatch: tauri.conf.json (${installMode}) vs tauri.bundle.conf.json (${bundleInstallMode})`);
  }
  const effectiveInstallMode = bundleInstallMode ?? installMode;
  const winInstallRoot =
    effectiveInstallMode === "currentUser"
      ? "$env:LOCALAPPDATA"
      : effectiveInstallMode === "perMachine"
        ? "$env:ProgramFiles"
        : undefined;
  if (!winInstallRoot) {
    throw new Error(`Unsupported NSIS installMode "${String(effectiveInstallMode)}" in tauri config`);
  }

  const winStage = readFileSync(join(repoRoot, "scripts", "stage-win-runtime.ts"), "utf8");
  const winStageNodeDir = requireMatch(winStage, /const\s+nodeOutDir\s*=\s*join\(outDir,\s*["']([^"']+)["']\)/, "Windows nodeOutDir");
  const winStageDaemonDir = requireMatch(winStage, /const\s+daemonOutDir\s*=\s*join\(outDir,\s*["']([^"']+)["']\)/, "Windows daemonOutDir");
  const winNodeExe = requireMatch(winStage, /:\s*["'](node\.exe)["']\s*;/, "Windows node.exe filename");

  const resources = tauriBundleConf.bundle?.resources ?? {};
  const winNodeResource = resources[`staged-runtime/${winStageNodeDir}`];
  const winDaemonResource = resources[`staged-runtime/${winStageDaemonDir}`];
  if (!winNodeResource) throw new Error(`tauri.bundle.conf.json missing resource mapping for staged-runtime/${winStageNodeDir}`);
  if (!winDaemonResource) throw new Error(`tauri.bundle.conf.json missing resource mapping for staged-runtime/${winStageDaemonDir}`);

  return {
    macAppPath: `/Applications/${macAppName}`,
    macRuntimeRelativeDir: `${macContentsSeg}/${macResourcesSeg}/${macRuntimeSeg}`,
    macNodeRelativePath,
    macFeishuEntryRelativePath: `${macDaemonDir}/${sourceFeishuEntry}`,
    winInstallDirEnv: `${winInstallRoot}\\${productName}`,
    winNodeRelativePath: `${winNodeResource.replace(/\//g, "\\")}\\${winNodeExe}`,
    winFeishuEntryRelativePath: `${winDaemonResource.replace(/\//g, "\\")}\\${sourceFeishuEntry.replace(/\//g, "\\")}`,
    sourceFeishuEntryRelativePath: sourceFeishuEntry,
  };
}

const joinPosix = (...parts: string[]) =>
  parts.map((p, idx) => (idx === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, ""))).join("/");
const joinWin = (...parts: string[]) =>
  parts.map((p, idx) => (idx === 0 ? p.replace(/\\+$/, "") : p.replace(/^\\+|\\+$/g, ""))).join("\\");

export function packagedFeishuCommands(layout: PackagedFeishuLayout): PackagedFeishuCommands {
  const macRuntime = joinPosix(layout.macAppPath, layout.macRuntimeRelativeDir);
  const macNode = joinPosix(macRuntime, layout.macNodeRelativePath);
  const macEntry = joinPosix(macRuntime, layout.macFeishuEntryRelativePath);
  const winNode = joinWin(layout.winInstallDirEnv, layout.winNodeRelativePath);
  const winEntry = joinWin(layout.winInstallDirEnv, layout.winFeishuEntryRelativePath);
  const sourceEntry = layout.sourceFeishuEntryRelativePath.replace(/^\/+/, "");
  return {
    macConnect: `${macNode} ${macEntry} connect`,
    macStatus: `${macNode} ${macEntry} status`,
    winConnectPowerShell: `& "${winNode}" "${winEntry}" connect`,
    winStatusPowerShell: `& "${winNode}" "${winEntry}" status`,
    sourceConnect: `node ${sourceEntry} connect`,
    sourceStatus: `node ${sourceEntry} status`,
  };
}

function extractSection(markdown: string, startHeading: RegExp, endHeading: RegExp): string {
  const startMatch = startHeading.exec(markdown);
  if (!startMatch) return "";
  const rest = markdown.slice(startMatch.index);
  const nextMatch = endHeading.exec(rest.slice(startMatch[0].length));
  return nextMatch ? rest.slice(0, startMatch[0].length + nextMatch.index) : rest;
}

function checkReadmeFeishuQuickStart(opts: {
  label: string;
  markdown: string;
  step4Heading: RegExp;
  feishuSectionHeading: RegExp;
  sourceScopePattern: RegExp;
  cliOnlyDisclosurePattern: RegExp;
  commands: PackagedFeishuCommands;
  problems: string[];
}): void {
  const { label, markdown, step4Heading, feishuSectionHeading, sourceScopePattern, cliOnlyDisclosurePattern, commands, problems } =
    opts;
  if (!markdown.includes("docs/verification-matrix.md")) problems.push(`${label}: missing link to docs/verification-matrix.md`);

  const step4 = extractSection(markdown, step4Heading, /^(?:### |## |<details>)/m);
  if (!step4) {
    problems.push(`${label}: missing Quick start step 4 section`);
    return;
  }

  for (const [name, cmd] of Object.entries(commands)) {
    if (!step4.includes(cmd)) problems.push(`${label}: Quick start step 4 missing ${name} command`);
  }
  if (!cliOnlyDisclosurePattern.test(step4)) {
    problems.push(`${label}: Quick start step 4 must disclose that Feishu setup uses the bundled CLI rather than an in-app Settings tab`);
  }
  if (!step4.includes("Settings → Computers") && !step4.includes("Settings -> Computers")) {
    problems.push(`${label}: Quick start step 4 must reference Settings -> Computers for bot host status`);
  }

  const sourceLines = step4.split(/\r?\n/).filter((line) => line.includes(commands.sourceConnect));
  if (sourceLines.length === 0 || sourceLines.some((line) => !sourceScopePattern.test(line))) {
    problems.push(`${label}: Quick start step 4 must scope "${commands.sourceConnect}" to Linux or source checkouts`);
  }

  const feishuSection = extractSection(markdown, feishuSectionHeading, /^## /m);
  if (!feishuSection) {
    problems.push(`${label}: missing Feishu overview section`);
    return;
  }
  const bareLines = feishuSection.split(/\r?\n/).filter((line) => line.includes(commands.sourceConnect) && !sourceScopePattern.test(line));
  if (bareLines.length > 0) {
    problems.push(`${label}: Feishu section uses unqualified "${commands.sourceConnect}" without Linux/source scoping`);
  }
}

export function validateFeishuQuickStartDocs(input: {
  readmeEn: string;
  readmeZh: string;
  commands: PackagedFeishuCommands;
}): string[] {
  const problems: string[] = [];
  checkReadmeFeishuQuickStart({
    label: "README.md",
    markdown: input.readmeEn,
    step4Heading: /^### 4\. Connect Feishu/m,
    feishuSectionHeading: /^## Feishu on mobile and in team groups$/m,
    sourceScopePattern: /linux|source/i,
    cliOnlyDisclosurePattern: /(?:bundled|terminal)?\s*CLI[\s\S]{0,120}(?:no in-app|rather than an in-app|not yet in-app|in-app)/i,
    commands: input.commands,
    problems,
  });
  checkReadmeFeishuQuickStart({
    label: "README.zh-CN.md",
    markdown: input.readmeZh,
    step4Heading: /^### 4\. 接入飞书/m,
    feishuSectionHeading: /^## 飞书入口$/m,
    sourceScopePattern: /linux|源码/i,
    cliOnlyDisclosurePattern: /(?:内置命令行|命令行)[\s\S]{0,60}(?:暂未提供应用内|暂无应用内|非应用内|没有应用内)/,
    commands: input.commands,
    problems,
  });
  return problems;
}

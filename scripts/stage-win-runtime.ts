// 组装 Windows 原生桌面版（NSIS 安装包与便携 `--self-test` 目录共用）的随包运行时目录：
//   <outDir>/
//     node/node.exe           （官方 Node 24 LTS >= 24.21，经 SHA-256 严格校验）
//     bin/fusa-run.exe        （Rust 原生 Job Object + 写受限令牌 + ACL 辅助程序）
//     bin/hub.exe             （Rust 原生命名管道 CLI 启动器）
//     daemon/                 （后端 TS 源码、migrations、contract.json、dist/web 及干净平铺 node_modules）
//     runtime-manifest.json   （供 fusa-supervisor 启动前核对 SHA-256 完整性）
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  BUNDLED_NODE_ARCHIVES,
  BUNDLED_NODE_VERSION,
  REPO_ROOT,
  assertFileSha256,
  computeDirectoryBytes,
  downloadVerifiedArchive,
  pruneStagedNodeModules,
  readDesktopAppVersion,
  sha256FileHex,
  stageDaemonTree,
} from "./stage-runtime-common.ts";

// 两个平台共用的部分在 stage-runtime-common.ts；这里重导出，既有调用方与测试不变。
export {
  BUNDLED_NODE_VERSION,
  buildStagedDaemonPackageJson,
  collectDaemonRuntimeDependencyNames,
  computeDirectoryBytes,
  pruneStagedNodeModules,
  sha256FileHex,
} from "./stage-runtime-common.ts";

const WIN_NODE = BUNDLED_NODE_ARCHIVES["win32-x64"];
export const BUNDLED_NODE_WIN_X64_ZIP_URL = WIN_NODE.url;
export const BUNDLED_NODE_WIN_X64_ZIP_SHA256 = WIN_NODE.archiveSha256;
export const BUNDLED_NODE_WIN_X64_EXE_SHA256 = WIN_NODE.exeSha256;

/**
 * 从已解压校验的官方 Node Windows 压缩包目录中提取 `npm.cmd`、`npx.cmd` 与 `node_modules/npm/` 到随包 `node/` 目录，
 * 并剥离文档、man 手册、类型声明、source map 与任何软链，支持裸机 Windows 免管理员安装 CLI 包与运行 `npx mcp-remote`。
 */
export function stageBundledNpmFromExtractedNodeDir(
  extractedNodeRoot: string,
  nodeOutDir: string,
  targetOs: "win32" | "host" = "win32",
): void {
  mkdirSync(nodeOutDir, { recursive: true });
  for (const shim of ["npm.cmd", "npx.cmd"]) {
    const srcShim = join(extractedNodeRoot, shim);
    if (existsSync(srcShim)) {
      copyFileSync(srcShim, join(nodeOutDir, shim));
    }
  }
  const srcNpmDir = join(extractedNodeRoot, "node_modules", "npm");
  if (existsSync(srcNpmDir)) {
    const dstNodeModules = join(nodeOutDir, "node_modules");
    mkdirSync(dstNodeModules, { recursive: true });
    cpSync(srcNpmDir, join(dstNodeModules, "npm"), { recursive: true, dereference: true });
    pruneStagedNodeModules(dstNodeModules, targetOs);
  }
}

export function assertNoSymlinksInTree(rootDir: string): void {
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir)) {
      const full = join(dir, ent);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new Error(`NSIS runtime tree must not contain symlink/junction: ${full}`);
      }
      if (st.isDirectory()) walk(full);
    }
  };
  walk(rootDir);
}

async function downloadAndVerifyOfficialWinNode(
  destNodeExe: string,
  targetOs: "win32" | "host",
): Promise<void> {
  const cacheDir = join(REPO_ROOT, "apps", "windows", "target", "node-cache");
  mkdirSync(cacheDir, { recursive: true });
  const zipPath = join(cacheDir, `node-${BUNDLED_NODE_VERSION}-win-x64.zip`);

  await downloadVerifiedArchive(WIN_NODE.url, WIN_NODE.archiveSha256, zipPath, "stage-win-runtime");

  const extractDir = join(cacheDir, "extracted");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  if (process.platform === "win32") {
    execFileSync(
      "tar.exe",
      [
        "-xf",
        zipPath,
        "-C",
        extractDir,
        `node-${BUNDLED_NODE_VERSION}-win-x64/node.exe`,
        `node-${BUNDLED_NODE_VERSION}-win-x64/npm.cmd`,
        `node-${BUNDLED_NODE_VERSION}-win-x64/npx.cmd`,
        `node-${BUNDLED_NODE_VERSION}-win-x64/node_modules/npm`,
      ],
      { stdio: "inherit" },
    );
  } else {
    execFileSync(
      "unzip",
      [
        "-q",
        zipPath,
        `node-${BUNDLED_NODE_VERSION}-win-x64/node.exe`,
        `node-${BUNDLED_NODE_VERSION}-win-x64/npm.cmd`,
        `node-${BUNDLED_NODE_VERSION}-win-x64/npx.cmd`,
        `node-${BUNDLED_NODE_VERSION}-win-x64/node_modules/npm/*`,
        "-d",
        extractDir,
      ],
      { stdio: "inherit" },
    );
  }

  const extractedRoot = join(extractDir, `node-${BUNDLED_NODE_VERSION}-win-x64`);
  const extractedExe = join(extractedRoot, "node.exe");
  assertFileSha256(extractedExe, WIN_NODE.exeSha256, "Extracted node.exe");
  const nodeOutDir = dirname(destNodeExe);
  mkdirSync(nodeOutDir, { recursive: true });
  copyFileSync(extractedExe, destNodeExe);
  stageBundledNpmFromExtractedNodeDir(extractedRoot, nodeOutDir, targetOs);
  rmSync(extractDir, { recursive: true, force: true });
}

export interface StageWinRuntimeOptions {
  repoRoot?: string;
  outDir: string;
  helpersDir: string;
  nodeExePath?: string;
  targetOs?: "win32" | "host";
  skipNodeModulesInstall?: boolean;
}

export async function stageWinRuntime(opts: StageWinRuntimeOptions): Promise<{
  outDir: string;
  manifestPath: string;
  totalBytes: number;
}> {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const targetOs = opts.targetOs ?? "win32";
  const outDir = resolve(opts.outDir);
  const helpersDir = resolve(opts.helpersDir);

  if (!existsSync(join(repoRoot, "dist", "web", "index.html"))) {
    throw new Error(`Missing built frontend at ${join(repoRoot, "dist", "web")}/index.html (run 'pnpm build' first)`);
  }

  rmSync(outDir, { recursive: true, force: true });
  const nodeOutDir = join(outDir, "node");
  const binOutDir = join(outDir, "bin");
  const daemonOutDir = join(outDir, "daemon");
  mkdirSync(nodeOutDir, { recursive: true });
  mkdirSync(binOutDir, { recursive: true });
  mkdirSync(daemonOutDir, { recursive: true });

  // 1. 准备随包 node.exe（或本机 smoke 测试指定的 node）
  const nodeFileName =
    opts.nodeExePath && !opts.nodeExePath.toLowerCase().endsWith(".exe") && targetOs === "host"
      ? basename(opts.nodeExePath)
      : "node.exe";
  const stagedNodeExe = join(nodeOutDir, nodeFileName);
  let nodeVersion = BUNDLED_NODE_VERSION;
  if (opts.nodeExePath) {
    const resolvedSrcNode = resolve(opts.nodeExePath);
    copyFileSync(resolvedSrcNode, stagedNodeExe);
    stageBundledNpmFromExtractedNodeDir(dirname(resolvedSrcNode), nodeOutDir, targetOs);
    if (targetOs === "host") {
      nodeVersion = process.version;
    }
  } else {
    await downloadAndVerifyOfficialWinNode(stagedNodeExe, targetOs);
  }

  // 2. 拷贝 fusa-win-helper 产物（fusa-run.exe、hub.exe）
  const resolveHelperSrc = (stem: string): { src: string; dstName: string } => {
    const exeCand = join(helpersDir, `${stem}.exe`);
    if (existsSync(exeCand)) {
      return { src: exeCand, dstName: `${stem}.exe` };
    }
    const plainCand = join(helpersDir, stem);
    if (existsSync(plainCand)) {
      return { src: plainCand, dstName: targetOs === "host" ? stem : `${stem}.exe` };
    }
    throw new Error(`Helper binary ${stem}(.exe) not found in ${helpersDir}`);
  };
  const fusaRunHelper = resolveHelperSrc("fusa-run");
  const hubHelper = resolveHelperSrc("hub");
  const stagedFusaRun = join(binOutDir, fusaRunHelper.dstName);
  const stagedHub = join(binOutDir, hubHelper.dstName);
  copyFileSync(fusaRunHelper.src, stagedFusaRun);
  copyFileSync(hubHelper.src, stagedHub);

  // 3. 守护进程源码、迁移 SQL、桌面契约、前端静态资源与平铺生产依赖（与 macOS 共用 stageDaemonTree）
  stageDaemonTree({
    repoRoot,
    daemonOutDir,
    targetOs,
    ...(opts.skipNodeModulesInstall ? { skipNodeModulesInstall: true } : {}),
  });

  assertNoSymlinksInTree(outDir);

  // 4. 生成 SHA-256 完整性清单
  const appVersion = readDesktopAppVersion(repoRoot);
  const manifest = {
    version: appVersion,
    nodeVersion,
    nodeSha256: sha256FileHex(stagedNodeExe),
    fusaRunSha256: sha256FileHex(stagedFusaRun),
    hubSha256: sha256FileHex(stagedHub),
  };
  const manifestPath = join(outDir, "runtime-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const totalBytes = computeDirectoryBytes(outDir);
  const totalMiB = (totalBytes / (1024 * 1024)).toFixed(2);
  console.log(
    `[stage-win-runtime] Staged runtime at ${outDir}: ${totalBytes} bytes (${totalMiB} MiB uncompressed)`,
  );
  return { outDir, manifestPath, totalBytes };
}

function realOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

if (
  process.argv[1] &&
  realOrSelf(fileURLToPath(import.meta.url)).replace(/\\/g, "/").toLowerCase() ===
    realOrSelf(process.argv[1]).replace(/\\/g, "/").toLowerCase()
) {
  const { values } = parseArgs({
    options: {
      "out-dir": { type: "string" },
      "helpers-dir": { type: "string" },
      "node-exe": { type: "string" },
      "target-os": { type: "string" },
    },
    strict: true,
  });
  const outDir =
    values["out-dir"] ?? join(REPO_ROOT, "apps", "windows", "crates", "fusa-desktop", "staged-runtime");
  const helpersDir = values["helpers-dir"] ?? join(REPO_ROOT, "apps", "windows", "target", "release");
  const targetOs = values["target-os"] === "host" ? "host" : "win32";

  stageWinRuntime({
    outDir,
    helpersDir,
    nodeExePath: values["node-exe"],
    targetOs,
  }).catch((err) => {
    console.error(`[stage-win-runtime] ERROR:`, err);
    process.exitCode = 1;
  });
}

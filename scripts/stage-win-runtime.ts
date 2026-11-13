// 组装 Windows 原生桌面版（NSIS 安装包与便携 `--self-test` 目录共用）的随包运行时目录：
//   <outDir>/
//     node/node.exe           （官方 Node 24 LTS >= 24.21，经 SHA-256 严格校验）
//     bin/fusa-run.exe        （Rust 原生 Job Object + 写受限令牌 + ACL 辅助程序）
//     bin/hub.exe             （Rust 原生命名管道 CLI 启动器）
//     daemon/                 （后端 TS 源码、migrations、contract.json、dist/web 及干净平铺 node_modules）
//     runtime-manifest.json   （供 fusa-supervisor 启动前核对 SHA-256 完整性）
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveSpawn } from "../src/daemon/platform/win32/spawn-resolution.ts";
import { findExecutable } from "../src/shared/paths.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 锁定的官方 Node 24 LTS（Krypton，>= 24.21.0 以支持 @microsoft/mxc-sdk Windows 原生句柄流）及 nodejs.org SHASUMS256.txt 校验值。 */
export const BUNDLED_NODE_VERSION = "v24.22.3";
export const BUNDLED_NODE_WIN_X64_ZIP_URL = `https://nodejs.org/dist/${BUNDLED_NODE_VERSION}/node-${BUNDLED_NODE_VERSION}-win-x64.zip`;
export const BUNDLED_NODE_WIN_X64_ZIP_SHA256 =
  "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f";
export const BUNDLED_NODE_WIN_X64_EXE_SHA256 =
  "86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6";

const DAEMON_SOURCE_SUBDIRS = ["daemon", "shared", "vendors", "hub", "tunnel"] as const;

const MXC_WIN_X64_KEEP_FILES = new Set([
  "mxc_ffi.dll",
  "wxc-exec.exe",
  "wxc-host-prep.exe",
  "plm.exe",
  "winhttp-proxy-shim.exe",
]);

export function sha256FileHex(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

/** 扫描后端与共享源码（排除 src/web、测试与测试夹具）实际引用的全部第三方包名，防止打包遗漏或混入巨型前端库。 */
export function collectDaemonRuntimeDependencyNames(repoRoot: string = REPO_ROOT): string[] {
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const declaredDeps = rootPkg.dependencies ?? {};
  const used = new Set<string>(["@microsoft/mxc-sdk"]);

  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "fixtures" || ent.name === "__snapshots__") continue;
        walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(".ts") && !ent.name.endsWith(".tsx")) continue;
      if (ent.name.endsWith(".test.ts") || ent.name.endsWith(".test.tsx") || ent.name === "test-helpers.ts") {
        continue;
      }
      const text = readFileSync(full, "utf8");
      for (const match of text.matchAll(/(?:from|import|esmRequire)\s*\(?["']([^."'\s][^"']*)["']/g)) {
        const spec = match[1]!;
        if (spec.startsWith("node:")) continue;
        const pkgName = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0]!;
        if (pkgName in declaredDeps) {
          used.add(pkgName);
        }
      }
    }
  };

  for (const sub of DAEMON_SOURCE_SUBDIRS) {
    const dir = join(repoRoot, "src", sub);
    if (existsSync(dir)) walk(dir);
  }

  return [...used].sort();
}

export function buildStagedDaemonPackageJson(repoRoot: string = REPO_ROOT): {
  name: string;
  version: string;
  private: true;
  type: "module";
  dependencies: Record<string, string>;
} {
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    version?: string;
    dependencies?: Record<string, string>;
  };
  const allDeps = rootPkg.dependencies ?? {};
  const needed = collectDaemonRuntimeDependencyNames(repoRoot);
  const dependencies: Record<string, string> = {};
  for (const name of needed) {
    const ver = allDeps[name];
    if (!ver) {
      throw new Error(`Daemon runtime dependency ${name} missing from root package.json`);
    }
    dependencies[name] = ver;
  }
  return {
    name: "fusa-daemon-runtime",
    version: rootPkg.version ?? "0.1.0",
    private: true,
    type: "module",
    dependencies,
  };
}

function copyFilteredSourceTree(srcDir: string, dstDir: string): void {
  mkdirSync(dstDir, { recursive: true });
  for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, ent.name);
    const dstPath = join(dstDir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "fixtures" || ent.name === "__snapshots__") continue;
      copyFilteredSourceTree(srcPath, dstPath);
      continue;
    }
    if (!ent.isFile()) continue;
    if (
      ent.name.endsWith(".test.ts") ||
      ent.name.endsWith(".test.tsx") ||
      ent.name === "test-helpers.ts"
    ) {
      continue;
    }
    copyFileSync(srcPath, dstPath);
  }
}

export function pruneStagedNodeModules(
  nodeModulesDir: string,
  targetOs: "win32" | "host" = "win32",
): void {
  if (!existsSync(nodeModulesDir)) return;

  // 1. 裁剪 @microsoft/mxc-sdk 中非目标平台的二进制（如 46MB arm64、Linux lxc-exec、WSLC/Sandbox VM 守护进程）
  const mxcBinDir = join(nodeModulesDir, "@microsoft", "mxc-sdk", "bin");
  if (targetOs === "win32" && existsSync(mxcBinDir)) {
    rmSync(join(mxcBinDir, "arm64"), { recursive: true, force: true });
    const x64Dir = join(mxcBinDir, "x64");
    if (existsSync(x64Dir)) {
      for (const ent of readdirSync(x64Dir)) {
        if (!MXC_WIN_X64_KEEP_FILES.has(ent)) {
          rmSync(join(x64Dir, ent), { recursive: true, force: true });
        }
      }
    }
  }

  // 2. 裁剪 koffi 文档与 C/C++ 编译期源码（必须保留 `koffi/src/koffi/src/static.{js,cjs}` 等运行时加载入口！）
  //    以及未使用的非目标平台 `@koromix/koffi-*` 预编译二进制与 node-pty 源码
  for (const extraDir of [
    join(nodeModulesDir, "npm", "docs"),
    join(nodeModulesDir, "npm", "man"),
    join(nodeModulesDir, "npm", "tap-snapshots"),
    join(nodeModulesDir, "npm", "changelogs"),
    join(nodeModulesDir, "koffi", "doc"),
    join(nodeModulesDir, "koffi", "vendor"),
    join(nodeModulesDir, "koffi", "src", "koffi", "src", "abi"),
    join(nodeModulesDir, "node-pty", "deps"),
    join(nodeModulesDir, "node-pty", "src"),
    join(nodeModulesDir, "node-pty", "prebuilds"),
    join(nodeModulesDir, ".bin"),
    join(nodeModulesDir, ".modules.yaml"),
  ]) {
    rmSync(extraDir, { recursive: true, force: true });
  }
  const koffiSrcDir = join(nodeModulesDir, "koffi", "src", "koffi", "src");
  if (existsSync(koffiSrcDir)) {
    for (const ent of readdirSync(koffiSrcDir)) {
      if (/\.(?:cc|hh|inc|def)$/i.test(ent)) {
        rmSync(join(koffiSrcDir, ent), { force: true });
      }
    }
  }
  const koromixDir = join(nodeModulesDir, "@koromix");
  if (targetOs === "win32" && existsSync(koromixDir)) {
    for (const ent of readdirSync(koromixDir)) {
      if (ent.startsWith("koffi-") && ent !== "koffi-win32-x64") {
        rmSync(join(koromixDir, ent), { recursive: true, force: true });
      }
    }
  }

  // 3. 移除类型声明、source map 与多余文档，且移除任何残留软链以保证 NSIS 100% 兼容
  const cleanWalk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      const lst = lstatSync(full);
      if (lst.isSymbolicLink()) {
        rmSync(full, { recursive: true, force: true });
        continue;
      }
      if (lst.isDirectory()) {
        cleanWalk(full);
        continue;
      }
      const lower = ent.name.toLowerCase();
      if (
        lower.endsWith(".d.ts") ||
        lower.endsWith(".d.mts") ||
        lower.endsWith(".d.cts") ||
        lower.endsWith(".map") ||
        lower === "changelog.md"
      ) {
        rmSync(full, { force: true });
      }
    }
  };
  cleanWalk(nodeModulesDir);
}

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

export function computeDirectoryBytes(rootDir: string): number {
  let total = 0;
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir)) {
      const full = join(dir, ent);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else total += st.size;
    }
  };
  if (existsSync(rootDir)) walk(rootDir);
  return total;
}

async function downloadAndVerifyOfficialWinNode(
  destNodeExe: string,
  targetOs: "win32" | "host",
): Promise<void> {
  const cacheDir = join(REPO_ROOT, "apps", "windows", "target", "node-cache");
  mkdirSync(cacheDir, { recursive: true });
  const zipPath = join(cacheDir, `node-${BUNDLED_NODE_VERSION}-win-x64.zip`);

  if (!existsSync(zipPath) || sha256FileHex(zipPath) !== BUNDLED_NODE_WIN_X64_ZIP_SHA256) {
    console.log(`[stage-win-runtime] Downloading ${BUNDLED_NODE_WIN_X64_ZIP_URL} ...`);
    const res = await fetch(BUNDLED_NODE_WIN_X64_ZIP_URL);
    if (!res.ok) {
      throw new Error(`Failed to download Node zip: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(zipPath, buf);
    const zipSha = sha256FileHex(zipPath);
    if (zipSha !== BUNDLED_NODE_WIN_X64_ZIP_SHA256) {
      rmSync(zipPath, { force: true });
      throw new Error(
        `Node zip SHA-256 mismatch: expected ${BUNDLED_NODE_WIN_X64_ZIP_SHA256}, got ${zipSha}`,
      );
    }
  }

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
  const exeSha = sha256FileHex(extractedExe);
  if (exeSha !== BUNDLED_NODE_WIN_X64_EXE_SHA256) {
    throw new Error(
      `Extracted node.exe SHA-256 mismatch: expected ${BUNDLED_NODE_WIN_X64_EXE_SHA256}, got ${exeSha}`,
    );
  }
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

  const distWebDir = join(repoRoot, "dist", "web");
  if (!existsSync(join(distWebDir, "index.html"))) {
    throw new Error(`Missing built frontend at ${distWebDir}/index.html (run 'pnpm build' first)`);
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

  // 3. 拷贝守护进程源码、迁移 SQL、桌面契约与打包好的前端静态资源
  for (const sub of DAEMON_SOURCE_SUBDIRS) {
    copyFilteredSourceTree(join(repoRoot, "src", sub), join(daemonOutDir, "src", sub));
  }
  cpSync(join(repoRoot, "migrations"), join(daemonOutDir, "migrations"), { recursive: true });
  cpSync(distWebDir, join(daemonOutDir, "dist", "web"), { recursive: true });
  mkdirSync(join(daemonOutDir, "apps", "desktop"), { recursive: true });
  copyFileSync(
    join(repoRoot, "apps", "desktop", "contract.json"),
    join(daemonOutDir, "apps", "desktop", "contract.json"),
  );
  copyFileSync(join(repoRoot, "tsconfig.json"), join(daemonOutDir, "tsconfig.json"));

  const stagedPkg = buildStagedDaemonPackageJson(repoRoot);
  writeFileSync(
    join(daemonOutDir, "package.json"),
    `${JSON.stringify(stagedPkg, null, 2)}\n`,
    "utf8",
  );

  // 4. 安装平铺（hoisted、无软链、无生命周期脚本）生产期后端依赖并裁剪跨平台冗余文件
  if (!opts.skipNodeModulesInstall) {
    const pnpmArgs = [
      "install",
      "--prod",
      "--no-lockfile",
      "--ignore-scripts",
      "--prefer-offline",
      "--config.node-linker=hoisted",
      "--config.package-import-method=copy",
    ];
    const pnpmBin =
      process.platform === "win32"
        ? (findExecutable("pnpm", process.env.PATH ?? process.env.Path, [], {
            platform: "win32",
            pathExt: process.env.PATHEXT ?? process.env.Pathext,
          }) ?? "pnpm.cmd")
        : "pnpm";
    const resolvedPnpm =
      process.platform === "win32"
        ? resolveSpawn({ program: pnpmBin, args: pnpmArgs, cwd: daemonOutDir, env: process.env }, "win32")
        : { file: "pnpm", args: pnpmArgs, options: { cwd: daemonOutDir, env: process.env } };
    const installRes = spawnSync(
      resolvedPnpm.file,
      resolvedPnpm.args,
      {
        ...resolvedPnpm.options,
        cwd: daemonOutDir,
        stdio: "inherit",
        shell: false,
      },
    );
    if (installRes.error || installRes.status !== 0) {
      const errDetail = installRes.error ? ` (${installRes.error.message})` : "";
      throw new Error(`pnpm hoisted install failed with exit code ${installRes.status}${errDetail}`);
    }
    rmSync(join(daemonOutDir, "pnpm-lock.yaml"), { force: true });
    pruneStagedNodeModules(join(daemonOutDir, "node_modules"), targetOs);
  }

  assertNoSymlinksInTree(outDir);

  // 5. 生成 SHA-256 完整性清单
  const cargoToml = readFileSync(join(repoRoot, "apps", "windows", "Cargo.toml"), "utf8");
  const appVersion = /version\s*=\s*"([^"]+)"/.exec(cargoToml)?.[1] ?? "0.1.0";
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

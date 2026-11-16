// Windows 与 macOS 分发包共用的随包运行时组装逻辑（docs/mac-distribution-design.md「统一」一节）：
//   - 锁定的官方 Node 版本与按平台的下载地址、SHA-256（单一来源）；
//   - 守护进程目录 daemon/：后端 TS 源码、migrations、contract.json、dist/web、精简 package.json 与平铺生产依赖；
//   - 生产依赖按目标平台裁剪；下载按 SHA-256 严格校验。
// 平台专属部分（Windows 的 fusa-run.exe/hub.exe 与 npm.cmd，macOS 的 node/bin + lib/node_modules/npm 布局）
// 分别在 stage-win-runtime.ts、stage-mac-runtime.ts。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSpawn } from "../src/daemon/platform/win32/spawn-resolution.ts";
import { findExecutable } from "../src/shared/paths.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 锁定的官方 Node 24 LTS（Krypton，>= 24.21.0 以支持 @microsoft/mxc-sdk Windows 原生句柄流）。两个平台随包同一版本。 */
export const BUNDLED_NODE_VERSION = "v24.22.3";

/** 各目标平台的官方 Node 压缩包（nodejs.org/dist/<版本>/SHASUMS256.txt）与解压后可执行文件的 SHA-256。 */
export const BUNDLED_NODE_ARCHIVES = {
  "win32-x64": {
    url: `https://nodejs.org/dist/${BUNDLED_NODE_VERSION}/node-${BUNDLED_NODE_VERSION}-win-x64.zip`,
    rootDir: `node-${BUNDLED_NODE_VERSION}-win-x64`,
    archiveSha256: "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f",
    /** node.exe */
    exeSha256: "86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6",
  },
  "darwin-arm64": {
    url: `https://nodejs.org/dist/${BUNDLED_NODE_VERSION}/node-${BUNDLED_NODE_VERSION}-darwin-arm64.tar.gz`,
    rootDir: `node-${BUNDLED_NODE_VERSION}-darwin-arm64`,
    archiveSha256: "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd",
    /** bin/node（官方 Developer ID 签名原样；打包签名前校验） */
    exeSha256: "ba7073582822078d8c90bca3facacc46690bc5366fab4b815aeef9148cd6e854",
  },
} as const;

export type BundledNodeTarget = keyof typeof BUNDLED_NODE_ARCHIVES;

/** 裁剪随包 node_modules 的目标：两个分发平台，或本机冒烟（不裁平台二进制）。 */
export type StageTargetOs = "win32" | "darwin-arm64" | "host";

const DAEMON_SOURCE_SUBDIRS = ["daemon", "shared", "vendors", "hub", "tunnel"] as const;

const MXC_WIN_X64_KEEP_FILES = new Set([
  "mxc_ffi.dll",
  "wxc-exec.exe",
  "wxc-host-prep.exe",
  "plm.exe",
  "winhttp-proxy-shim.exe",
]);

/** 每个目标平台要保留的 koffi 预编译包（@koromix/koffi-<平台>）。 */
const KOFFI_KEEP_PACKAGE: Record<Exclude<StageTargetOs, "host">, string> = {
  win32: "koffi-win32-x64",
  "darwin-arm64": "koffi-darwin-arm64",
};

export function sha256FileHex(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

/** 分发包版本号的单一来源：apps/windows/Cargo.toml 的 workspace 版本（Windows NSIS 与 Mac DMG 同号）。 */
export function readDesktopAppVersion(repoRoot: string = REPO_ROOT): string {
  const cargoToml = readFileSync(join(repoRoot, "apps", "windows", "Cargo.toml"), "utf8");
  return /version\s*=\s*"([^"]+)"/.exec(cargoToml)?.[1] ?? "0.1.0";
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
      for (const match of text.matchAll(/(?:from|import|esmRequire|import\.meta\.resolve)\s*\(?["']([^."'\s][^"']*)["']/g)) {
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

export function pruneStagedNodeModules(nodeModulesDir: string, targetOs: StageTargetOs = "win32"): void {
  if (!existsSync(nodeModulesDir)) return;

  // 1. 裁剪 @microsoft/mxc-sdk 中非目标平台的二进制（如 46MB arm64、Linux lxc-exec、WSLC/Sandbox VM 守护进程）；
  //    macOS 上 mxc-sdk 只是被 import 的纯 JS（只读容器只在 Windows 用），二进制整个不要
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
  } else if (targetOs === "darwin-arm64") {
    rmSync(mxcBinDir, { recursive: true, force: true });
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
    // tree-sitter-bash 只用它的 wasm（shared/shell-syntax.ts），C 源码和原生预编译不要
    join(nodeModulesDir, "tree-sitter-bash", "src"),
    join(nodeModulesDir, "tree-sitter-bash", "prebuilds"),
    join(nodeModulesDir, "tree-sitter-bash", "bindings"),
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
  if (targetOs !== "host" && existsSync(koromixDir)) {
    const keep = KOFFI_KEEP_PACKAGE[targetOs];
    for (const ent of readdirSync(koromixDir)) {
      if (ent.startsWith("koffi-") && ent !== keep) {
        rmSync(join(koromixDir, ent), { recursive: true, force: true });
      }
    }
  }

  // 3. 移除类型声明、source map 与多余文档，且移除任何残留软链（NSIS 不支持软链；macOS 包里也不该有指向包外的链接）
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

export function computeDirectoryBytes(rootDir: string): number {
  let total = 0;
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir)) {
      const full = join(dir, ent);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else total += statSync(full).size;
    }
  };
  if (existsSync(rootDir)) walk(rootDir);
  return total;
}

/** 下载（或复用缓存）官方压缩包并严格校验 SHA-256；校验不过删掉缓存再报错。 */
export async function downloadVerifiedArchive(
  url: string,
  expectedSha256: string,
  cachePath: string,
  logPrefix: string,
): Promise<void> {
  mkdirSync(dirname(cachePath), { recursive: true });
  if (existsSync(cachePath) && sha256FileHex(cachePath) === expectedSha256) return;
  console.log(`[${logPrefix}] Downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  writeFileSync(cachePath, Buffer.from(await res.arrayBuffer()));
  const sha = sha256FileHex(cachePath);
  if (sha !== expectedSha256) {
    rmSync(cachePath, { force: true });
    throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${sha}`);
  }
}

/** 解压出的官方 Node 可执行文件必须与锁定的 SHA-256 一致。 */
export function assertFileSha256(filePath: string, expectedSha256: string, label: string): void {
  const sha = sha256FileHex(filePath);
  if (sha !== expectedSha256) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expectedSha256}, got ${sha}`);
  }
}

export interface StageDaemonTreeOptions {
  repoRoot?: string;
  /** <runtime>/daemon */
  daemonOutDir: string;
  targetOs: StageTargetOs;
  skipNodeModulesInstall?: boolean;
}

/**
 * 组装 daemon/：守护进程源码、迁移 SQL、桌面契约、打包好的前端静态资源、精简 package.json，
 * 再装平铺（hoisted、无软链、无生命周期脚本）生产期后端依赖并按目标平台裁剪。
 */
export function stageDaemonTree(opts: StageDaemonTreeOptions): void {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const { daemonOutDir, targetOs } = opts;
  const distWebDir = join(repoRoot, "dist", "web");
  if (!existsSync(join(distWebDir, "index.html"))) {
    throw new Error(`Missing built frontend at ${distWebDir}/index.html (run 'pnpm build' first)`);
  }
  mkdirSync(daemonOutDir, { recursive: true });

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
  writeFileSync(join(daemonOutDir, "package.json"), `${JSON.stringify(stagedPkg, null, 2)}\n`, "utf8");

  if (opts.skipNodeModulesInstall) return;
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
  const installRes = spawnSync(resolvedPnpm.file, resolvedPnpm.args, {
    ...resolvedPnpm.options,
    cwd: daemonOutDir,
    stdio: "inherit",
    shell: false,
  });
  if (installRes.error || installRes.status !== 0) {
    const errDetail = installRes.error ? ` (${installRes.error.message})` : "";
    throw new Error(`pnpm hoisted install failed with exit code ${installRes.status}${errDetail}`);
  }
  rmSync(join(daemonOutDir, "pnpm-lock.yaml"), { force: true });
  pruneStagedNodeModules(join(daemonOutDir, "node_modules"), targetOs);
}

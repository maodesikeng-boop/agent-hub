// 组装 macOS 分发版 Fusa.app 的随包运行时目录（放进 Fusa.app/Contents/Resources/runtime，见 docs/mac-distribution-design.md）：
//   <outDir>/
//     node/bin/node                 （官方 Node 24 LTS darwin-arm64，与 Windows 随包同一版本，经 SHA-256 严格校验）
//     node/bin/npm、node/bin/npx    （官方压缩包里的相对软链，指向 ../lib/node_modules/npm/bin/*-cli.js）
//     node/lib/node_modules/npm/    （供 Providers 一键安装 CLI 与 agent 跑 npx）
//     daemon/                       （与 Windows 共用 stageDaemonTree：后端 TS 源码、migrations、contract.json、dist/web、平铺生产依赖）
//     runtime-manifest.json         （版本、Node 版本与官方 node 的 SHA-256；包的完整性由 codesign 封签保证）
// 签名、Info.plist 和 DMG 在 scripts/build-mac-app.sh --dist。
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
  stageDaemonTree,
} from "./stage-runtime-common.ts";

const MAC_NODE = BUNDLED_NODE_ARCHIVES["darwin-arm64"];

/** 官方压缩包里 bin/ 下要保留的 npm 入口软链（corepack 不带）。 */
const NPM_BIN_LINKS = {
  npm: "../lib/node_modules/npm/bin/npm-cli.js",
  npx: "../lib/node_modules/npm/bin/npx-cli.js",
} as const;

/**
 * 从已解压校验的官方 Node darwin 压缩包目录拷出 bin/node、npm 与 LICENSE 到 nodeOutDir，保持官方 bin + lib 布局：
 * 守护进程按 `<node 所在目录>/../lib/node_modules/npm/bin/npm-cli.js` 找 npm（provider-manager/recipes.ts）。
 */
export function stageMacNodeFromExtractedDir(extractedNodeRoot: string, nodeOutDir: string): string {
  const binOut = join(nodeOutDir, "bin");
  mkdirSync(binOut, { recursive: true });
  const stagedNode = join(binOut, "node");
  copyFileSync(join(extractedNodeRoot, "bin", "node"), stagedNode);

  const srcNpmDir = join(extractedNodeRoot, "lib", "node_modules", "npm");
  if (!existsSync(join(srcNpmDir, "bin", "npm-cli.js"))) {
    throw new Error(`Official Node archive is missing npm at ${srcNpmDir}`);
  }
  const dstNodeModules = join(nodeOutDir, "lib", "node_modules");
  mkdirSync(dstNodeModules, { recursive: true });
  cpSync(srcNpmDir, join(dstNodeModules, "npm"), { recursive: true, dereference: true });
  pruneStagedNodeModules(dstNodeModules, "darwin-arm64");

  for (const [name, target] of Object.entries(NPM_BIN_LINKS)) {
    rmSync(join(binOut, name), { force: true });
    symlinkSync(target, join(binOut, name));
  }
  const license = join(extractedNodeRoot, "LICENSE");
  if (existsSync(license)) copyFileSync(license, join(nodeOutDir, "LICENSE"));
  return stagedNode;
}

/** 包里的软链只许是指向包内的相对链接（codesign 封签与 DMG 拷贝都要求）。 */
export function assertSymlinksStayInside(rootDir: string): void {
  const root = resolve(rootDir);
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir)) {
      const full = join(dir, ent);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(full);
        const resolved = resolve(dirname(full), target);
        if (target.startsWith("/") || relative(root, resolved).startsWith("..")) {
          throw new Error(`Symlink escapes runtime dir: ${full} -> ${target}`);
        }
        continue;
      }
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
}

async function downloadAndExtractOfficialMacNode(nodeOutDir: string, cacheDir: string): Promise<string> {
  const archivePath = join(cacheDir, `${MAC_NODE.rootDir}.tar.gz`);
  await downloadVerifiedArchive(MAC_NODE.url, MAC_NODE.archiveSha256, archivePath, "stage-mac-runtime");
  const extractDir = join(cacheDir, "extracted-darwin-arm64");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  execFileSync(
    "tar",
    ["-xzf", archivePath, "-C", extractDir, `${MAC_NODE.rootDir}/bin`, `${MAC_NODE.rootDir}/lib/node_modules/npm`, `${MAC_NODE.rootDir}/LICENSE`],
    { stdio: "inherit" },
  );
  const extractedRoot = join(extractDir, MAC_NODE.rootDir);
  assertFileSha256(join(extractedRoot, "bin", "node"), MAC_NODE.exeSha256, "Extracted darwin-arm64 bin/node");
  const staged = stageMacNodeFromExtractedDir(extractedRoot, nodeOutDir);
  rmSync(extractDir, { recursive: true, force: true });
  return staged;
}

export interface StageMacRuntimeOptions {
  repoRoot?: string;
  outDir: string;
  /** 官方压缩包缓存目录，默认 build/node-cache。 */
  cacheDir?: string;
  skipNodeModulesInstall?: boolean;
}

export async function stageMacRuntime(opts: StageMacRuntimeOptions): Promise<{
  outDir: string;
  manifestPath: string;
  totalBytes: number;
}> {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const outDir = resolve(opts.outDir);
  const cacheDir = resolve(opts.cacheDir ?? join(repoRoot, "build", "node-cache"));
  if (!existsSync(join(repoRoot, "dist", "web", "index.html"))) {
    throw new Error(`Missing built frontend at ${join(repoRoot, "dist", "web")}/index.html (run 'pnpm build' first)`);
  }

  rmSync(outDir, { recursive: true, force: true });
  const nodeOutDir = join(outDir, "node");
  const daemonOutDir = join(outDir, "daemon");
  mkdirSync(nodeOutDir, { recursive: true });

  // 1. 官方 Node（压缩包与 bin/node 双重 SHA-256 校验）
  await downloadAndExtractOfficialMacNode(nodeOutDir, cacheDir);

  // 2. 守护进程目录（与 Windows 共用）
  stageDaemonTree({
    repoRoot,
    daemonOutDir,
    targetOs: "darwin-arm64",
    ...(opts.skipNodeModulesInstall ? { skipNodeModulesInstall: true } : {}),
  });

  assertSymlinksStayInside(outDir);

  // 3. 清单：签名后 bin/node 的字节会变，这里记的是官方原件的 SHA-256 供核对来源；包的完整性由 codesign 封签保证
  const manifest = {
    version: readDesktopAppVersion(repoRoot),
    platform: "darwin-arm64",
    nodeVersion: BUNDLED_NODE_VERSION,
    nodeOfficialSha256: MAC_NODE.exeSha256,
  };
  const manifestPath = join(outDir, "runtime-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const totalBytes = computeDirectoryBytes(outDir);
  console.log(
    `[stage-mac-runtime] Staged runtime at ${outDir}: ${totalBytes} bytes (${(totalBytes / (1024 * 1024)).toFixed(2)} MiB uncompressed)`,
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

if (process.argv[1] && realOrSelf(fileURLToPath(import.meta.url)) === realOrSelf(process.argv[1])) {
  const { values } = parseArgs({
    options: {
      "out-dir": { type: "string" },
      "cache-dir": { type: "string" },
    },
    strict: true,
  });
  if (!values["out-dir"]) {
    console.error("Usage: node scripts/stage-mac-runtime.ts --out-dir <Fusa.app/Contents/Resources/runtime> [--cache-dir <dir>]");
    process.exit(2);
  }
  stageMacRuntime({
    outDir: values["out-dir"],
    ...(values["cache-dir"] ? { cacheDir: values["cache-dir"] } : {}),
  }).catch((err) => {
    console.error(`[stage-mac-runtime] ERROR:`, err);
    process.exitCode = 1;
  });
}

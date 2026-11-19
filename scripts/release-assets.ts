// 发版辅助（.github/workflows/release.yml 调用，本机也能跑）：
//   check   —— 校验 git 标签与 app 版本号一致，输出 version / prerelease；
//   prepare —— 把 Windows 与 Mac 的构建产物改成固定文件名并重写 .sha256，供 GitHub Release 挂载。
// 固定文件名让 https://github.com/<repo>/releases/latest/download/<文件名> 永远指向最新正式版。
// 文件名里不写 unsigned-preview：第二期签名公证后链接不用改，“未签名预览”写在发布说明里。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, readDesktopAppVersion, sha256FileHex } from "./stage-runtime-common.ts";

export interface ReleaseAssetSpec {
  platform: "windows" | "macos";
  /** 构建工作流上传的原始文件名（版本号在第 1 个捕获组）。 */
  sourcePattern: RegExp;
  /** 发到 Release 上的固定文件名。 */
  fixedName: string;
}

export const RELEASE_ASSETS: readonly ReleaseAssetSpec[] = [
  {
    platform: "windows",
    sourcePattern: /^Bellwood_(\d+\.\d+\.\d+)_x64-setup-unsigned-preview\.exe$/,
    fixedName: "Bellwood-windows-x64-setup.exe",
  },
  {
    platform: "macos",
    sourcePattern: /^Bellwood_(\d+\.\d+\.\d+)_arm64(?:-unsigned-preview)?\.dmg$/,
    fixedName: "Bellwood-macos-arm64.dmg",
  },
];

const TAG_PATTERN = /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/;

export interface TagCheckResult {
  version: string;
  /** 标签带 -rc.1 之类后缀就是预发布：GitHub 的 releases/latest 不含预发布，不能用于 README 固定链接。 */
  prerelease: boolean;
}

/** 标签 vX.Y.Z[-后缀] 的 X.Y.Z 必须等于 app 版本号（Cargo workspace 版本，Windows NSIS 与 Mac DMG 同号）。 */
export function checkTagVersion(tag: string, appVersion: string): TagCheckResult {
  const match = TAG_PATTERN.exec(tag);
  if (!match) {
    throw new Error(`标签 "${tag}" 不是 vX.Y.Z 或 vX.Y.Z-后缀 的形式`);
  }
  if (match[1] !== appVersion) {
    throw new Error(`标签 ${tag} 与 app 版本号 ${appVersion}（apps/windows/Cargo.toml）不一致：先改版本号再打标签`);
  }
  return { version: appVersion, prerelease: match[2] !== undefined };
}

/** 版本号的另一处副本（Tauri 配置）必须与 Cargo workspace 版本一致，否则 Windows 安装包里的版本元数据会对不上。 */
export function assertTauriVersionMatches(repoRoot: string, appVersion: string): void {
  const tauriConf = JSON.parse(
    readFileSync(join(repoRoot, "apps", "windows", "crates", "fusa-desktop", "tauri.conf.json"), "utf8"),
  ) as { version?: string };
  if (tauriConf.version !== appVersion) {
    throw new Error(`tauri.conf.json 版本 ${tauriConf.version} 与 Cargo.toml 版本 ${appVersion} 不一致`);
  }
}

function findSingleSource(dir: string, spec: ReleaseAssetSpec): { fileName: string; version: string } {
  if (!existsSync(dir)) {
    throw new Error(`${spec.platform} 产物目录不存在：${dir}`);
  }
  const hits = readdirSync(dir).filter((name) => spec.sourcePattern.test(name));
  if (hits.length !== 1) {
    throw new Error(`${spec.platform} 产物目录 ${dir} 里应有且只有 1 个匹配 ${spec.sourcePattern} 的文件，实际 ${hits.length} 个：${hits.join(", ")}`);
  }
  const fileName = hits[0]!;
  return { fileName, version: spec.sourcePattern.exec(fileName)![1]! };
}

/** 复制为固定文件名，核对原 .sha256，再按新文件名重写 .sha256。返回写出的文件名（安装包与校验文件）。 */
export function prepareReleaseAssets(opts: {
  dirs: Record<ReleaseAssetSpec["platform"], string>;
  outDir: string;
  appVersion: string;
}): string[] {
  mkdirSync(opts.outDir, { recursive: true });
  const written: string[] = [];
  for (const spec of RELEASE_ASSETS) {
    const dir = opts.dirs[spec.platform];
    const { fileName, version } = findSingleSource(dir, spec);
    if (version !== opts.appVersion) {
      throw new Error(`${spec.platform} 产物 ${fileName} 的版本 ${version} 与 app 版本号 ${opts.appVersion} 不一致`);
    }
    const sourcePath = join(dir, fileName);
    const actualHash = sha256FileHex(sourcePath);
    const recorded = readFileSync(`${sourcePath}.sha256`, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
    if (recorded !== actualHash) {
      throw new Error(`${fileName} 的 SHA-256 与构建时记录的 .sha256 不一致（记录 ${recorded}，实际 ${actualHash}）`);
    }
    copyFileSync(sourcePath, join(opts.outDir, spec.fixedName));
    writeFileSync(join(opts.outDir, `${spec.fixedName}.sha256`), `${actualHash}  ${spec.fixedName}\n`);
    written.push(spec.fixedName, `${spec.fixedName}.sha256`);
  }
  return written;
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      flags.set(arg.slice(2), argv[i + 1] ?? "");
      i += 1;
    }
  }
  return flags;
}

function setGithubOutput(key: string, value: string): void {
  if (process.env["GITHUB_OUTPUT"]) {
    appendFileSync(process.env["GITHUB_OUTPUT"], `${key}=${value}\n`);
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const appVersion = readDesktopAppVersion();
  assertTauriVersionMatches(REPO_ROOT, appVersion);
  if (command === "check") {
    // 不带 --tag 是试运行：只确认版本号来源一致，不当作正式发布
    const tag = flags.get("tag");
    const result = tag ? checkTagVersion(tag, appVersion) : { version: appVersion, prerelease: false };
    console.log(`version=${result.version} prerelease=${result.prerelease}${tag ? ` tag=${tag}` : " (dry-run, no tag)"}`);
    setGithubOutput("version", result.version);
    setGithubOutput("prerelease", String(result.prerelease));
    return;
  }
  if (command === "prepare") {
    const written = prepareReleaseAssets({
      dirs: { windows: resolve(flags.get("windows-dir") ?? ""), macos: resolve(flags.get("mac-dir") ?? "") },
      outDir: resolve(flags.get("out-dir") ?? ""),
      appVersion,
    });
    console.log(`prepared: ${written.join(", ")}`);
    return;
  }
  throw new Error("用法：release-assets.ts check [--tag vX.Y.Z] | prepare --windows-dir D --mac-dir D --out-dir D");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

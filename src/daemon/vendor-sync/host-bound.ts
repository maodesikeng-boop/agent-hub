// 「别家应用自带的 MCP」识别规则：全仓只定义在这一处，对所有已接入厂商通用（引擎对每家 scanMcp 的结果一视同仁，不看厂商名）。
//
// 这类 MCP 离开自己所在的应用就跑不起来，同步到别家只会多出一个起不来的条目，所以默认不往别家补（用户仍可手动勾选）。
// 判断依据只有一条：命令（command）的路径落在某个应用的安装包里。
//    - macOS：路径里有 `<名字>.app/Contents/`（Apple 的 app bundle 约定，应用私有的可执行文件都放在 Contents 下）。
//    - Windows：在 `%ProgramFiles%\WindowsApps\<包名>\` 下（MSIX/商店应用的包目录归应用所有）；
//      或在 `%LOCALAPPDATA%\Programs`、`%ProgramFiles%`、`%ProgramFiles(x86)%` 的 `<应用目录>\resources\`（含 Squirrel `app-<版本>\resources\`）下，
//      或 `%LOCALAPPDATA%\<应用目录>\app-<版本>\resources\` 下（Electron / Tauri / Squirrel 桌面应用把随包可执行文件放在 `resources\` 下的约定）。
//      只放在应用目录根上的普通运行时（Node、Python 等）或其深层 `node_modules` / `site-packages` 子目录不算。
// 透传环境变量（如 Codex 的 `env_vars`）本身不算：用户自己装的 MCP 也常这样透传 `GITHUB_TOKEN` 之类，算进来会误判。
import { win32 } from "node:path";
import {
  isPathStrictlyInside,
  isWindowsAbsolutePathLike,
  normalizePathForComparison,
  stripExtendedLengthPrefix,
} from "../platform/win32/path-key.ts";
import type { CanonicalMcpServer, VendorSyncContext } from "../../vendors/daemon-types.ts";

export interface HostBoundDetection {
  /** 命令路径所在的应用名（如 `ChatGPT`）；路径里认不出名字时没有。 */
  app?: string;
}

/** 面向界面的英文原因（只写应用名，不带命令路径）。 */
export function hostBoundReason(detection: HostBoundDetection): string {
  return detection.app
    ? `Runs from inside the ${detection.app} app and may not work without it`
    : "Runs from inside an app's install folder and may not work without that app";
}

const MAC_APP_BUNDLE = /(?:^|\/)([^/]+)\.app\/Contents\//i;
const WIN_SQUIRREL_APP_VER = /^app-\d/i;
const WIN_USER_LOCAL_APPDATA = /^([A-Za-z]:\\Users\\[^\\]+\\AppData\\Local)\\/i;

function envValue(env: VendorSyncContext["env"], name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct.trim() || undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower && value?.trim()) return value.trim();
  }
  return undefined;
}

function cleanWindowsPath(rawValue: string): string {
  const stripped = stripExtendedLengthPrefix(rawValue.trim()).replace(/\//g, "\\");
  if (/^[A-Za-z]:\\+$/.test(stripped)) return `${stripped.slice(0, 2)}\\`;
  return stripped.replace(/\\+$/, "");
}

function uniqueWinPaths(candidates: ReadonlyArray<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    if (!raw?.trim()) continue;
    const cleaned = cleanWindowsPath(raw);
    const key = normalizePathForComparison(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function hasDirectAppResourcesSegment(segments: readonly string[]): boolean {
  // <应用目录>\resources\...\<可执行文件>
  if (segments.length >= 3 && segments[1]?.toLowerCase() === "resources") return true;
  // Squirrel.Windows：<应用目录>\app-<版本>\resources\...\<可执行文件>
  if (segments.length >= 4 && WIN_SQUIRREL_APP_VER.test(segments[1] ?? "") && segments[2]?.toLowerCase() === "resources") {
    return true;
  }
  return false;
}

function windowsAppName(command: string, env: VendorSyncContext["env"], userHome?: string): string | null | undefined {
  const programFiles = uniqueWinPaths([
    envValue(env, "ProgramFiles"),
    envValue(env, "ProgramW6432"),
    envValue(env, "ProgramFiles(x86)"),
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ]);
  const inferredUserLocal = WIN_USER_LOCAL_APPDATA.exec(command)?.[1];
  const homeLocal =
    userHome && isWindowsAbsolutePathLike(userHome) ? win32.join(cleanWindowsPath(userHome), "AppData", "Local") : undefined;
  const localAppDataDirs = uniqueWinPaths([envValue(env, "LOCALAPPDATA"), homeLocal, inferredUserLocal]);

  for (const root of programFiles) {
    const packages = win32.join(root, "WindowsApps");
    if (!isPathStrictlyInside(packages, command)) continue;
    const pkg = win32.relative(packages, command).split("\\")[0] ?? "";
    return pkg.split("_")[0]?.trim() || null;
  }

  const installRoots = uniqueWinPaths([...localAppDataDirs.map((dir) => win32.join(dir, "Programs")), ...programFiles]);
  for (const root of installRoots) {
    if (!isPathStrictlyInside(root, command)) continue;
    const segments = win32.relative(root, command).split("\\");
    if (hasDirectAppResourcesSegment(segments)) {
      return segments[0]?.trim() || null;
    }
  }

  // Squirrel.Windows 用户级默认安装目录：%LOCALAPPDATA%\<应用名>\app-<版本>\resources\...
  for (const localRoot of localAppDataDirs) {
    if (!isPathStrictlyInside(localRoot, command)) continue;
    const segments = win32.relative(localRoot, command).split("\\");
    if (segments.length >= 4 && WIN_SQUIRREL_APP_VER.test(segments[1] ?? "") && segments[2]?.toLowerCase() === "resources") {
      return segments[0]?.trim() || null;
    }
  }
  return undefined;
}

/** 命令路径是否在某个应用安装包里：是返回应用名（认不出名字时为 null），不是返回 undefined。 */
function appBundleOf(command: string, env: VendorSyncContext["env"], userHome?: string): string | null | undefined {
  const cmd = command.trim();
  if (cmd === "") return undefined;
  if (isWindowsAbsolutePathLike(cmd)) return windowsAppName(cleanWindowsPath(cmd), env, userHome);
  const mac = MAC_APP_BUNDLE.exec(normalizePathForComparison(cmd));
  return mac ? (mac[1]?.trim() || null) : undefined;
}

export function detectHostBoundMcp(
  server: CanonicalMcpServer,
  env: VendorSyncContext["env"],
  userHome?: string,
): HostBoundDetection | null {
  if (server.transport !== "stdio") return null;
  const app = appBundleOf(server.command, env, userHome);
  if (app === undefined) return null;
  return app ? { app } : {};
}

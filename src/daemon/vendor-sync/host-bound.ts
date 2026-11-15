// 「别家应用自带的 MCP」识别规则：全仓只定义在这一处，对所有已接入厂商通用（引擎对每家 scanMcp 的结果一视同仁，不看厂商名）。
//
// 这类 MCP 离开自己所在的应用就跑不起来，同步到别家只会多出一个起不来的条目，所以默认不往别家补（用户仍可手动勾选）。
// 判断依据（任一成立）：
// 1. 命令（command）的路径在某个应用的安装包里：
//    - macOS：路径里有 `<名字>.app/Contents/`（Apple 的 app bundle 约定，应用私有的可执行文件都放在 Contents 下）。
//    - Windows：在 `%ProgramFiles%\WindowsApps\<包名>\` 下（MSIX/商店应用的包目录归应用所有）；
//      或在 `%LOCALAPPDATA%\Programs`、`%ProgramFiles%`、`%ProgramFiles(x86)%` 的 `<应用目录>\` 下，且路径里有 `resources` 一层
//      （Electron / Tauri 等桌面应用把随包可执行文件放在 `resources\` 下的约定）。只放在应用目录根上的普通运行时（Node、Python 等）不算。
// 2. 配置依赖宿主应用透传的环境变量（Codex 的 `env_vars`）：值不在配置里，要靠宿主进程在启动时带进来，换一家应用启动就取不到。
import { win32 } from "node:path";
import { isPathStrictlyInside, isWindowsAbsolutePathLike, normalizePathForComparison } from "../platform/win32/path-key.ts";
import type { CanonicalMcpServer, VendorSyncContext } from "../../vendors/daemon-types.ts";

export type HostBoundKind = "app_bundle" | "host_env";

export interface HostBoundDetection {
  kinds: readonly HostBoundKind[];
  /** 命令路径所在的应用名（如 `ChatGPT`）；只靠透传环境变量判断时没有。 */
  app?: string;
}

/** 面向界面的英文原因（只写应用名，不带命令路径、环境变量名或取值）。 */
export function hostBoundReason(detection: HostBoundDetection): string {
  const parts: string[] = [];
  if (detection.kinds.includes("app_bundle")) {
    parts.push(
      detection.app
        ? `Runs from inside the ${detection.app} app and won't work without it`
        : "Runs from inside an app's install folder and won't work without that app",
    );
  }
  if (detection.kinds.includes("host_env")) {
    parts.push("Depends on environment variables passed in by its host app");
  }
  return parts.join(". ");
}

const MAC_APP_BUNDLE = /(?:^|\/)([^/]+)\.app\/Contents\//i;

function envValue(env: VendorSyncContext["env"], name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct.trim() || undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower && value?.trim()) return value.trim();
  }
  return undefined;
}

function windowsAppName(command: string, env: VendorSyncContext["env"]): string | null | undefined {
  const programFiles = [envValue(env, "ProgramFiles"), envValue(env, "ProgramW6432"), envValue(env, "ProgramFiles(x86)")].filter(
    (v): v is string => v !== undefined,
  );
  const localPrograms = envValue(env, "LOCALAPPDATA");

  for (const root of programFiles) {
    const packages = win32.join(root, "WindowsApps");
    if (!isPathStrictlyInside(packages, command)) continue;
    const pkg = win32.relative(packages, command).split("\\")[0] ?? "";
    return pkg.split("_")[0] || null;
  }

  const installRoots = [...(localPrograms ? [win32.join(localPrograms, "Programs")] : []), ...programFiles];
  for (const root of installRoots) {
    if (!isPathStrictlyInside(root, command)) continue;
    const segments = win32.relative(root, command).split("\\");
    // <应用目录>\...\resources\...\<可执行文件>
    if (segments.length >= 3 && segments.slice(1, -1).some((s) => s.toLowerCase() === "resources")) {
      return segments[0] || null;
    }
  }
  return undefined;
}

/** 命令路径是否在某个应用安装包里：是返回应用名（认不出名字时为 null），不是返回 undefined。 */
function appBundleOf(command: string, env: VendorSyncContext["env"]): string | null | undefined {
  const cmd = command.trim();
  if (cmd === "") return undefined;
  if (isWindowsAbsolutePathLike(cmd)) return windowsAppName(normalizeWindowsSeparators(cmd), env);
  const mac = MAC_APP_BUNDLE.exec(normalizePathForComparison(cmd));
  return mac ? (mac[1] ?? null) : undefined;
}

function normalizeWindowsSeparators(value: string): string {
  return value.replace(/\//g, "\\");
}

export function detectHostBoundMcp(server: CanonicalMcpServer, env: VendorSyncContext["env"]): HostBoundDetection | null {
  if (server.transport !== "stdio") return null;
  const kinds: HostBoundKind[] = [];
  const app = appBundleOf(server.command, env);
  if (app !== undefined) kinds.push("app_bundle");
  if ((server.hostEnvVars?.length ?? 0) > 0) kinds.push("host_env");
  if (kinds.length === 0) return null;
  return { kinds, ...(app ? { app } : {}) };
}

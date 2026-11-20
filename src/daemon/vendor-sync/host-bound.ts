import { win32 } from "node:path";
import {
  isPathStrictlyInside,
  isWindowsAbsolutePathLike,
  normalizePathForComparison,
  stripExtendedLengthPrefix,
} from "../platform/win32/path-key.ts";
import type { CanonicalMcpServer, VendorSyncContext } from "../../vendors/daemon-types.ts";

export interface HostBoundDetection {
  app?: string;
}

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
  if (segments.length >= 3 && segments[1]?.toLowerCase() === "resources") return true;
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

  for (const localRoot of localAppDataDirs) {
    if (!isPathStrictlyInside(localRoot, command)) continue;
    const segments = win32.relative(localRoot, command).split("\\");
    if (segments.length >= 4 && WIN_SQUIRREL_APP_VER.test(segments[1] ?? "") && segments[2]?.toLowerCase() === "resources") {
      return segments[0]?.trim() || null;
    }
  }
  return undefined;
}

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

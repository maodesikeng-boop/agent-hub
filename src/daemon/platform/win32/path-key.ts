/*
 * MIT License
 * Copyright (c) 2026 Lovecast Inc.
 * Adapted from stablyai/orca commit 6854ab5a (src/shared/cross-platform-path.ts).
 */

import { win32 } from "node:path";

/** Strips `\\?\` or `\\?\UNC\` extended-length prefixes while preserving drive or UNC semantics. */
export function stripExtendedLengthPrefix(rawValue: string): string {
  if (/^\\\\\?\\UNC\\/i.test(rawValue)) {
    return `\\\\${rawValue.slice(8)}`;
  }
  if (/^\\\\\?\\[A-Za-z]:[\\/]/.test(rawValue)) {
    return rawValue.slice(4);
  }
  return rawValue;
}

export function isWindowsAbsolutePathLike(value: string): boolean {
  const stripped = stripExtendedLengthPrefix(value);
  return /^[A-Za-z]:[\\/]/.test(stripped) || stripped.startsWith("\\\\") || stripped.startsWith("//");
}

export function isCrossPlatformAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePathLike(value);
}

/** True when path points to a UNC share (`\\server\share` or `//server/share` or `\\?\UNC\...`), excluding `\\.\pipe\...` and `\\?\C:\...`. */
export function isUncNetworkPath(value: string): boolean {
  if (/^\\\\\.\\/.test(value) || /^\/\/\.\//.test(value)) return false;
  if (/^\\\\\?\\UNC\\/i.test(value)) return true;
  if (/^\\\\\?\\[A-Za-z]:[\\/]/.test(value)) return false;
  return /^\\\\[^\\?][^\\]*\\[^\\]+/.test(value) || /^\/\/[^/?][^/]*\/[^/]+/.test(value);
}

function collapseSlashes(value: string): string {
  return value.includes("//") ? value.replace(/\/+/g, "/") : value;
}

function normalizeSeparators(value: string): string {
  const normalized = collapseSlashes(value.includes("\\") ? value.replace(/\\/g, "/") : value);
  if (value.startsWith("\\\\") || value.startsWith("//")) {
    return `//${normalized.replace(/^\/+/, "")}`;
  }
  return normalized;
}

function trimTrailingSlash(value: string): string {
  if (!value.endsWith("/")) return value;
  if (value === "/" || /^[A-Za-z]:\/$/.test(value)) return value;
  return value.replace(/\/+$/, "");
}

/**
 * Comparison keys ONLY — never pass the returned string to filesystem APIs.
 * - Normalizes Unicode to NFC;
 * - Strips `\\?\` / `\\?\UNC\` extended prefixes;
 * - Folds separators and lowercases ONLY Windows drive/UNC paths;
 * - Preserves case and backslashes on POSIX paths.
 */
export function normalizePathForComparison(rawValue: string): string {
  const stripped = stripExtendedLengthPrefix(rawValue.normalize("NFC"));
  const isWin = isWindowsAbsolutePathLike(stripped);
  const normalized = trimTrailingSlash(
    isWin ? normalizeSeparators(stripped) : collapseSlashes(stripped),
  );
  const wslUnc = /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/[\s\S]*)?$/i.exec(normalized);
  if (wslUnc) {
    return `//wsl/${wslUnc[1]!.toLowerCase()}${wslUnc[2] ?? ""}`;
  }
  return isWin ? normalized.toLowerCase() : normalized;
}

export function isPathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const root = normalizePathForComparison(rootPath);
  const candidate = normalizePathForComparison(candidatePath);
  if (candidate === root) return true;
  const boundary = root === "/" || /^[a-z]:\/$/i.test(root) ? root : `${root}/`;
  return candidate.startsWith(boundary);
}

export function isPathStrictlyInside(rootPath: string, candidatePath: string): boolean {
  const root = normalizePathForComparison(rootPath);
  const candidate = normalizePathForComparison(candidatePath);
  if (candidate === root) return false;
  const boundary = root === "/" || /^[a-z]:\/$/i.test(root) ? root : `${root}/`;
  return candidate.startsWith(boundary);
}

/** Converts a Windows path to `\\?\` extended-length form for deep-tree removal (`rm`). */
export function toWin32NamespacedPath(targetPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? win32.toNamespacedPath(targetPath) : targetPath;
}

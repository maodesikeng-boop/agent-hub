/*
 * MIT License
 * Copyright (c) 2026 Lovecast Inc.
 * Adapted from stablyai/orca commit 6854ab5a (src/packages/process-host/src/windows-cmd-shim-resolution.ts).
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 */

// Resolve only exact known shims with verified targets; otherwise preserve cmd.exe fallback.
import { readFileSync, statSync, type Stats } from "node:fs";
import { win32 } from "node:path";
import { LRUCache } from "lru-cache";
import {
  WIN_CMD_SHIM_CACHE_MAX,
  WIN_CMD_SHIM_MAX_BYTES,
  WIN_EXEC_RESOLVE_CACHE_MAX,
} from "../../../shared/limits.ts";

const DISABLE_FLAG = "AGENT_HUB_DISABLE_CMD_SHIM_RESOLUTION";

// Both dp0 spellings end in a separator; tolerate a redundant trailing one.
const DP0 = String.raw`(?:%~dp0|%dp0%)\\?`;
const DP0_NODE_EXE = `"${DP0}node\\.exe"`;
const dp0Path = (group: string): string => `"${DP0}(?<${group}>[^"\\r\\n]+)"`;

const ECHO_OFF = String.raw`@echo off\n`;
const FIND_DP0 = String.raw`GOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n`;
const NODE_PATH_BLOCK = String.raw`(?:@IF NOT DEFINED NODE_PATH \(\n@SET "NODE_PATH=(?<nodePath>[^"\r\n]*)"\n\) ELSE \(\n@SET "NODE_PATH=(?<nodePathElse>[^"\r\n]*)"\n\)\n)?`;
const PATHEXT_STRIP = String.raw`SET PATHEXT=%PATHEXT:;\.JS;=;%`;

// Modern npm cmd-shim selects the interpreter through %_prog%.
const NPM_PROG_NODE_SHIM = new RegExp(
  String.raw`^${ECHO_OFF}${FIND_DP0}IF EXIST ${DP0_NODE_EXE} \(\nSET "_prog=${DP0}node\.exe"\n\) ELSE \(\nSET "_prog=node"\n${PATHEXT_STRIP}\n\)\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +${dp0Path("script")} +%\*$`,
  "i",
);

// Legacy npm and pnpm repeat the script in both interpreter branches.
const BRANCHED_NODE_SHIM = new RegExp(
  String.raw`^(?:@SETLOCAL\n)?${NODE_PATH_BLOCK}@?IF EXIST ${DP0_NODE_EXE} \(\n${DP0_NODE_EXE} +${dp0Path("script")} +%\*\n\) ELSE \(\n(?:@?SETLOCAL\n)?@?${PATHEXT_STRIP}\nnode +${dp0Path("scriptElse")} +%\*\n\)$`,
  "i",
);

// npm shims for native executables need no interpreter.
const NPM_DIRECT_SHIM = new RegExp(
  String.raw`^${ECHO_OFF}(?:${FIND_DP0})?${dp0Path("target")} +%\*$`,
  "i",
);

// pnpm native-executable shims may omit echo-off.
const PNPM_DIRECT_SHIM = new RegExp(String.raw`^(?:@SETLOCAL\n)?@?${dp0Path("target")} +%\*$`, "i");

// Reject drive-relative paths and alternate streams: isAbsolute alone permits D:evil.js and a.js:zone.
const UNSAFE_SHIM_PATH = /[%^&|<>":\r\n]/;

// Extensionless and batch targets need cmd PATHEXT lookup, so cannot bypass cmd.exe.
const DIRECT_TARGET_EXTENSIONS = [".exe", ".com"];

export type ParsedWindowsCmdShim =
  | { kind: "node"; script: string; nodePathPrefix?: string }
  | { kind: "direct"; target: string };

function isPlainRelativePath(spelled: string): boolean {
  return !UNSAFE_SHIM_PATH.test(spelled) && !win32.isAbsolute(spelled);
}

function canonicalize(contents: string): string {
  return contents
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Returns paths as spelled in the shim, relative to its directory. */
export function parseWindowsCmdShim(contents: string): ParsedWindowsCmdShim | null {
  const canonical = canonicalize(contents);

  const prog = NPM_PROG_NODE_SHIM.exec(canonical)?.groups;
  if (prog?.script) {
    return isPlainRelativePath(prog.script) ? { kind: "node", script: prog.script } : null;
  }

  const branched = BRANCHED_NODE_SHIM.exec(canonical)?.groups;
  if (branched?.script) {
    if (branched.script !== branched.scriptElse || !isPlainRelativePath(branched.script)) {
      return null;
    }
    const nodePath = branched.nodePath;
    if (nodePath === undefined) {
      return { kind: "node", script: branched.script };
    }
    if (nodePath.includes("%") || branched.nodePathElse !== `${nodePath};%NODE_PATH%`) {
      return null;
    }
    return { kind: "node", script: branched.script, nodePathPrefix: nodePath };
  }

  for (const pattern of [NPM_DIRECT_SHIM, PNPM_DIRECT_SHIM]) {
    const target = pattern.exec(canonical)?.groups?.target;
    if (target) {
      return isPlainRelativePath(target) ? { kind: "direct", target } : null;
    }
  }
  return null;
}

type ParseCacheEntry = {
  mtimeMs: number;
  size: number;
  parsed: ParsedWindowsCmdShim | null;
};

const parseCache = new LRUCache<string, ParseCacheEntry>({ max: WIN_CMD_SHIM_CACHE_MAX });
const nodeCache = new LRUCache<string, string>({ max: WIN_EXEC_RESOLVE_CACHE_MAX });

/** Clears `.cmd` shim and node interpreter caches (for unit tests). */
export function resetWindowsCmdShimCacheForTest(): void {
  parseCache.clear();
  nodeCache.clear();
}

function statFile(filePath: string): Stats | null {
  try {
    const stats = statSync(filePath);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

function readParsedShim(
  program: string,
  fsHooks?: { stat?: (p: string) => Stats | null; read?: (p: string) => string },
): ParsedWindowsCmdShim | null {
  const statFn = fsHooks?.stat ?? statFile;
  const stats = statFn(program);
  if (!stats || stats.size > WIN_CMD_SHIM_MAX_BYTES) {
    return null;
  }
  const cached = parseCache.get(program);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.parsed;
  }
  let contents: string;
  try {
    contents = fsHooks?.read ? fsHooks.read(program) : readFileSync(program, "utf8");
  } catch {
    return null;
  }
  const parsed = parseWindowsCmdShim(contents);
  parseCache.set(program, { mtimeMs: stats.mtimeMs, size: stats.size, parsed });
  return parsed;
}

/** Win32 resolves environment names case-insensitively; a JS object does not. */
export function firstEnvKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(env).find((key) => key.toLowerCase() === lower && env[key] !== undefined);
}

// Preserve cmd PATHEXT order: node.com outranks node.exe.
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

function resolveShimNode(
  directory: string,
  env: NodeJS.ProcessEnv,
  statFn: (p: string) => Stats | null,
): string | null {
  const pathKey = firstEnvKey(env, "PATH");
  const pathValue = (pathKey ? env[pathKey] : undefined) ?? "";
  const pathExtKey = firstEnvKey(env, "PATHEXT");
  const pathExtValue = (pathExtKey ? env[pathExtKey] : undefined) || DEFAULT_PATHEXT;
  const key = `${directory}\n${pathValue}\n${pathExtValue}`;
  const cached = nodeCache.get(key);
  if (cached !== undefined) {
    if (statFn(cached)) return cached;
    nodeCache.delete(key);
  }
  const resolved = probeShimNode(directory, pathValue, pathExtValue, statFn);
  if (resolved !== null) {
    nodeCache.set(key, resolved);
  }
  return resolved;
}

function probeShimNode(
  directory: string,
  pathValue: string,
  pathExtValue: string,
  statFn: (p: string) => Stats | null,
): string | null {
  const sibling = win32.join(directory, "node.exe");
  if (statFn(sibling)) {
    return sibling;
  }
  const extensions = pathExtValue
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith("."));
  for (const entry of pathValue.split(";")) {
    const trimmed = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed || !win32.isAbsolute(trimmed)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = win32.join(trimmed, `node${extension}`);
      if (!statFn(candidate)) {
        continue;
      }
      return extension === ".exe" ? candidate : null;
    }
  }
  return null;
}

function withNodePath(env: NodeJS.ProcessEnv, prefix: string): NodeJS.ProcessEnv {
  const key = firstEnvKey(env, "NODE_PATH") ?? "NODE_PATH";
  const existing = env[key];
  return { ...env, [key]: existing ? `${prefix};${existing}` : prefix };
}

export type WindowsCmdShimResolution = {
  program: string;
  prefixArgs: readonly string[];
  env?: NodeJS.ProcessEnv;
};

/** Pass the actual child environment for PATH lookup and NODE_PATH prepending; null keeps cmd.exe. */
export function resolveWindowsCmdShim(
  program: string,
  env: NodeJS.ProcessEnv,
  fsHooks?: { stat?: (p: string) => Stats | null; read?: (p: string) => string },
): WindowsCmdShimResolution | null {
  const disableKey = firstEnvKey(env, DISABLE_FLAG);
  if (disableKey && env[disableKey]) {
    return null;
  }
  if (!win32.isAbsolute(program)) {
    return null;
  }
  const statFn = fsHooks?.stat ?? statFile;
  const parsed = readParsedShim(program, fsHooks);
  if (!parsed) {
    return null;
  }
  const directory = win32.dirname(program);

  if (parsed.kind === "direct") {
    const target = win32.resolve(directory, parsed.target);
    const lower = target.toLowerCase();
    if (!DIRECT_TARGET_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      return null;
    }
    return statFn(target) ? { program: target, prefixArgs: [] } : null;
  }

  const script = win32.resolve(directory, parsed.script);
  if (!statFn(script)) {
    return null;
  }
  const node = resolveShimNode(directory, env, statFn);
  if (!node) {
    return null;
  }
  return {
    program: node,
    prefixArgs: [script],
    ...(parsed.nodePathPrefix ? { env: withNodePath(env, parsed.nodePathPrefix) } : {}),
  };
}

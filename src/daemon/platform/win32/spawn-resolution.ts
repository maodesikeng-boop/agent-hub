/*
 * MIT License
 * Copyright (c) 2026 Lovecast Inc.
 * Adapted from stablyai/orca commit 6854ab5a (src/packages/process-host/src/spawn-resolution.ts).
 */

import type { SpawnOptions as NodeSpawnOptions } from "node:child_process";
import { posix, win32 } from "node:path";
import { firstEnvKey, resolveWindowsCmdShim } from "./windows-cmd-shim-resolution.ts";
import { buildWindowsCmdShimCommandLine, isCmdInterpretedProgram } from "./windows-command-line.ts";

export class WindowsPowerShellScriptUnsupportedError extends Error {
  constructor(program: string) {
    super(`不支持直接启动 PowerShell 脚本（${program}），请改用官方 .exe 或 npm 安装`);
    this.name = "WindowsPowerShellScriptUnsupportedError";
  }
}

export interface ProcessSpawnSpec {
  program: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: NodeSpawnOptions["stdio"];
  detached?: boolean;
  windowsVerbatimArguments?: boolean;
}

export interface ResolvedSpawn {
  file: string;
  args: string[];
  options: NodeSpawnOptions;
  /** Set when falling back to cmd.exe with a pre-escaped command tail (`fusa-run --raw-tail`). */
  rawCmdTail?: string;
}

export function isPowerShellScriptProgram(program: string): boolean {
  return program.toLowerCase().endsWith(".ps1");
}

function resolveComSpec(env: NodeJS.ProcessEnv): string {
  const key = firstEnvKey(env, "ComSpec");
  const fromEnv = key ? env[key] : undefined;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv;
  const sysRootKey = firstEnvKey(env, "SystemRoot");
  const sysRoot = (sysRootKey ? env[sysRootKey] : undefined) || "C:\\Windows";
  return win32.join(sysRoot, "System32", "cmd.exe");
}

/**
 * Host-independent spawn resolution:
 * - Always sets `shell: false` (never spawns through implicit shell);
 * - Always sets `windowsHide: true`;
 * - Rejects `.ps1` scripts explicitly;
 * - Resolves known npm/pnpm `.cmd` shims directly to `node.exe + script` or native `.exe`;
 * - Falls back to `%ComSpec% /d /v:off /s /c "..."` with `windowsVerbatimArguments: true` and CR/LF rejection.
 */
export function resolveSpawn(
  spec: ProcessSpawnSpec,
  platform: NodeJS.Platform = process.platform,
): ResolvedSpawn {
  const args = [...(spec.args ?? [])];
  const baseEnv = spec.env ?? process.env;
  const base: NodeSpawnOptions = {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio ?? ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: spec.detached,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    shell: false,
  };

  if (platform !== "win32") {
    return { file: spec.program, args, options: base };
  }

  if (isPowerShellScriptProgram(spec.program)) {
    throw new WindowsPowerShellScriptUnsupportedError(spec.program);
  }

  if (!isCmdInterpretedProgram(spec.program)) {
    return { file: spec.program, args, options: base };
  }

  const shim = resolveWindowsCmdShim(spec.program, baseEnv);
  if (shim) {
    return {
      file: shim.program,
      args: [...shim.prefixArgs, ...args],
      options: {
        ...base,
        ...(shim.env ? { env: shim.env } : {}),
        windowsVerbatimArguments: undefined,
      },
    };
  }

  const comSpec = resolveComSpec(baseEnv);
  const rawCmdTail = buildWindowsCmdShimCommandLine(spec.program, args);
  return {
    file: comSpec,
    args: [rawCmdTail],
    options: { ...base, windowsVerbatimArguments: true },
    rawCmdTail,
  };
}

/**
 * Prepends `prependDir` (e.g. `run/bin` for `hub`) onto `PATH` using the target platform's delimiter,
 * deduplicating case-variant `Path`/`PATH` keys on Windows so child processes never see two PATH entries.
 */
export function mergePathPrependedEnv(
  env: Record<string, string | undefined>,
  prependDir: string,
  basePath?: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  let existingKey = "PATH";
  let existingVal: string | undefined;

  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (platform === "win32" && k.toLowerCase() === "path") {
      if (existingVal === undefined) {
        existingKey = k;
        existingVal = v;
      }
      continue;
    }
    out[k] = v;
  }

  const sep = platform === "win32" ? win32.delimiter : posix.delimiter;
  const tail = basePath !== undefined ? basePath : (existingVal ?? "");
  const targetKey = platform === "win32" ? existingKey : "PATH";
  out[targetKey] = tail === "" ? prependDir : `${prependDir}${sep}${tail}`;
  return out;
}

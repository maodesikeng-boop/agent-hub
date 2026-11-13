import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Generates the exact modern npm `cmd-shim` batch file content (`%_prog%` format)
 * recognized by `parseWindowsCmdShim` / `resolveWindowsCmdShim`.
 */
export function buildNpmNodeCmdShim(relativeScriptFile: string): string {
  return [
    "@echo off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeScriptFile}" %*`,
    "",
  ].join("\r\n");
}

/**
 * Writes a cross-platform executable Node test script:
 * - POSIX (`darwin` / `linux`): writes `#!<node>` shebang + `chmod 0o755` at `basePath`;
 * - Windows (`win32`): writes `${basePath}.${ext}` + standard npm `${basePath}.cmd` shim so every test
 *   exercises `.cmd` shim resolution without `cmd.exe`!
 */
export function writeExecutableNodeScript(
  basePath: string,
  jsSource: string,
  options?: { cjs?: boolean; platform?: NodeJS.Platform },
): string {
  const platform = options?.platform ?? process.platform;
  mkdirSync(dirname(basePath), { recursive: true });
  const body = jsSource.replace(/^#![^\r\n]*\r?\n/, "");
  if (platform !== "win32") {
    writeFileSync(basePath, `#!${process.execPath}\n${body}`, { encoding: "utf8", mode: 0o755 });
    chmodSync(basePath, 0o755);
    return basePath;
  }
  const useCjs = options?.cjs ?? /\brequire\s*\(/.test(body);
  const scriptExt = useCjs ? ".cjs" : ".mjs";
  const scriptName = `${basename(basePath)}-entry${scriptExt}`;
  const scriptPath = join(dirname(basePath), scriptName);
  const cmdPath = basePath.toLowerCase().endsWith(".cmd") ? basePath : `${basePath}.cmd`;
  writeFileSync(scriptPath, body, "utf8");
  writeFileSync(cmdPath, buildNpmNodeCmdShim(scriptName), "utf8");
  return cmdPath;
}

/**
 * Wraps an existing `.ts` / `.js` CLI fixture (such as `fake-claude.ts` or `fake-acp-agent.ts`)
 * in a standard npm `.cmd` shim inside `shimDir` on Windows; returns `scriptPath` unchanged on POSIX.
 */
export function wrapScriptAsPlatformCli(
  scriptPath: string,
  shimDir: string,
  shimName: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return scriptPath;
  mkdirSync(shimDir, { recursive: true });
  const entryName = `${shimName}-entry.mjs`;
  const entryPath = join(shimDir, entryName);
  const cmdPath = join(shimDir, `${shimName}.cmd`);
  const fileUrl = pathToFileURL(scriptPath).href;
  writeFileSync(entryPath, `await import(${JSON.stringify(fileUrl)});\n`, "utf8");
  writeFileSync(cmdPath, buildNpmNodeCmdShim(entryName), "utf8");
  return cmdPath;
}

// 白名单安装/更新配方受管执行器（docs/providers-install-login-design.md 第 3.2、5.1、8.1.1 节）：
// - 严禁接收任何前端传入的 shell 命令字符串，仅执行 `src/vendors/<id>/setup.ts` 声明的结构化白名单配方；
// - npm 安装直接用 `node` + `npm-cli.js`（`shell: false`）装入 `<hubHome>/tools/npm` 免管理员受管目录；
// - 官方安装脚本强制校验 `https://`，子进程挂进程组 / Windows Job Object 支持随时取消与超时整树回收。
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { PROVIDER_INSTALL_TIMEOUT_MS } from "../../shared/index.ts";
import { findExecutable } from "../../shared/paths.ts";
import type {
  VendorInstallRecipe,
  VendorNpmInstallRecipe,
  VendorUpdateRecipe,
} from "../../vendors/daemon-types.ts";
import { killThenSettle } from "../driver/model-catalog.ts";
import { termGroupAfterExit } from "../driver/process.ts";
import { buildChildEnv } from "../driver/protocol.ts";
import { spawnOwnedProcess } from "../platform/index.ts";
import { trackChild } from "../process-ledger.ts";
import type { BoundedJobLogBuffer } from "./redact.ts";

const MAX_INSTALL_SCRIPT_BYTES = 4 * 1024 * 1024;
const SAFE_HTTPS_URL_RE = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+$/u;

export function assertSafeHttpsScriptUrl(scriptUrl: string): URL {
  if (!SAFE_HTTPS_URL_RE.test(scriptUrl) || scriptUrl.includes("'")) {
    throw new Error("Installer script URL rejected by security policy");
  }
  const parsed = new URL(scriptUrl);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new Error("Installer script URL must use HTTPS without credentials");
  }
  return parsed;
}

/** 定位当前 Node 运行时附带（或 PATH 中存在）的 `npm-cli.js` 入口脚本路径。 */
export function resolveNpmCliJsPath(options?: {
  execPath?: string;
  envPath?: string;
  platform?: string;
}): string | null {
  const execPath = options?.execPath ?? process.execPath;
  const platform = options?.platform ?? process.platform;
  const nodeDir = dirname(execPath);

  const directCandidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(nodeDir, "..", "libexec", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const cand of directCandidates) {
    if (existsSync(cand)) return cand;
  }

  const foundNpm = findExecutable("npm", options?.envPath, [], { platform });
  if (foundNpm && (foundNpm.includes("/") || foundNpm.includes("\\"))) {
    try {
      const real = existsSync(foundNpm) ? realpathSync(foundNpm) : foundNpm;
      if (/\.(?:c?m?js)$/iu.test(real) && existsSync(real)) return real;
      const pathMod = platform === "win32" || real.includes("\\") ? win32 : posix;
      const sibling = pathMod.join(pathMod.dirname(real), "node_modules", "npm", "bin", "npm-cli.js");
      if (existsSync(sibling)) return sibling;
    } catch {
      // ignore symlink resolution errors
    }
  }
  return null;
}

export function buildWindowsPowerShellArgs(scriptUrl: string): string[] {
  assertSafeHttpsScriptUrl(scriptUrl);
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; & ([scriptblock]::Create((Invoke-RestMethod -UseBasicParsing -Uri '${scriptUrl}')))`,
  ];
}

function resolveWindowsPowerShellBinary(env: Record<string, string | undefined>): string {
  const sysRoot = env.SystemRoot?.trim() || env.SYSTEMROOT?.trim() || "C:\\Windows";
  const full = win32.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(full) ? full : "powershell.exe";
}

function prependNodeToPath(
  env: Record<string, string | undefined>,
  execPath: string,
  toolsNpmBinDir: string,
  platform: string,
): Record<string, string> {
  const sep = platform === "win32" ? win32.delimiter : posix.delimiter;
  const nodeDir = dirname(execPath);
  const existing = (platform === "win32" ? (env.PATH ?? env.Path) : env.PATH) ?? "";
  const combined = [nodeDir, toolsNpmBinDir, existing].filter(Boolean).join(sep);
  return buildChildEnv(env, {
    PATH: combined,
    TERM: "dumb",
    NO_COLOR: "1",
  });
}

async function downloadHttpsScriptBounded(scriptUrl: string, signal: AbortSignal): Promise<string> {
  assertSafeHttpsScriptUrl(scriptUrl);
  let res: Response;
  try {
    res = await fetch(scriptUrl, { redirect: "follow", signal });
  } catch (err) {
    if (signal.aborted) throw new Error("cancelled");
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Download failed: ${msg}`);
  }
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  const finalUrl = res.url ? new URL(res.url) : null;
  if (finalUrl && finalUrl.protocol !== "https:") {
    await res.body.cancel().catch(() => undefined);
    throw new Error("Installer redirect to non-HTTPS origin rejected");
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INSTALL_SCRIPT_BYTES) {
        throw new Error("Installer script exceeds maximum allowed size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function runLoggedOwnedProcess(options: {
  program: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  logBuffer: BoundedJobLogBuffer;
  purpose: string;
  signal: AbortSignal;
}): Promise<void> {
  const { program, args, cwd, env, logBuffer, purpose, signal } = options;
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(new Error("cancelled"));
      return;
    }
    let spawned: { child: ChildProcessWithoutNullStreams; detached: boolean };
    try {
      spawned = spawnOwnedProcess(program, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      rejectPromise(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const { child, detached } = spawned;
    trackChild(child, purpose, { detached });
    child.once("exit", () => termGroupAfterExit(child));
    child.stdin.on("error", () => {});
    child.stdin.end();

    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      logBuffer.flush();
      if (err) {
        if (child.exitCode === null && child.signalCode === null) {
          killThenSettle(child, () => rejectPromise(err));
        } else {
          rejectPromise(err);
        }
        return;
      }
      resolvePromise();
    };

    const onAbort = () => finish(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });

    child.once("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => logBuffer.append(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => logBuffer.append(chunk));
    child.once("close", (code, sig) => {
      if (code === 0) {
        finish(null);
        return;
      }
      const detail = logBuffer.lastNonEmptyLine() ?? (sig ? `signal ${sig}` : `exit code ${code}`);
      finish(new Error(detail));
    });
  });
}

export interface RecipeExecutionContext {
  platform: string;
  userHome: string;
  toolsNpmDir: string;
  toolsNpmBinDir: string;
  execPath: string;
  env: Record<string, string | undefined>;
  logBuffer: BoundedJobLogBuffer;
  signal: AbortSignal;
  purpose: string;
}

async function executeNpmRecipe(
  recipe: VendorNpmInstallRecipe,
  ctx: RecipeExecutionContext,
): Promise<void> {
  ctx.logBuffer.setStageProgress("Installing package…");
  mkdirSync(ctx.toolsNpmDir, { recursive: true });
  const envPath = ctx.platform === "win32" ? (ctx.env.PATH ?? ctx.env.Path) : ctx.env.PATH;
  const npmCliJs = resolveNpmCliJsPath({
    execPath: ctx.execPath,
    envPath,
    platform: ctx.platform,
  });
  if (!npmCliJs) {
    throw new Error("Bundled npm runtime was not found alongside Node.js");
  }
  const npmArgs = [
    npmCliJs,
    "install",
    "-g",
    "--prefix",
    ctx.toolsNpmDir,
    "--no-fund",
    "--no-audit",
    "--loglevel",
    "error",
    ...(recipe.extraArgs ?? []),
    recipe.packageSpec,
  ];
  const childEnv = prependNodeToPath(ctx.env, ctx.execPath, ctx.toolsNpmBinDir, ctx.platform);
  await runLoggedOwnedProcess({
    program: ctx.execPath,
    args: npmArgs,
    cwd: ctx.userHome,
    env: childEnv,
    logBuffer: ctx.logBuffer,
    purpose: ctx.purpose,
    signal: ctx.signal,
  });
}

export async function executeInstallRecipe(
  recipe: VendorInstallRecipe,
  ctx: RecipeExecutionContext,
): Promise<void> {
  if (recipe.kind === "npm") {
    await executeNpmRecipe(recipe, ctx);
    return;
  }

  if (recipe.kind === "posix_script") {
    ctx.logBuffer.setStageProgress("Downloading installer…");
    try {
      const scriptBody = await downloadHttpsScriptBounded(recipe.scriptUrl, ctx.signal);
      const tmpDir = mkdtempSync(join(tmpdir(), "fusa-installer-"));
      chmodSync(tmpDir, 0o700);
      const scriptFile = join(tmpDir, "install.sh");
      writeFileSync(scriptFile, scriptBody, { mode: 0o700 });
      try {
        ctx.logBuffer.setStageProgress("Running installer…");
        const baseChildEnv = prependNodeToPath(ctx.env, ctx.execPath, ctx.toolsNpmBinDir, ctx.platform);
        const finalEnv = recipe.env ? { ...baseChildEnv, ...recipe.env } : baseChildEnv;
        await runLoggedOwnedProcess({
          program: recipe.shell,
          args: [scriptFile, ...(recipe.args ?? [])],
          cwd: ctx.userHome,
          env: finalEnv,
          logBuffer: ctx.logBuffer,
          purpose: ctx.purpose,
          signal: ctx.signal,
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
      return;
    } catch (err) {
      if (ctx.signal.aborted || !recipe.fallback) throw err;
      ctx.logBuffer.setStageProgress("Falling back to managed package install…");
      await executeNpmRecipe(recipe.fallback, ctx);
      return;
    }
  }

  // powershell_script
  ctx.logBuffer.setStageProgress("Running installer…");
  const psBin = resolveWindowsPowerShellBinary(ctx.env);
  const psArgs = [...buildWindowsPowerShellArgs(recipe.scriptUrl), ...(recipe.args ?? [])];
  const baseChildEnv = prependNodeToPath(ctx.env, ctx.execPath, ctx.toolsNpmBinDir, ctx.platform);
  const finalEnv = recipe.env ? { ...baseChildEnv, ...recipe.env } : baseChildEnv;
  try {
    await runLoggedOwnedProcess({
      program: psBin,
      args: psArgs,
      cwd: ctx.userHome,
      env: finalEnv,
      logBuffer: ctx.logBuffer,
      purpose: ctx.purpose,
      signal: ctx.signal,
    });
  } catch (err) {
    if (ctx.signal.aborted || !recipe.fallback) throw err;
    ctx.logBuffer.setStageProgress("Falling back to managed package install…");
    await executeNpmRecipe(recipe.fallback, ctx);
  }
}

export async function executeUpdateRecipe(
  updateRecipe: VendorUpdateRecipe,
  installRecipe: VendorInstallRecipe,
  binaryPath: string,
  ctx: RecipeExecutionContext,
): Promise<void> {
  if (
    updateRecipe.kind === "reinstall" ||
    (updateRecipe.canUse && !updateRecipe.canUse(binaryPath, ctx.platform))
  ) {
    await executeInstallRecipe(installRecipe, ctx);
    return;
  }

  ctx.logBuffer.setStageProgress("Updating CLI…");
  const childEnv = prependNodeToPath(ctx.env, ctx.execPath, ctx.toolsNpmBinDir, ctx.platform);
  try {
    await runLoggedOwnedProcess({
      program: binaryPath,
      args: updateRecipe.args,
      cwd: ctx.userHome,
      env: childEnv,
      logBuffer: ctx.logBuffer,
      purpose: ctx.purpose,
      signal: ctx.signal,
    });
  } catch (err) {
    if (ctx.signal.aborted || !updateRecipe.fallbackToReinstall) throw err;
    ctx.logBuffer.setStageProgress("Re-running official installer…");
    await executeInstallRecipe(installRecipe, ctx);
  }
}

export async function executeWindowsGitInstall(ctx: RecipeExecutionContext): Promise<void> {
  ctx.logBuffer.setStageProgress("Installing Git via WinGet…");
  const childEnv = prependNodeToPath(ctx.env, ctx.execPath, ctx.toolsNpmBinDir, ctx.platform);
  await runLoggedOwnedProcess({
    program: "winget",
    args: [
      "install",
      "--id",
      "Git.Git",
      "-e",
      "--source",
      "winget",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ],
    cwd: ctx.userHome,
    env: childEnv,
    logBuffer: ctx.logBuffer,
    purpose: "provider:install:git",
    signal: ctx.signal,
  });
}

export function withInstallTimeoutSignal(parentSignal: AbortSignal, timeoutMs: number = PROVIDER_INSTALL_TIMEOUT_MS): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);
  timer.unref();
  return {
    signal: AbortSignal.any([parentSignal, timeoutController.signal]),
    didTimeout: () => timedOut && !parentSignal.aborted,
    cleanup: () => clearTimeout(timer),
  };
}

// 各家 setup.ts 共用的有界文件读取与短命令受管执行辅助（零单家厂商硬编码）。
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { killThenSettle } from "../../../daemon/driver/model-catalog.ts";
import { termGroupAfterExit } from "../../../daemon/driver/process.ts";
import { buildChildEnv } from "../../../daemon/driver/protocol.ts";
import { spawnOwnedProcess, writeFileAtomicSyncWithRetry } from "../../../daemon/platform/index.ts";
import { trackChild } from "../../../daemon/process-ledger.ts";
import { PROVIDER_SECRETS_FILE_MAX_BYTES } from "../../../shared/index.ts";

const SHORT_OUTPUT_MAX_CHARS = 32 * 1024;

/** 在字节上限内非阻塞安全读取普通 UTF-8 文件；缺失、非常规文件或超限一律返回 null。 */
export function readBoundedTextFile(
  filePath: string,
  maxBytes: number = PROVIDER_SECRETS_FILE_MAX_BYTES,
): string | null {
  let fd: number | null = null;
  try {
    const flags = constants.O_RDONLY | (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);
    fd = openSync(filePath, flags);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    if (st.size === 0) return "";
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const bytesRead = readSync(fd, buf, offset, st.size - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return buf.subarray(0, offset).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

/** 在有界体积内读取 JSON 对象文件；解析失败或非普通对象返回 null。 */
export function readBoundedJsonObject(
  filePath: string,
  maxBytes: number = PROVIDER_SECRETS_FILE_MAX_BYTES,
): Record<string, unknown> | null {
  const raw = readBoundedTextFile(filePath, maxBytes);
  if (raw === null || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 以 0600 权限原子写入敏感凭据或配置文件（POSIX 下确保已有文件也收敛为 0600）。 */
export function writePrivateFileAtomic(
  filePath: string,
  content: string,
  platform: string = process.platform,
): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileAtomicSyncWithRetry(filePath, content, { mode: 0o600, fsync: true });
  if (platform !== "win32" && existsSync(filePath)) {
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // ignore chmod failures on exotic filesystems
    }
  }
}

export interface ShortSubcommandOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  signal?: AbortSignal;
  stdinText?: string;
  purpose?: string;
}

/** 受管运行短生命周期 CLI 子命令（如 logout、api-key 写入），挂进程组 / Windows Job Object，超时或取消整树回收。 */
export function runShortSubcommand(
  program: string,
  args: readonly string[],
  options: ShortSubcommandOptions,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { cwd, timeoutMs, signal, stdinText, purpose = "provider:subcommand" } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    let spawned: { child: ChildProcessWithoutNullStreams; detached: boolean };
    try {
      spawned = spawnOwnedProcess(program, args, {
        cwd,
        env: buildChildEnv(options.env ?? process.env, undefined),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const { child, detached } = spawned;
    trackChild(child, purpose, { detached });
    child.once("exit", () => termGroupAfterExit(child));

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (err: Error | null, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) {
        if (child.exitCode === null && child.signalCode === null) {
          killThenSettle(child, () => reject(err));
        } else {
          reject(err);
        }
        return;
      }
      resolve({ code, stdout, stderr });
    };

    const onAbort = () => finish(new Error("cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs);

    child.once("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    child.stdin.on("error", () => {});
    if (stdinText !== undefined) {
      child.stdin.end(stdinText);
    } else {
      child.stdin.end();
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < SHORT_OUTPUT_MAX_CHARS) {
        stdout += chunk.slice(0, SHORT_OUTPUT_MAX_CHARS - stdout.length);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < SHORT_OUTPUT_MAX_CHARS) {
        stderr += chunk.slice(0, SHORT_OUTPUT_MAX_CHARS - stderr.length);
      }
    });
    child.once("close", (code) => finish(null, code));
  });
}

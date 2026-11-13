// 通用受管 CLI 登录子进程运行器：
// 封装 spawnOwnedProcess + trackChild + killThenSettle + BROWSER 拦截 + stdout/stderr 链接与设备码实时提取 + stdin 授权码投递。
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { killThenSettle } from "../../../daemon/driver/model-catalog.ts";
import { termGroupAfterExit } from "../../../daemon/driver/process.ts";
import { buildChildEnv } from "../../../daemon/driver/protocol.ts";
import { spawnOwnedProcess } from "../../../daemon/platform/index.ts";
import { trackChild } from "../../../daemon/process-ledger.ts";
import type { AuthFlowHooks } from "../../daemon-types.ts";
import {
  createBrowserCaptureSession,
  extractAuthorizeUrlFromOutput,
  extractDeviceCodeFromOutput,
  stripAnsi,
} from "./browser-capture.ts";

const AUTH_OUTPUT_TAIL_MAX_CHARS = 16 * 1024;

export interface SpawnCliAuthFlowOptions {
  program: string;
  args: readonly string[];
  cwd: string;
  baseEnv: Record<string, string | undefined>;
  extraEnv?: Readonly<Record<string, string>>;
  platform: string;
  purpose: string;
  hooks: AuthFlowHooks;
  signal: AbortSignal;
  /** 是否注入 Node TTY 垫片（供要求 isTTY === true 的 Node CLI 使用）。 */
  fakeNodeTty?: boolean;
  /** 是否优先按 Device Code 提取。 */
  expectDeviceCode?: boolean;
  /** 是否拦截系统 open / xdg-open 命令。默认 true。 */
  interceptSystemOpeners?: boolean;
}

export async function runCliAuthFlowProcess(options: SpawnCliAuthFlowOptions): Promise<void> {
  const {
    program,
    args,
    cwd,
    baseEnv,
    extraEnv,
    platform,
    purpose,
    hooks,
    signal,
    fakeNodeTty = false,
    expectDeviceCode = false,
    interceptSystemOpeners = true,
  } = options;

  if (signal.aborted) {
    throw new Error("cancelled");
  }

  let notifiedUrl = false;
  let notifiedDevice = false;

  const emitUrl = (url: string) => {
    if (notifiedUrl || notifiedDevice) return;
    notifiedUrl = true;
    hooks.onAuthorizeUrl(url);
  };

  const capture = createBrowserCaptureSession({
    platform,
    onUrl: (url) => {
      if (!expectDeviceCode) emitUrl(url);
    },
  });

  try {
    const mergedBase = buildChildEnv(baseEnv, extraEnv ? { ...extraEnv } : undefined);
    const childEnv = capture.applyEnv(mergedBase, {
      interceptSystemOpeners,
      fakeNodeTty,
    });

    await new Promise<void>((resolve, reject) => {
      let spawned: { child: ChildProcessWithoutNullStreams; detached: boolean };
      try {
        spawned = spawnOwnedProcess(program, args, {
          cwd,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const { child, detached } = spawned;
      trackChild(child, purpose, { detached });
      child.once("exit", () => termGroupAfterExit(child));
      child.stdin.on("error", () => {});

      hooks.onUserInput((input) => {
        if (child.exitCode === null && child.signalCode === null && !child.stdin.destroyed) {
          child.stdin.write(`${input.trim()}\n`);
        }
      });

      let combinedTail = "";
      let settled = false;

      const inspectCombinedOutput = () => {
        capture.pollOnce();
        const device = extractDeviceCodeFromOutput(combinedTail);
        if (device && !notifiedDevice) {
          notifiedDevice = true;
          hooks.onDeviceCode(device);
          return;
        }
        if (!expectDeviceCode && !notifiedUrl && !notifiedDevice) {
          const url = extractAuthorizeUrlFromOutput(combinedTail);
          if (url) emitUrl(url);
        }
      };

      const appendOutput = (chunk: string) => {
        combinedTail = (combinedTail + chunk).slice(-AUTH_OUTPUT_TAIL_MAX_CHARS);
        inspectCombinedOutput();
      };

      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (err) {
          if (child.exitCode === null && child.signalCode === null) {
            killThenSettle(child, () => reject(err));
          } else {
            reject(err);
          }
          return;
        }
        resolve();
      };

      const onAbort = () => finish(new Error("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });

      child.once("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", appendOutput);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", appendOutput);

      child.once("close", (code, sig) => {
        capture.pollOnce();
        if (code === 0) {
          finish(null);
          return;
        }
        const cleanLines = stripAnsi(combinedTail)
          .split(/\r?\n/u)
          .map((l) => l.trim())
          .filter((l) => l !== "" && !l.startsWith("Open this URL") && !l.startsWith("http"));
        const lastReason = cleanLines.at(-1) ?? (sig ? `signal ${sig}` : `exit code ${code}`);
        finish(new Error(`Sign-in failed (${lastReason})`));
      });
    });
  } finally {
    capture.dispose();
  }
}

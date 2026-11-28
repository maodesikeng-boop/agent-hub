import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { killChildAndWait, termGroupAfterExit } from "../../../daemon/driver/process.ts";
import { buildChildEnv } from "../../../daemon/driver/protocol.ts";
import { spawnOwnedProcess } from "../../../daemon/platform/index.ts";
import { trackChild } from "../../../daemon/process-ledger.ts";
import type { AuthFlowHooks } from "../../daemon-types.ts";
import {
  createBrowserCaptureSession,
  extractAuthorizeUrlFromOutput,
  extractDeviceCodeFromOutput,
  stripAnsi,
  type BrowserCaptureSession,
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
  fakeNodeTty?: boolean;
  expectDeviceCode?: boolean;
  interceptSystemOpeners?: boolean;
}

interface AuthOutputWatcher {
  emitUrl(url: string): void;
  inspect(combinedTail: string): void;
}

function createAuthOutputWatcher(hooks: AuthFlowHooks, expectDeviceCode: boolean): AuthOutputWatcher {
  let notifiedUrl = false;
  let notifiedDevice = false;
  const emitUrl = (url: string) => {
    if (notifiedUrl || notifiedDevice) return;
    notifiedUrl = true;
    hooks.onAuthorizeUrl(url);
  };
  return {
    emitUrl,
    inspect(combinedTail) {
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
    },
  };
}

function authFailureReason(combinedTail: string, code: number | null, sig: NodeJS.Signals | null): string {
  const cleanLines = stripAnsi(combinedTail)
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("Open this URL") && !l.startsWith("http"));
  return cleanLines.at(-1) ?? (sig ? `signal ${sig}` : `exit code ${code}`);
}

function driveCliAuthProcess(
  options: SpawnCliAuthFlowOptions,
  childEnv: Record<string, string>,
  capture: BrowserCaptureSession,
  watcher: AuthOutputWatcher,
): Promise<void> {
  const { program, args, cwd, purpose, hooks, signal } = options;
  return new Promise<void>((resolve, reject) => {
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

    const appendOutput = (chunk: string) => {
      combinedTail = (combinedTail + chunk).slice(-AUTH_OUTPUT_TAIL_MAX_CHARS);
      capture.pollOnce();
      watcher.inspect(combinedTail);
    };

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (err) {
        if (child.exitCode === null && child.signalCode === null) {
          void killChildAndWait(child).finally(() => reject(err));
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
      finish(new Error(`Sign-in failed (${authFailureReason(combinedTail, code, sig)})`));
    });
  });
}

export async function runCliAuthFlowProcess(options: SpawnCliAuthFlowOptions): Promise<void> {
  const {
    baseEnv,
    extraEnv,
    platform,
    hooks,
    signal,
    fakeNodeTty = false,
    expectDeviceCode = false,
    interceptSystemOpeners = true,
  } = options;

  if (signal.aborted) {
    throw new Error("cancelled");
  }

  const watcher = createAuthOutputWatcher(hooks, expectDeviceCode);
  const capture = createBrowserCaptureSession({
    platform,
    onUrl: (url) => {
      if (!expectDeviceCode) watcher.emitUrl(url);
    },
  });

  try {
    const mergedBase = buildChildEnv(baseEnv, extraEnv ? { ...extraEnv } : undefined);
    const childEnv = capture.applyEnv(mergedBase, {
      interceptSystemOpeners,
      fakeNodeTty,
    });
    await driveCliAuthProcess(options, childEnv, capture, watcher);
  } finally {
    capture.dispose();
  }
}

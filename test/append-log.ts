import { readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";

export function readCompleteLogLines(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const lines = text.split("\n");
  // A live append may leave the last record visible before its newline.
  lines.pop();
  return lines.filter(Boolean);
}

export function readJsonLog<T>(file: string): T[] {
  return readCompleteLogLines(file).map((line): T => JSON.parse(line));
}

export interface WaitForJsonLogOptions<T> {
  file: string;
  match: (entry: T) => boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  label?: string;
}

function abortReason(signal: AbortSignal, label?: string): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (typeof signal.reason === "string" && signal.reason !== "") return new Error(signal.reason);
  return new Error(`Aborted while waiting for log event${label ? `: ${label}` : ""}`);
}

/**
 * Waits for a complete JSONL record matching `match` to appear in `file` using filesystem watch events.
 * Postcondition: resolves with the first matching entry immediately when already present or upon append;
 * rejects promptly when `signal` aborts or `timeoutMs` elapses, and closes all watchers and timers before settling.
 */
export function waitForJsonLogEvent<T>(options: WaitForJsonLogOptions<T>): Promise<T> {
  const { file, match, timeoutMs = 5_000, signal, label } = options;
  if (signal?.aborted) return Promise.reject(abortReason(signal, label));

  const check = (): T | undefined => readJsonLog<T>(file).find(match);
  const existing = check();
  if (existing !== undefined) return Promise.resolve(existing);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let watcher: FSWatcher | null = null;
    let timer: NodeJS.Timeout | undefined;
    let fallbackTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (fallbackTimer !== undefined) clearInterval(fallbackTimer);
      signal?.removeEventListener("abort", onAbort);
      if (watcher !== null) {
        try {
          watcher.close();
        } catch {
        }
        watcher = null;
      }
    };

    const settleResolve = (entry: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(entry);
    };

    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => settleReject(abortReason(signal!, label));

    const probe = () => {
      if (settled) return;
      try {
        const hit = check();
        if (hit !== undefined) settleResolve(hit);
      } catch (err) {
        settleReject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      settleReject(new Error(`Timed out after ${timeoutMs}ms waiting for log event${label ? `: ${label}` : ""}`));
    }, timeoutMs);
    timer.unref?.();

    try {
      watcher = watch(dirname(file), { persistent: false }, () => probe());
      watcher.on("error", () => {});
    } catch {
      // Fall back to periodic check if the parent directory cannot be watched.
    }

    probe();
    if (!settled) {
      fallbackTimer = setInterval(probe, 50);
      fallbackTimer.unref?.();
    }
  });
}

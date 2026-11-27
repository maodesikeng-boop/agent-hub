import { readFileSync } from "node:fs";

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

/**
 * Waits for a complete JSONL record matching `match` to appear in `file` using filesystem watch events.
 * Postcondition: resolves with the first matching entry immediately when already present or upon append;
 * rejects promptly when `signal` aborts or `timeoutMs` elapses, and closes all watchers and timers before settling.
 */
export async function waitForJsonLogEvent<T>(_options: WaitForJsonLogOptions<T>): Promise<T> {
  throw new Error("Not implemented");
}

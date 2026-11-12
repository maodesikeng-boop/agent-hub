import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_TEXT_MAX_BYTES } from "./limits.ts";
export function isActive(dir: string): boolean {
  try { const pid = Number(readFileSync(join(dir, ".active"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e instanceof Error && "code" in e && e.code === "EPERM"; }
  } catch { return false; }
}
export function markActive(dir: string): () => void {
  writeFileSync(join(dir, ".active"), String(process.pid));
  return () => rmSync(join(dir, ".active"), { force: true });
}
export function killGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try { process.kill(-pid, signal); } catch { /* 已退出。 */ }
}
const cleanups = new Set<() => void>();
let installed = false;
export function onExit(cleanup: () => void): () => void {
  if (!installed) {
    installed = true;
    process.once("exit", () => { for (const fn of cleanups) fn(); });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
      for (const fn of cleanups) fn();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
  cleanups.add(cleanup);
  return () => cleanups.delete(cleanup);
}
export function boundedText(text: string, maxBytes = EVAL_TEXT_MAX_BYTES): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  const suffix = Buffer.from("\n…（已按字节上限截断）\n");
  if (maxBytes < suffix.length) return "";
  return buffer.subarray(0, Math.max(0, maxBytes - suffix.length)).toString("utf8").replace(/\uFFFD$/, "") + suffix.toString();
}

import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function diagDir(): string {
  const dir = process.env.FUSA_WIN_DIAG_DIR || join(tmpdir(), "fusa-win-diag");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeDiagLog(name: string, content: string): void {
  try {
    const file = join(diagDir(), `${name}.log`);
    appendFileSync(file, `[${new Date().toISOString()}]\n${content}\n---\n`, "utf8");
  } catch {
    // Never fail tests if diag logging fails
  }
}

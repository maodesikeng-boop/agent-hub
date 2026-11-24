import { statSync } from "node:fs";

export function fileStamp(file: string): string {
  try {
    const stat = statSync(file);
    return stat.isFile() ? `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` : "";
  } catch {
    return "";
  }
}

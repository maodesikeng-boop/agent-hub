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

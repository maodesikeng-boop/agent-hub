import { HUB_COMPOSER_COMMANDS, type ComposerCommand } from "../shared/index.ts";

export const WORKER_COMMAND = HUB_COMPOSER_COMMANDS[0]!.name;

export const WORKER_ARG_LEVELS = 3;

interface TriggerRange {
  query: string;
  start: number;
  end: number;
}

export type ComposerTrigger =
  | (TriggerRange & { kind: "command" | "file" })
  | (TriggerRange & { kind: "worker"; args: readonly string[] });

const isSpace = (char: string | undefined): boolean => char === " " || char === "\n" || char === "\t" || char === "\r";

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function wordEndFrom(text: string, from: number): number {
  let end = from;
  while (end < text.length && !isSpace(text[end])) end += 1;
  return end;
}

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const prefix = text.slice(0, cursor);

  const head = `/${WORKER_COMMAND} `;
  if (prefix.startsWith(head)) {
    const rest = prefix.slice(head.length);
    if (/[\t\n\r]/.test(rest)) return null;
    const words = rest.split(" ");
    const query = words.pop()!;
    if (words.length >= WORKER_ARG_LEVELS || words.includes("")) return null;
    return { kind: "worker", args: words, query, start: cursor - query.length, end: wordEndFrom(text, cursor) };
  }

  if (prefix.startsWith("/") && !/\s/.test(prefix)) {
    const end = wordEndFrom(text, cursor);
    if (text.slice(1, end).includes("/")) return null;
    return { kind: "command", query: prefix.slice(1), start: 0, end };
  }

  let start = cursor;
  while (start > 0 && !isSpace(text[start - 1])) start -= 1;
  if (text[start] !== "@" || start >= cursor) return null;
  return { kind: "file", query: text.slice(start + 1, cursor), start, end: wordEndFrom(text, cursor) };
}

export function removeLeadingCommand(text: string, end: number): string {
  const afterSpace = text[end] === " " ? end + 1 : end;
  return text.slice(text[afterSpace] === "\n" ? afterSpace + 1 : afterSpace);
}

export function insertSelection(text: string, trigger: Pick<ComposerTrigger, "start" | "end">, insert: string): { text: string; cursor: number } {
  const tail = text[trigger.end] === " " ? trigger.end + 1 : trigger.end;
  const inserted = `${insert} `;
  return { text: `${text.slice(0, trigger.start)}${inserted}${text.slice(tail)}`, cursor: trigger.start + inserted.length };
}

export function rankMatches<T>(items: readonly T[], query: string, names: (item: T) => readonly string[], detail: (item: T) => string): readonly T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return items;
  const ranked: { item: T; rank: number }[] = [];
  for (const item of items) {
    const lower = names(item).map((n) => n.toLowerCase());
    const rank = lower.some((n) => n.startsWith(q)) ? 0 : lower.some((n) => n.includes(q)) ? 1 : detail(item).toLowerCase().includes(q) ? 2 : -1;
    if (rank >= 0) ranked.push({ item, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.item);
}

export function rankCommands(commands: readonly ComposerCommand[], query: string): readonly ComposerCommand[] {
  return rankMatches(commands, query, (c) => [c.name], (c) => c.description);
}

export function splitPath(path: string): { name: string; dir: string } {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? { name: trimmed, dir: "" } : { name: trimmed.slice(slash + 1), dir: trimmed.slice(0, slash) };
}

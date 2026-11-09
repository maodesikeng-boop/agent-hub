// 输入框里 “/” 命令和 “@” 文件的触发规则，全是纯函数（界面在 ComposerMenu.tsx，状态在 composer-suggest.ts）。
// 规则参考 t3code 的 composerTrigger.ts：“/” 只认整条消息开头，带第二个 “/” 的是路径（/usr/bin）；
// “@” 必须在开头或空白后（a@b.com 是邮箱）。网页不认识具体厂商，要插入什么文字由后台给。

import type { ComposerCommand } from "../shared/index.ts";

type ComposerTriggerKind = "command" | "file";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  /** 触发符号后面、光标前面打的字，用来筛选。 */
  query: string;
  /** 选中后要替换的那一段文字：[start, end)，从触发符号开始，到这个词的末尾（光标后面的半个词也算）。 */
  start: number;
  end: number;
}

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

/** 光标现在落在哪种触发上；没有触发返回 null。 */
export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const prefix = text.slice(0, cursor);

  // “/”：整条消息的第一个字符，光标还在第一个词里；整个词里有第二个 “/” 就不是命令
  if (prefix.startsWith("/") && !/\s/.test(prefix)) {
    const end = wordEndFrom(text, cursor);
    if (text.slice(1, end).includes("/")) return null;
    return { kind: "command", query: prefix.slice(1), start: 0, end };
  }

  // “@”：光标所在的词必须以 @ 开头（词从开头或空白后算起）
  let start = cursor;
  while (start > 0 && !isSpace(text[start - 1])) start -= 1;
  if (text[start] !== "@" || start >= cursor) return null;
  return { kind: "file", query: text.slice(start + 1, cursor), start, end: wordEndFrom(text, cursor) };
}

/**
 * 把 [start, end) 换成 insert 加一个空格，光标停在空格后。
 * 后面本来就是空格时吃掉它，不会变成两个空格。
 */
export function insertSelection(text: string, trigger: Pick<ComposerTrigger, "start" | "end">, insert: string): { text: string; cursor: number } {
  const tail = text[trigger.end] === " " ? trigger.end + 1 : trigger.end;
  const inserted = `${insert} `;
  return { text: `${text.slice(0, trigger.start)}${inserted}${text.slice(tail)}`, cursor: trigger.start + inserted.length };
}

/** 按输入筛选命令：名字开头命中的排最前，其次名字里有，最后说明里有；同一档保持后台给的顺序。不区分大小写。 */
export function rankCommands(commands: ComposerCommand[], query: string): ComposerCommand[] {
  const q = query.trim().toLowerCase();
  if (q === "") return commands;
  const ranked: { command: ComposerCommand; rank: number }[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    const rank = name.startsWith(q) ? 0 : name.includes(q) ? 1 : command.description.toLowerCase().includes(q) ? 2 : -1;
    if (rank >= 0) ranked.push({ command, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.command);
}

/** 文件路径拆成文件名和父目录（没有父目录是空串）。 */
export function splitPath(path: string): { name: string; dir: string } {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? { name: trimmed, dir: "" } : { name: trimmed.slice(slash + 1), dir: trimmed.slice(0, slash) };
}

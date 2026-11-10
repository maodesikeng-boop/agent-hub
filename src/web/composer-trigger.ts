// 输入框里 “/” 命令和 “@” 文件的触发规则，全是纯函数（界面在 ComposerMenu.tsx，状态在 composer-suggest.ts）。
// 规则参考 t3code 的 composerTrigger.ts：“/” 只认整条消息开头，带第二个 “/” 的是路径（/usr/bin）；
// “@” 必须在开头或空白后（a@b.com 是邮箱）。网页不认识具体厂商，要插入什么文字由后台给。
// agent-hub 自己的 /hub:worker 后面带参数（厂商 模型 思考程度），一级一级补全：光标所在的词就是正在选的那一级。

import { HUB_COMPOSER_COMMANDS, type ComposerCommand } from "../shared/index.ts";

/** 派 Worker 用的厂商、模型、思考程度那条命令的名字（不带 /）。HUB_COMPOSER_COMMANDS 现在只有它这一条。 */
export const WORKER_COMMAND = HUB_COMPOSER_COMMANDS[0]!.name;

/** /hub:worker 后面最多几级参数（厂商、模型、思考程度）。 */
export const WORKER_ARG_LEVELS = 3;

interface TriggerRange {
  /** 触发符号后面（参数是这个词开头）、光标前面打的字，用来筛选。 */
  query: string;
  /** 选中后要替换的那一段文字：[start, end)，从触发符号（参数是这个词开头）开始，到这个词的末尾（光标后面的半个词也算）。 */
  start: number;
  end: number;
}

export type ComposerTrigger =
  | (TriggerRange & { kind: "command" | "file" })
  /** /hub:worker 的参数：args 是前面已经选好的几级，正在选第 args.length 级。 */
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

/** 光标现在落在哪种触发上；没有触发返回 null。 */
export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const prefix = text.slice(0, cursor);

  // /hub:worker 的参数：命令名后面单个空格隔开的词，光标在第几个词里就是第几级；换行、连着两个空格、选满了都不算
  const head = `/${WORKER_COMMAND} `;
  if (prefix.startsWith(head)) {
    const rest = prefix.slice(head.length);
    if (/[\t\n\r]/.test(rest)) return null;
    const words = rest.split(" ");
    const query = words.pop()!;
    if (words.length >= WORKER_ARG_LEVELS || words.includes("")) return null;
    return { kind: "worker", args: words, query, start: cursor - query.length, end: wordEndFrom(text, cursor) };
  }

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
 * /hub:worker 选完：把开头的整段命令（到 end 为止，连同后面的一个空格或换行）从文字里拿掉，返回剩下的文字。
 * 点标签重选时原有文字是用换行接在命令后面的（Composer），这个换行一起拿掉。
 */
export function removeLeadingCommand(text: string, end: number): string {
  const afterSpace = text[end] === " " ? end + 1 : end;
  return text.slice(text[afterSpace] === "\n" ? afterSpace + 1 : afterSpace);
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

/**
 * 按输入筛选：几个名字（如 id 和显示名）里任一开头命中的排最前，其次名字里有，最后说明里有；同一档保持原来的顺序。不区分大小写。
 * 空查询原样返回同一个数组。
 */
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

/** 按输入筛选命令（规则见 rankMatches，名字是命令名）。 */
export function rankCommands(commands: readonly ComposerCommand[], query: string): readonly ComposerCommand[] {
  return rankMatches(commands, query, (c) => [c.name], (c) => c.description);
}

/** 文件路径拆成文件名和父目录（没有父目录是空串）。 */
export function splitPath(path: string): { name: string; dir: string } {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? { name: trimmed, dir: "" } : { name: trimmed.slice(slash + 1), dir: trimmed.slice(0, slash) };
}

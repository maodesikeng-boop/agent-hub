// 输入框的 “/” 命令、“@” 文件弹出列表的状态：什么时候弹、列表里是什么、键盘怎么选、选中后改什么字。
// 触发规则在 composer-trigger.ts（纯函数），列表的样子在 components/ComposerMenu.tsx，这里不认识具体厂商：
// 命令列表和要插入的文字都由后台给（GET /api/conversations/:id/commands 和 files?q=）。
// 拿不到列表（后台问不到、请求失败）一律不弹、不报错，输入框照常能发。
import { useEffect, useMemo, useState } from "react";
import { API_PATHS, type CommandsResponse, type ComposerCommand, type FileEntry, type FilesResponse } from "../shared/index.ts";
import type { KeyboardEvent } from "react";
import { type ComposerTrigger, detectComposerTrigger, insertSelection, rankCommands, splitPath } from "./composer-trigger.ts";

/** 接着打字，等这么久没再打才去后台搜文件。 */
export const FILE_SEARCH_DEBOUNCE_MS = 120;

/** 列表数据从哪来。按对话取：conversationSource(id)。 */
export interface ComposerSource {
  commands: (signal: AbortSignal) => Promise<ComposerCommand[]>;
  files: (query: string, signal: AbortSignal) => Promise<FilesResponse>;
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (!res.ok) throw new Error(`请求失败（${res.status}）`);
  return (await res.json()) as T;
}

/** url：这个对话所在设备的地址（client.ts 的 HubClient.url），默认入口本机。 */
export function conversationSource(conversationId: number, url: (path: string) => string = (path) => path): ComposerSource {
  return {
    commands: async (signal) => (await getJson<CommandsResponse>(url(API_PATHS.commands(conversationId)), signal)).commands,
    files: (query, signal) => getJson<FilesResponse>(url(API_PATHS.files(conversationId, query)), signal),
  };
}

/** 列表里的一行（命令和文件统一成这个样子，界面不用分开处理）。 */
export interface MenuItem {
  id: string;
  /** 命令是 /名字，文件是文件名。 */
  label: string;
  /** 命令的说明，文件的父目录；没有就是空串。 */
  detail: string;
  /** 选中后插进输入框的文字。 */
  insert: string;
}

export interface MenuState {
  kind: ComposerTrigger["kind"];
  items: MenuItem[];
  activeIndex: number;
}

const commandItems = (commands: ComposerCommand[]): MenuItem[] =>
  commands.map((c) => ({ id: `command:${c.name}`, label: `/${c.name}`, detail: c.description, insert: `/${c.name}` }));

const fileItems = (entries: FileEntry[]): MenuItem[] =>
  entries.map((e) => {
    const { name, dir } = splitPath(e.path);
    return { id: `file:${e.root}:${e.path}`, label: name, detail: dir, insert: e.insert };
  });

export interface ComposerSuggest {
  /** 列表要显示就有值，不显示是 null。 */
  menu: MenuState | null;
  /** 键盘事件：处理了（选、翻、关）返回 true，调用者就不再处理（比如 Enter 不发送）。 */
  handleKey: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  select: (item: MenuItem) => void;
  highlight: (index: number) => void;
}

/**
 * value / cursor：输入框现在的文字和光标；onReplace：选中后要把文字换成什么、光标放哪。
 * enabled 为 false（输入框不可用、发送中）时不弹。
 */
export function useComposerSuggest({
  source,
  value,
  cursor,
  enabled,
  onReplace,
}: {
  source: ComposerSource | undefined;
  value: string;
  cursor: number;
  enabled: boolean;
  onReplace: (text: string, cursor: number) => void;
}): ComposerSuggest {
  const detected = useMemo(() => (enabled && source !== undefined ? detectComposerTrigger(value, cursor) : null), [enabled, source, value, cursor]);

  // Esc 关掉的那个触发（按种类和起点认）：同一处接着打字不再弹，换个地方打 / 或 @ 又弹
  const [dismissed, setDismissed] = useState<string | null>(null);
  const detectedKey = detected === null ? null : `${detected.kind}:${detected.start}`;
  const trigger = detected !== null && detectedKey !== dismissed ? detected : null;
  useEffect(() => {
    if (detected === null) setDismissed(null);
  }, [detected]);

  // 命令列表：每次在开头打 / 都重新问一次（列表会变），拿到之前沿用上一份；问不到就当没有
  const [commands, setCommands] = useState<{ source: ComposerSource; list: ComposerCommand[] } | null>(null);
  const commandOpen = trigger?.kind === "command";
  useEffect(() => {
    if (!commandOpen || source === undefined) return;
    const abort = new AbortController();
    source
      .commands(abort.signal)
      .then((list) => {
        if (!abort.signal.aborted) setCommands({ source, list });
      })
      .catch(() => {
        if (!abort.signal.aborted) setCommands(null);
      });
    return () => abort.abort();
  }, [commandOpen, source]);

  // 文件：等 120ms 没再打字才发；再打字时旧请求作废，后发先回也不会把旧结果显示出来
  const [files, setFiles] = useState<{ source: ComposerSource; query: string; entries: FileEntry[] } | null>(null);
  const fileQuery = trigger?.kind === "file" ? trigger.query : null;
  useEffect(() => {
    if (fileQuery === null || source === undefined) {
      setFiles(null);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      source
        .files(fileQuery, abort.signal)
        .then((result) => {
          if (!abort.signal.aborted) setFiles({ source, query: fileQuery, entries: result.entries });
        })
        .catch(() => {
          if (!abort.signal.aborted) setFiles(null);
        });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [fileQuery, source]);

  // 列表内容；null 就是不弹
  const content = useMemo((): { kind: ComposerTrigger["kind"]; items: MenuItem[] } | null => {
    if (trigger === null || source === undefined) return null;
    if (trigger.kind === "command") {
      if (commands === null || commands.source !== source || commands.list.length === 0) return null;
      return { kind: "command", items: commandItems(rankCommands(commands.list, trigger.query)) };
    }
    if (files === null || files.source !== source) return null;
    // 新一轮搜索还没回来：留着上一份结果；上一份是空的就先不显示“没有匹配”
    if (files.entries.length === 0 && files.query !== trigger.query) return null;
    return { kind: "file", items: fileItems(files.entries) };
  }, [trigger, source, commands, files]);

  // 高亮第几行：筛选条件一变就回到第一行
  const menuKey = trigger === null ? "" : `${trigger.kind}:${trigger.query}`;
  const [picked, setPicked] = useState({ key: "", index: 0 });
  const count = content?.items.length ?? 0;
  const activeIndex = count === 0 ? 0 : Math.min(picked.key === menuKey ? picked.index : 0, count - 1);

  const highlight = (index: number) => setPicked({ key: menuKey, index });

  const select = (item: MenuItem) => {
    if (trigger === null) return;
    const next = insertSelection(value, trigger, item.insert);
    onReplace(next.text, next.cursor);
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    // 输入法选字时的按键不算（keyCode 229 是部分浏览器在选字时的值）
    if (content === null || e.nativeEvent.isComposing || e.keyCode === 229) return false;
    if (e.key === "Escape") {
      if (detectedKey !== null) setDismissed(detectedKey);
      e.stopPropagation();
      return true;
    }
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || count === 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      highlight((activeIndex + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      select(content.items[activeIndex]!);
      return true;
    }
    return false;
  };

  return { menu: content === null ? null : { ...content, activeIndex }, handleKey, select, highlight };
}

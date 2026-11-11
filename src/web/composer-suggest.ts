// 输入框的 “/” 命令、“@” 文件弹出列表的状态：什么时候弹、列表里是什么、键盘怎么选、选中后改什么字。
// 触发规则在 composer-trigger.ts（纯函数），列表的样子在 components/ComposerMenu.tsx，这里不认识具体厂商：
// 命令列表和要插入的文字都由后台给（GET /api/conversations/:id/commands 和 files?q=）。
// 拿不到列表（后台问不到、请求失败）一律不弹、不报错，输入框照常能发。
// 例外是 agent-hub 自己的命令（HUB_COMPOSER_COMMANDS，只在项目经理对话里由 source 带进来）：排在最前面，厂商命令拉不到也出现；
// /hub:worker 后面一级一级选厂商、模型、思考程度，行由 worker-pick.ts 从模型名单（models.tsx，和资料页同一份缓存）算。
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { API_PATHS, SLOW_API_REQUEST_TIMEOUT_MS, type CommandsResponse, type ComposerCommand, type FileEntry, type FilesResponse, type WorkerPick } from "../shared/index.ts";
import type { KeyboardEvent } from "react";
import { detectComposerTrigger, insertSelection, rankCommands, removeLeadingCommand, splitPath } from "./composer-trigger.ts";
import { useModelCatalogs } from "./models.tsx";
import { useHubQueryClient } from "./query-client.ts";
import { type WorkerPickLevel, workerPickFromArgs, workerPickRows } from "./worker-pick.ts";

/** 接着打字，等这么久没再打才去后台搜文件。 */
export const FILE_SEARCH_DEBOUNCE_MS = 120;

/** 列表数据从哪来。按对话取：conversationSource(id)；Router 工作台用 routerTargetSource(targets)。 */
export interface ComposerSource {
  commands: (signal: AbortSignal) => Promise<ComposerCommand[]>;
  files: (query: string, signal: AbortSignal) => Promise<FilesResponse>;
  /** agent-hub 自己的命令（项目经理对话给 HUB_COMPOSER_COMMANDS，别的对话不给）。 */
  hubCommands?: readonly ComposerCommand[];
  /** Router 工作台的 `@` 跨设备项目/PM 同步补全数据源；提供时 `@` 不查单对话文件而走目标筛选。 */
  targets?: (query: string) => MenuItem[];
}

let nextSourceId = 1;
const sourceIds = new WeakMap<ComposerSource, number>();
function sourceKeyOf(source: ComposerSource | undefined): number {
  if (!source) return 0;
  let id = sourceIds.get(source);
  if (id === undefined) {
    id = nextSourceId++;
    sourceIds.set(source, id);
  }
  return id;
}

/** 接着打字会取消上一个（signal）；连接静默断了也不一直挂着（后台问命令最多要 COMMANDS_QUERY_TIMEOUT_MS，用长的那档超时）。 */
async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", signal: AbortSignal.any([signal, AbortSignal.timeout(SLOW_API_REQUEST_TIMEOUT_MS)]) });
  if (!res.ok) throw new Error(`请求失败（${res.status}）`);
  return (await res.json()) as T;
}

/** url：这个对话所在设备的地址（client.ts 的 HubClient.url），默认入口本机。hubCommands：只有项目经理对话给。 */
export function conversationSource(
  conversationId: number,
  url: (path: string) => string = (path) => path,
  hubCommands?: readonly ComposerCommand[],
): ComposerSource {
  return {
    commands: async (signal) => (await getJson<CommandsResponse>(url(API_PATHS.commands(conversationId)), signal)).commands,
    files: (query, signal) => getJson<FilesResponse>(url(API_PATHS.files(conversationId, query)), signal),
    hubCommands,
  };
}

/** 列表里的一行（命令、文件与跨设备目标统一成这个样子，界面不用分开处理）。 */
export interface MenuItem {
  id: string;
  /** 命令是 /名字，文件是文件名，目标是项目名或 PM 名。 */
  label: string;
  /** 命令的说明，文件的父目录，目标的 PM / 设备补充信息；没有就是空串。 */
  detail: string;
  /** 选中后插进输入框的文字。 */
  insert: string;
  /** 列出来但不能选（没登录的厂商、离线设备的目标）。 */
  disabled?: boolean;
  /** 目标行的水果切片头像色键。 */
  avatarKey?: number;
  /** 目标行的唯一键（选中后由 Router 挂成目标胶囊，不插纯文本）。 */
  targetKey?: string;
}

/** 列表是哪种：命令、文件、跨设备目标，或 /hub:worker 的某一级。 */
export type MenuKind = "command" | "file" | "target" | WorkerPickLevel;

export interface MenuState {
  kind: MenuKind;
  items: MenuItem[];
  activeIndex: number;
}

const commandItems = (commands: readonly ComposerCommand[]): MenuItem[] =>
  commands.map((c) => ({ id: `command:${c.name}`, label: `/${c.name}`, detail: c.description, insert: `/${c.name}` }));

const fileItems = (entries: FileEntry[]): MenuItem[] =>
  entries.map((e) => {
    const { name, dir } = splitPath(e.path);
    return { id: `file:${e.root}:${e.path}`, label: name, detail: dir, insert: e.insert };
  });

const NO_COMMANDS: readonly ComposerCommand[] = [];

export interface ComposerSuggest {
  /** 列表要显示就有值，不显示是 null。activeIndex 是 -1：一行都不能选。 */
  menu: MenuState | null;
  /** 键盘事件：处理了（选、翻、关）返回 true，调用者就不再处理（比如 Enter 不发送）。 */
  handleKey: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  select: (item: MenuItem) => void;
  highlight: (index: number) => void;
  /** Esc 关过列表后主动重开（如点标签重选）。 */
  reopen: () => void;
  /** 主动关掉当前打开的补全菜单（窗口级 Esc 兜底调用）。 */
  dismiss: () => void;
}

/**
 * value / cursor：输入框现在的文字和光标；onReplace：选中后要把文字换成什么、光标放哪。
 * onPick：/hub:worker 最后一级选完（或下一级不存在）时调，给选好的 WorkerPick 和拿掉整段命令后的文字（输入框把它变成标签）；
 * 不给就把完整命令留在文字里。enabled 为 false（输入框不可用、发送中）时不弹。
 */
export function useComposerSuggest({
  source,
  value,
  cursor,
  enabled,
  onReplace,
  onPick,
  onSelectTarget,
}: {
  source: ComposerSource | undefined;
  value: string;
  cursor: number;
  enabled: boolean;
  onReplace: (text: string, cursor: number) => void;
  onPick?: ((pick: WorkerPick, text: string) => void) | undefined;
  onSelectTarget?: ((targetKey: string, text: string, cursor: number) => void) | undefined;
}): ComposerSuggest {
  const qc = useHubQueryClient();
  const srcKey = sourceKeyOf(source);
  const detected = useMemo(() => (enabled && source !== undefined ? detectComposerTrigger(value, cursor) : null), [enabled, source, value, cursor]);

  // Esc 关掉的那个触发（按种类和起点认）：同一处接着打字不再弹，换个地方打 / 或 @ 又弹
  const [dismissed, setDismissed] = useState<string | null>(null);
  const detectedKey = detected === null ? null : `${detected.kind}:${detected.start}`;
  const trigger = detected !== null && detectedKey !== dismissed ? detected : null;
  useEffect(() => {
    if (detected === null) setDismissed(null);
  }, [detected]);

  // 命令列表：每次在开头打 / 都重新问一次（列表会变），拿到之前沿用上一份；问不到就当没有
  const commandOpen = trigger?.kind === "command" && source !== undefined;
  const hubCommands = source?.hubCommands ?? NO_COMMANDS;
  const hasHub = hubCommands.length > 0;
  // 模型名单：项目经理对话里打开 “/” 列表时才要（staleTime 内不重拉），之后选厂商、打字筛都在本地算
  const catalogs = useModelCatalogs(hasHub && (trigger?.kind === "command" || trigger?.kind === "worker"));
  const { data: commands = null } = useQuery(
    {
      queryKey: ["composer-commands", srcKey] as const,
      queryFn: async ({ signal }) => {
        try {
          const list = await source!.commands(signal);
          return { source: source!, list };
        } catch {
          return null;
        }
      },
      enabled: commandOpen,
      staleTime: 0,
      placeholderData: keepPreviousData,
    },
    qc,
  );

  // 文件：等 120ms 没再打字才发；再打字时旧请求作废，后发先回也不会把旧结果显示出来
  const filesKey = useMemo(() => ["composer-files", srcKey] as const, [srcKey]);
  const { data: files = null } = useQuery<{ source: ComposerSource; query: string; entries: FileEntry[] } | null>(
    {
      queryKey: filesKey,
      queryFn: () => null,
      enabled: false,
    },
    qc,
  );
  const fileQuery = trigger?.kind === "file" && source?.targets === undefined ? trigger.query : null;
  useEffect(() => {
    if (fileQuery === null || source === undefined) {
      qc.setQueryData(filesKey, null);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void qc
        .fetchQuery({
          queryKey: ["composer-files-search", srcKey, fileQuery] as const,
          queryFn: () => source.files(fileQuery, abort.signal),
          staleTime: 0,
          gcTime: 0,
        })
        .then((result) => {
          if (!abort.signal.aborted) qc.setQueryData(filesKey, { source, query: fileQuery, entries: result.entries });
        })
        .catch(() => {
          if (!abort.signal.aborted) qc.setQueryData(filesKey, null);
        });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [fileQuery, source, srcKey, filesKey, qc]);

  // hub 命令在前，厂商命令里同名的去掉；厂商命令还没拿到、拿不到时只有 hub 命令
  const vendorCommands = commands !== null && commands.source === source ? commands.list : null;
  const allCommands = useMemo((): readonly ComposerCommand[] => {
    if (!hasHub) return vendorCommands ?? [];
    if (vendorCommands === null) return hubCommands;
    const names = new Set(hubCommands.map((c) => c.name));
    return [...hubCommands, ...vendorCommands.filter((c) => !names.has(c.name))];
  }, [hasHub, hubCommands, vendorCommands]);

  // 列表内容；null 就是不弹
  const content = useMemo((): { kind: MenuKind; items: MenuItem[] } | null => {
    if (trigger === null || source === undefined) return null;
    if (trigger.kind === "command") {
      if (allCommands.length === 0) return null;
      return { kind: "command", items: commandItems(rankCommands(allCommands, trigger.query)) };
    }
    if (trigger.kind === "worker") {
      if (!hasHub) return null;
      const rows = workerPickRows(catalogs, trigger.args, trigger.query);
      return rows === null ? null : { kind: rows.level, items: rows.items };
    }
    if (source.targets !== undefined) {
      return { kind: "target", items: source.targets(trigger.query) };
    }
    if (files === null || files.source !== source) return null;
    // 新一轮搜索还没回来：留着上一份结果；上一份是空的就先不显示“没有匹配”
    if (files.entries.length === 0 && files.query !== trigger.query) return null;
    return { kind: "file", items: fileItems(files.entries) };
  }, [trigger, source, allCommands, hasHub, catalogs, files]);

  // 高亮第几行：筛选条件一变就回到第一行能选的；不能选的行（没登录的厂商）高亮跳过
  const menuKey = trigger === null ? "" : `${trigger.kind}:${trigger.start}:${trigger.query}`;
  const [picked, setPicked] = useState({ key: "", index: 0 });
  const items = content?.items ?? [];
  const count = items.length;
  const enabledFrom = (from: number, step: 1 | -1): number => {
    for (let i = 0; i < count; i++) {
      const index = (((from + step * i) % count) + count) % count;
      if (!items[index]!.disabled) return index;
    }
    return -1;
  };
  const activeIndex = count === 0 ? 0 : enabledFrom(picked.key === menuKey ? Math.min(picked.index, count - 1) : 0, 1);

  const highlight = (index: number) => {
    if (!items[index]?.disabled) setPicked({ key: menuKey, index });
  };

  const select = (item: MenuItem) => {
    if (trigger === null || item.disabled) return;
    if (trigger.kind === "file" && item.targetKey !== undefined && onSelectTarget) {
      const before = value.slice(0, trigger.start);
      const after = value.slice(trigger.end);
      const trimmedAfter = before === "" ? after.replace(/^ /, "") : after;
      onSelectTarget(item.targetKey, before + trimmedAfter, before.length);
      return;
    }
    if (trigger.kind === "worker" && onPick) {
      const args = [...trigger.args, item.insert];
      const pick = workerPickFromArgs(args);
      if (pick !== null && workerPickRows(catalogs, args, "") === null) {
        onPick(pick, removeLeadingCommand(value, trigger.end));
        return;
      }
    }
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
      if (activeIndex >= 0) highlight(enabledFrom(activeIndex + (e.key === "ArrowDown" ? 1 : -1), e.key === "ArrowDown" ? 1 : -1));
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      // 一行都不能选（只剩没登录的厂商）：也吞掉，不把半截命令发出去
      if (activeIndex >= 0) select(items[activeIndex]!);
      return true;
    }
    return false;
  };

  return {
    menu: content === null ? null : { ...content, activeIndex },
    handleKey,
    select,
    highlight,
    reopen: () => setDismissed(null),
    dismiss: () => {
      if (detectedKey !== null) setDismissed(detectedKey);
    },
  };
}

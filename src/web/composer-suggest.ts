import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { API_PATHS, SLOW_API_REQUEST_TIMEOUT_MS, type CommandsResponse, type ComposerCommand, type FileEntry, type FilesResponse, type WorkerPick } from "../shared/index.ts";
import type { KeyboardEvent } from "react";
import { detectComposerTrigger, insertSelection, rankCommands, removeLeadingCommand, splitPath } from "./composer-trigger.ts";
import { useModelCatalogs } from "./models.tsx";
import { useHubQueryClient } from "./query-client.ts";
import type { SlimeLook } from "../shared/slimes.ts";
import { type WorkerPickLevel, workerPickFromArgs, workerPickRows } from "./worker-pick.ts";

export const FILE_SEARCH_DEBOUNCE_MS = 120;

export interface ComposerSource {
  commands: (signal: AbortSignal) => Promise<ComposerCommand[]>;
  files: (query: string, signal: AbortSignal) => Promise<FilesResponse>;
  hubCommands?: readonly ComposerCommand[];
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

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", signal: AbortSignal.any([signal, AbortSignal.timeout(SLOW_API_REQUEST_TIMEOUT_MS)]) });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

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

export interface MenuItem {
  id: string;
  label: string;
  detail: string;
  insert: string;
  disabled?: boolean;
  look?: SlimeLook;
  targetKey?: string;
}

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
  menu: MenuState | null;
  handleKey: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  select: (item: MenuItem) => void;
  highlight: (index: number) => void;
  reopen: () => void;
  dismiss: () => void;
}

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

  const [dismissed, setDismissed] = useState<string | null>(null);
  const detectedKey = detected === null ? null : `${detected.kind}:${detected.start}`;
  const trigger = detected !== null && detectedKey !== dismissed ? detected : null;
  useEffect(() => {
    if (detected === null) setDismissed(null);
  }, [detected]);

  const commandOpen = trigger?.kind === "command" && source !== undefined;
  const hubCommands = source?.hubCommands ?? NO_COMMANDS;
  const hasHub = hubCommands.length > 0;
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

  const vendorCommands = commands !== null && commands.source === source ? commands.list : null;
  const allCommands = useMemo((): readonly ComposerCommand[] => {
    if (!hasHub) return vendorCommands ?? [];
    if (vendorCommands === null) return hubCommands;
    const names = new Set(hubCommands.map((c) => c.name));
    return [...hubCommands, ...vendorCommands.filter((c) => !names.has(c.name))];
  }, [hasHub, hubCommands, vendorCommands]);

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
    if (files.entries.length === 0 && files.query !== trigger.query) return null;
    return { kind: "file", items: fileItems(files.entries) };
  }, [trigger, source, allCommands, hasHub, catalogs, files]);

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
      const pick = workerPickFromArgs(args, catalogs);
      if (pick !== null && workerPickRows(catalogs, args, "") === null) {
        onPick(pick, removeLeadingCommand(value, trigger.end));
        return;
      }
    }
    const next = insertSelection(value, trigger, item.insert);
    onReplace(next.text, next.cursor);
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    // Ignore keys during IME composition; some browsers report keyCode 229 there.
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

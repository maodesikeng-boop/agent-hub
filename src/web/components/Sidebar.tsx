import { Plus, Search, Settings } from "lucide-react";
import { useState } from "react";
import { formatTime } from "../format.ts";
import type { NotifySettings } from "../notify.ts";
import { previewText, type ConversationEntry } from "../selectors.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Avatar } from "./Avatar.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";

function EntryButton({
  entry,
  active,
  waiting,
  onSelect,
}: {
  entry: ConversationEntry;
  active: boolean;
  /** 对话停稳了，在等用户。 */
  waiting: boolean;
  onSelect: (id: number) => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active ? "bg-sidebar-active" : "hover:bg-sidebar-hover",
      )}
      onClick={() => onSelect(entry.id)}
    >
      <Avatar colorKey={entry.avatarKey} size={44} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-[15px]", active ? "font-semibold" : "font-medium")}>{entry.name}</span>
          <span className="flex shrink-0 items-center gap-2">
            {waiting && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">等你</span>}
            {entry.lastMessage && <span className="text-xs text-muted-foreground tabular-nums">{formatTime(entry.lastMessage.createdAt)}</span>}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[13.5px] text-muted-foreground">{previewText(entry)}</span>
      </span>
    </button>
  );
}

/** 按项目经理的名字和项目名筛，不区分大小写，前后空格不算。 */
function matches(entry: ConversationEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || entry.name.toLowerCase().includes(q) || (entry.project?.name.toLowerCase().includes(q) ?? false);
}

/** 左栏：每个项目经理一行（头像、名字、最后一条消息），点进去就是它唯一的那个对话。 */
export function Sidebar({
  entries,
  activeId,
  waiting,
  notify,
  onSelect,
  onNewPm,
}: {
  /** 已经按最后一条消息的时间排好。 */
  entries: ConversationEntry[];
  activeId: number | null;
  /** 在“等你”的对话。 */
  waiting: ReadonlySet<number>;
  notify: NotifySettings;
  onSelect: (id: number) => void;
  onNewPm: () => void;
}) {
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <aside className="flex w-[300px] shrink-0 flex-col bg-sidebar max-[1100px]:w-[264px]">
      <div className="flex h-16 shrink-0 items-center gap-2 px-3">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="搜索"
            placeholder="搜索"
            className="h-9 border-transparent bg-sidebar-active pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button variant="secondary" size="icon" className="shrink-0 bg-sidebar-active hover:bg-sidebar-hover" aria-label="新建项目经理" onClick={onNewPm}>
          <Plus aria-hidden="true" />
        </Button>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 pt-1" aria-label="对话列表">
        {entries
          .filter((entry) => matches(entry, query))
          .map((entry) => (
            <EntryButton key={entry.id} entry={entry} active={entry.id === activeId} waiting={waiting.has(entry.id)} onSelect={onSelect} />
          ))}
      </nav>
      <div className="flex items-center gap-2.5 py-4 pr-3 pl-5">
        <span className="flex size-9 items-center justify-center rounded-full bg-emerald-600 text-sm font-semibold text-white">我</span>
        <span className="flex-1 text-[15px] font-medium">我</span>
        <Button variant="ghost" size="icon-sm" aria-label="设置" onClick={() => setSettingsOpen(true)}>
          <Settings aria-hidden="true" />
        </Button>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} notify={notify} />
    </aside>
  );
}

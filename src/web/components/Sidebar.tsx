import { Plus, Search, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { formatTime } from "../format.ts";
import type { NotifySettings } from "../notify.ts";
import { previewText, type ConversationEntry, type QuotaVendor } from "../selectors.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Avatar } from "./Avatar.tsx";
import { QuotaPopover } from "./QuotaPopover.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";

function EntryButton({
  entry,
  active,
  waiting,
  asking,
  onSelect,
}: {
  entry: ConversationEntry;
  active: boolean;
  /** 对话停稳了，在等用户。 */
  waiting: boolean;
  /** 项目经理用 hub ask 问了用户，还没回答；比“等你”更醒目，两个都有时只显示它。 */
  asking: boolean;
  onSelect: (id: number) => void;
}) {
  // 右边只放一个标注：等你确定 > 等你 > 时间（在忙不另加标记）
  const tag = asking ? (
    <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">等你确定</span>
  ) : waiting ? (
    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">等你</span>
  ) : entry.lastMessage ? (
    <span className="text-xs text-muted-foreground tabular-nums">{formatTime(entry.lastMessage.createdAt)}</span>
  ) : null;
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
          <span className="truncate text-[15px] font-medium">{entry.name}</span>
          {tag && <span className="flex shrink-0 items-center">{tag}</span>}
        </span>
        {/* 没有消息也占一行的高度，每行一样高 */}
        <span className="mt-0.5 block truncate text-[13.5px] text-muted-foreground">{previewText(entry) || " "}</span>
      </span>
    </button>
  );
}

const noop = () => {};

/** 按项目经理的名字和项目名筛，不区分大小写，前后空格不算。 */
function matches(entry: ConversationEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || entry.name.toLowerCase().includes(q) || (entry.project?.name.toLowerCase().includes(q) ?? false);
}

/**
 * 左栏：每个项目经理一行（头像、名字、最后一条消息），点进去就是它唯一的那个对话。
 * 窄屏（1100px 以下）收成抽屉（docs/ui-standard.md 第 16 条）：drawerOpen 时盖在左边，点遮罩、按 Esc、选了对话都收起。
 */
export function Sidebar({
  entries,
  activeId,
  waiting,
  asking,
  notify,
  quota,
  drawerOpen = false,
  onCloseDrawer = noop,
  onSelect,
  onNewPm,
}: {
  /** 已经按最后一条消息的时间排好。 */
  entries: ConversationEntry[];
  activeId: number | null;
  /** 在“等你”的对话。 */
  waiting: ReadonlySet<number>;
  /** 有“等你确定”的提问没回答的对话。 */
  asking: ReadonlySet<number>;
  notify: NotifySettings;
  quota: QuotaVendor[];
  /** 窄屏时抽屉拉出来了（宽屏不看它）。 */
  drawerOpen?: boolean;
  onCloseDrawer?: () => void;
  onSelect: (id: number) => void;
  onNewPm: () => void;
}) {
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, onCloseDrawer]);
  return (
    <>
      {drawerOpen && <div className="fixed inset-0 z-20 bg-black/30 min-[1101px]:hidden" aria-hidden="true" data-testid="drawer-backdrop" onClick={onCloseDrawer} />}
      <aside
        id="sidebar"
        aria-label="左栏"
        data-drawer={drawerOpen ? "open" : "closed"}
        className={cn(
          "flex w-[300px] shrink-0 flex-col bg-sidebar max-[1100px]:fixed max-[1100px]:inset-y-0 max-[1100px]:left-0 max-[1100px]:z-30",
          !drawerOpen && "max-[1100px]:hidden",
        )}
      >
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
          <Button variant="ghost" size="icon" className="shrink-0" aria-label="新建项目经理" onClick={onNewPm}>
            <Plus aria-hidden="true" />
          </Button>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 pt-1" aria-label="对话列表">
          {entries
            .filter((entry) => matches(entry, query))
            .map((entry) => (
              <EntryButton
                key={entry.id}
                entry={entry}
                active={entry.id === activeId}
                waiting={waiting.has(entry.id)}
                asking={asking.has(entry.id)}
                onSelect={onSelect}
              />
            ))}
        </nav>
        <div className="flex items-center gap-1 px-3 py-3">
          <span className="flex min-w-0 flex-1 items-center gap-2.5 px-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-me text-xs font-semibold text-me-foreground" aria-hidden="true">
              我
            </span>
            <span className="truncate text-[15px] font-medium">我</span>
          </span>
          <QuotaPopover quota={quota} />
          <Button variant="ghost" size="icon-sm" aria-label="设置" onClick={() => setSettingsOpen(true)}>
            <Settings aria-hidden="true" />
          </Button>
        </div>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} notify={notify} />
      </aside>
    </>
  );
}

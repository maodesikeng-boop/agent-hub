import { ChevronRight, Plus, Search, Settings } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { conversationKey, isReadOnly, type DeviceKey, type DeviceStatus } from "../devices.ts";
import { formatArchiveRemaining, formatTime } from "../format.ts";
import type { ConversationRef, NotifySettings } from "../notify.ts";
import { previewText, type ConversationEntry, type QuotaVendor } from "../selectors.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { NARROW_QUERY, useMediaQuery } from "../useMediaQuery.ts";
import { Avatar } from "./Avatar.tsx";
import { PlatformIcon, StatusDot, StatusText } from "./DeviceBadges.tsx";
import { QuotaPopover } from "./QuotaPopover.tsx";
import { SettingsDialog, type DeviceSettings } from "./SettingsDialog.tsx";

/** 左栏的一组：一台设备和它的项目经理。只有一组时不显示组头（和没有联机时一样）。 */
export interface SidebarGroup {
  key: DeviceKey;
  name: string;
  platform: string;
  status: DeviceStatus;
  lastOnlineAt: number | null;
  /** 已经按最后一条消息的时间排好。 */
  entries: ConversationEntry[];
}

function EntryButton({
  entry,
  active,
  waiting,
  asking,
  device,
  onSelect,
}: {
  entry: ConversationEntry;
  active: boolean;
  /** 对话停稳了，在等用户。 */
  waiting: boolean;
  /** 项目经理用 hub ask 问了用户，还没回答；比“等你”更醒目，两个都有时只显示它。 */
  asking: boolean;
  /** 跨设备的“等你确定”汇总里，名字后面标是哪台设备（组里的同名条目不标）。 */
  device?: string;
  onSelect: () => void;
}) {
  // 右边只放一个标注：已归档显示剩余删除天数；否则 等你确定圆点 > 等你圆点 > 时间（在忙不另加标记）。圆点不带字，名字只给读屏和悬停
  const tag =
    entry.pm?.archivedAt != null ? (
      <span className="text-xs text-muted-foreground tabular-nums">{formatArchiveRemaining(entry.pm.archivedAt)}</span>
    ) : asking ? (
      <span role="img" aria-label="等你确定" title="等你确定" data-testid="asking-indicator" className="size-2 rounded-full bg-status-active" />
    ) : waiting ? (
      <span role="img" aria-label="等你" title="等你" data-testid="waiting-indicator" className="size-2 shrink-0 rounded-full bg-status-active" />
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
      onClick={onSelect}
    >
      <Avatar colorKey={entry.avatarKey} size={44} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
            <span className={cn("truncate text-[15px] font-medium", device && "max-w-[70%] shrink-0")}>{entry.name}</span>
            {device && (
              <span data-testid="entry-device" title={device} className="min-w-0 truncate text-xs text-muted-foreground">
                {device}
              </span>
            )}
          </span>
          {tag && <span className="flex shrink-0 items-center">{tag}</span>}
        </span>
        {/* 没有消息也占一行的高度，每行一样高 */}
        <span className="mt-0.5 block truncate text-[13.5px] text-muted-foreground">{previewText(entry) || " "}</span>
      </span>
    </button>
  );
}

function NarrowEntryButton({
  entry,
  active,
  waiting,
  asking,
  onSelect,
}: {
  entry: ConversationEntry;
  active: boolean;
  waiting: boolean;
  asking: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      title={entry.name}
      className={cn(
        "relative flex size-13 shrink-0 items-center justify-center rounded-2xl transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active ? "bg-sidebar-active" : "hover:bg-sidebar-hover",
      )}
      onClick={onSelect}
    >
      <span className="relative">
        <Avatar colorKey={entry.avatarKey} size={40} />
        {asking ? (
          <span
            role="img"
            aria-label="等你确定"
            title="等你确定"
            data-testid="asking-indicator"
            className="absolute right-0 bottom-0 size-2 rounded-full bg-status-active ring-2 ring-sidebar"
          />
        ) : waiting ? (
          <span
            role="img"
            aria-label="等你"
            title="等你"
            data-testid="waiting-indicator"
            className="absolute right-0 bottom-0 size-2 rounded-full bg-status-active ring-2 ring-sidebar"
          />
        ) : null}
      </span>
      <span className="sr-only">{entry.name}</span>
    </button>
  );
}

const noop = () => {};

/** 按项目经理的名字和项目名筛，不区分大小写，前后空格不算。 */
function matches(entry: ConversationEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || entry.name.toLowerCase().includes(q) || (entry.project?.name.toLowerCase().includes(q) ?? false);
}

/** 一台设备的组头：设备名 + 状态点 + 系统图标，点了折叠。离线的整组变灰。 */
function DeviceGroup({ group, open, onToggle, children }: { group: SidebarGroup; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section aria-label={group.name} data-device-status={group.status} className="pt-2 first:pt-0">
      <button
        type="button"
        aria-expanded={open}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-2xl px-3 text-left text-[13.5px] font-medium text-muted-foreground outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={onToggle}
      >
        <span className="truncate">{group.name}</span>
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} aria-hidden="true" />
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs font-normal">
          <StatusText status={group.status} lastOnlineAt={group.lastOnlineAt} />
          <StatusDot status={group.status} />
          <PlatformIcon platform={group.platform} className="size-3.5" />
        </span>
      </button>
      {open && <div className={cn("mt-1 space-y-1", isReadOnly(group.status) && "opacity-60")}>{children}</div>}
    </section>
  );
}

/**
 * 左栏：每个项目经理一行（头像、名字、最后一条消息），点进去就是它唯一的那个对话。
 * 两台以上设备时按设备分组（组头可以折叠），最上面一组汇总所有设备的“等你确定”，每行带设备名；只有一台时和没有联机时一模一样。
 * 窄屏（1100px 以下）收紧为常驻在左侧的 72px 垂直头像窄栏（docs/ui-standard.md 第 16 条）。
 */
export function Sidebar({
  groups,
  active,
  waiting,
  asking,
  notify,
  devices = null,
  quota,
  quotaFetchable = false,
  narrow: propNarrow,
  drawerOpen: _drawerOpen = false,
  onCloseDrawer: _onCloseDrawer = noop,
  onSelect,
  onNewPm,
}: {
  groups: SidebarGroup[];
  active: ConversationRef | null;
  /** 在“等你”的对话（devices.ts 的 conversationKey）。 */
  waiting: ReadonlySet<string>;
  /** 有“等你确定”的提问没回答的对话（同上）。 */
  asking: ReadonlySet<string>;
  notify: NotifySettings;
  /** 设置里的“设备”一组；null（守护进程还没有联机）不显示。 */
  devices?: DeviceSettings | null;
  quota: QuotaVendor[];
  /** 有厂商的额度要按需查（QuotaPopover 的 fetchable）。 */
  quotaFetchable?: boolean;
  narrow?: boolean;
  drawerOpen?: boolean;
  onCloseDrawer?: () => void;
  onSelect: (ref: ConversationRef) => void;
  onNewPm: () => void;
}) {
  const queryNarrow = useMediaQuery(NARROW_QUERY);
  const narrow = propNarrow ?? queryNarrow;
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<DeviceKey>>(new Set());
  const [archivedOpen, setArchivedOpen] = useState<ReadonlySet<DeviceKey>>(new Set());
  const grouped = groups.length > 1;

  const hasUnarchived = groups.some((g) => g.entries.some((e) => e.pm?.archivedAt == null));
  const narrowEntries = groups.flatMap((group) =>
    group.entries
      .filter((entry) => (hasUnarchived ? entry.pm?.archivedAt == null || (active !== null && active.device === group.key && active.id === entry.id) : true))
      .map((entry) => ({ group, entry })),
  );

  const row = (group: SidebarGroup, entry: ConversationEntry, device?: string) => {
    const key = conversationKey(group.key, entry.id);
    return (
      <EntryButton
        key={key}
        entry={entry}
        active={active !== null && active.device === group.key && active.id === entry.id}
        waiting={waiting.has(key)}
        asking={asking.has(key)}
        device={device}
        onSelect={() => onSelect({ device: group.key, id: entry.id })}
      />
    );
  };
  const renderGroupEntries = (group: SidebarGroup) => {
    const matched = group.entries.filter((entry) => matches(entry, query));
    const activeEntries = matched.filter((entry) => entry.pm?.archivedAt == null);
    const archivedEntries = matched.filter((entry) => entry.pm?.archivedAt != null);
    const activeInArchived = active !== null && active.device === group.key && archivedEntries.some((entry) => entry.id === active.id);
    const showArchived = archivedOpen.has(group.key) || query.trim() !== "" || activeInArchived;
    return (
      <>
        {activeEntries.map((entry) => row(group, entry))}
        {archivedEntries.length > 0 && (
          <div className="pt-1">
            <button
              type="button"
              aria-expanded={showArchived}
              className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-2xl px-3 text-left text-[13.5px] font-medium text-muted-foreground outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() =>
                setArchivedOpen((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(group.key)) next.add(group.key);
                  return next;
                })
              }
            >
              <span>已归档</span>
              <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", showArchived && "rotate-90")} aria-hidden="true" />
              <span className="ml-auto text-xs font-normal tabular-nums">{archivedEntries.length}</span>
            </button>
            {showArchived && <div className="mt-1 space-y-1">{archivedEntries.map((entry) => row(group, entry))}</div>}
          </div>
        )}
      </>
    );
  };
  // 跨设备的“等你确定”汇总（联机第 4.2 节）：只放提问，“等你”只在各组里标；按左栏的顺序
  const reminded = grouped
    ? groups.flatMap((group) => group.entries.filter((e) => matches(e, query) && asking.has(conversationKey(group.key, e.id))).map((entry) => ({ group, entry })))
    : [];

  return (
    <aside
      id="sidebar"
      aria-label="左栏"
      className={cn(
        "flex shrink-0 flex-col bg-sidebar pt-[calc(var(--safe-top)+var(--macos-traffic-lights-height))] pb-[var(--safe-bottom)]",
        narrow ? "w-[72px] border-r border-border" : "w-[300px]",
      )}
    >
      {narrow ? (
        <>
          <div data-window-drag className="h-3 shrink-0" />
          <nav
            className="sidebar-list flex flex-1 flex-col items-center gap-1.5 overflow-x-hidden overflow-y-auto overscroll-y-contain px-0 pt-1 pb-3"
            aria-label="对话列表"
          >
            {narrowEntries.map(({ group, entry }) => {
              const key = conversationKey(group.key, entry.id);
              return (
                <NarrowEntryButton
                  key={key}
                  entry={entry}
                  active={active !== null && active.device === group.key && active.id === entry.id}
                  waiting={waiting.has(key)}
                  asking={asking.has(key)}
                  onSelect={() => onSelect({ device: group.key, id: entry.id })}
                />
              );
            })}
          </nav>
          <div className="flex shrink-0 flex-col items-center gap-2 py-3">
            <Button variant="ghost" size="icon-sm" aria-label="新建项目经理" onClick={onNewPm}>
              <Plus aria-hidden="true" />
            </Button>
            <QuotaPopover quota={quota} fetchable={quotaFetchable} />
            <Button variant="ghost" size="icon-sm" aria-label="设置" onClick={() => setSettingsOpen(true)}>
              <Settings aria-hidden="true" />
            </Button>
          </div>
        </>
      ) : (
        <>
          <div
            data-window-drag
            className="relative flex h-16 shrink-0 items-center gap-2 px-3 before:absolute before:inset-x-0 before:bottom-full before:h-[calc(var(--safe-top)+var(--macos-traffic-lights-height))] before:content-['']"
          >
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
          <nav className={cn("sidebar-list flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 pt-1 pb-3", !grouped && "space-y-1")} aria-label="对话列表">
            {grouped ? (
              <>
                {reminded.length > 0 && (
                  <section aria-label="等你确定" className="mb-2">
                    <h2 className="flex h-8 items-center px-3 text-[13.5px] font-medium text-muted-foreground">等你确定</h2>
                    <div className="mt-1 space-y-1">
                      {/* 离线、没连上过的设备的条目和它组里一样变灰 */}
                      {reminded.map(({ group, entry }) => (
                        <div key={conversationKey(group.key, entry.id)} data-readonly={isReadOnly(group.status)} className={cn(isReadOnly(group.status) && "opacity-60")}>
                          {row(group, entry, group.name)}
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                {groups.map((group) => (
                  <DeviceGroup
                    key={group.key}
                    group={group}
                    open={!collapsed.has(group.key)}
                    onToggle={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (!next.delete(group.key)) next.add(group.key);
                        return next;
                      })
                    }
                  >
                    {renderGroupEntries(group)}
                  </DeviceGroup>
                ))}
              </>
            ) : (
              groups.map((group) => <Fragment key={group.key}>{renderGroupEntries(group)}</Fragment>)
            )}
          </nav>
          <div className="flex items-center gap-1 px-3 py-3">
            <QuotaPopover quota={quota} fetchable={quotaFetchable} />
            <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="设置" onClick={() => setSettingsOpen(true)}>
              <Settings aria-hidden="true" />
            </Button>
          </div>
        </>
      )}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} notify={notify} devices={devices} />
    </aside>
  );
}

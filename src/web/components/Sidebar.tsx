import { ChevronRight, Plus, Search, Settings, X } from "../ui/icons.ts";
import { Fragment, memo, useState, type ReactNode } from "react";
import { conversationKey, isReadOnly, type DeviceKey, type DeviceStatus } from "../devices.ts";
import { formatArchiveRemaining, formatTime, NEEDS_YOU, YOUR_TURN } from "../format.ts";
import type { ConversationRef, NotifySettings } from "../notify.ts";
import { previewText, type ConversationEntry, type QuotaVendor } from "../selectors.ts";
import { jellyStyleOf } from "../lib/palette.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { NARROW_QUERY, useMediaQuery } from "../useMediaQuery.ts";
import { Avatar } from "./Avatar.tsx";
import { PlatformIcon, StatusDot, StatusText } from "./DeviceBadges.tsx";
import { RouterAvatar } from "./RouterAvatar.tsx";
import { QuotaPopover } from "./QuotaPopover.tsx";
import { SettingsDialog, type DeviceSettings, type SettingsDialogSection } from "./SettingsDialog.tsx";

/**
 * 左栏的一行（docs/ui-standard.md 第 16 条）：每行一样高（标准档 72px），头像 48px 按身体光学居中，名字 17px 永远在第一行，
 * 第二行是预览（没有预览也留着这一行的高度）。总助行和项目经理行同一套尺寸。
 */
const ROW = "flex h-18 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const ROW_AVATAR = 48;
const ROW_NAME = "truncate text-title leading-snug font-semibold";
const ROW_PREVIEW = "mt-0.5 block truncate text-minor leading-snug text-muted-foreground";
/** 行的果冻底（docs/ui-standard.md 第 4 条）：选中、悬停是这个项目经理颜色的极淡底，颜色经 --jelly 交给 styles.css 的 bg-jelly。 */
const JELLY_ROW = (active: boolean) => (active ? "bg-jelly" : "hover:bg-jelly-hover");

// 窄栏头像右下角的绿点：外面一圈描边和它压着的底同色，选中的行压在果冻底上（10% 水果色盖在左栏底上）
const RAIL_DOT = "absolute right-0 bottom-0 size-2 rounded-full bg-status-active ring-2 ring-surface-sidebar";
const RAIL_DOT_ON_JELLY = "ring-[color-mix(in_srgb,var(--jelly)_10%,var(--color-surface-sidebar))]";
// 左栏里的小组头（设备、Archived）：同一套 12px 灰字，整行可点
const GROUP_HEADER =
  "flex h-8 w-full cursor-pointer items-center gap-2 rounded-2xl px-3 text-left text-xs font-medium text-muted-foreground outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-11";

export type SidebarLayout = "wide" | "rail" | "page";

/** 左栏置顶的总助（嫩芽铃）入口状态（docs/ui-standard.md 第 21 条）。 */
export interface SidebarRouterEntry {
  active: boolean;
  pendingCount: number;
  unreadReportCount: number;
  subtitle: string;
  /** 总助正在执行一条指令：嫩芽铃左右摇。 */
  working: boolean;
  onSelect: () => void;
}

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

function RouterRowButton({ router, active }: { router: SidebarRouterEntry; active: boolean }) {
  const badge =
    router.pendingCount > 0 ? (
      <span className="tool-badge shrink-0 px-1.5">
        <span className="text-xs font-semibold text-foreground tabular-nums">{router.pendingCount}</span>
        <span
          role="img"
          aria-label={NEEDS_YOU}
          title={NEEDS_YOU}
          data-testid="router-pending-indicator"
          className="size-2 rounded-full bg-status-active"
        />
      </span>
    ) : router.unreadReportCount > 0 ? (
      <span className="tool-badge px-1.5 text-xs text-muted-foreground tabular-nums">{router.unreadReportCount}</span>
    ) : null;

  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(ROW, active ? "bg-sidebar-active" : "hover:bg-sidebar-hover")}
      onClick={router.onSelect}
    >
      <RouterAvatar size={ROW_AVATAR} working={router.working} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center justify-between gap-2">
          <span className={ROW_NAME}>Router</span>
          {badge}
        </span>
        <span title={router.subtitle || undefined} className={ROW_PREVIEW}>
          {router.subtitle || "All clear"}
        </span>
      </span>
    </button>
  );
}

function NarrowRouterButton({ router, active }: { router: SidebarRouterEntry; active: boolean }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      title="Router"
      className={cn(
        "relative flex size-13 shrink-0 cursor-pointer items-center justify-center rounded-2xl transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active ? "bg-sidebar-active" : "hover:bg-sidebar-hover",
      )}
      onClick={router.onSelect}
    >
      <span className="relative">
        <RouterAvatar size={40} working={router.working} />
        {router.pendingCount > 0 && (
          <span
            role="img"
            aria-label={NEEDS_YOU}
            title={NEEDS_YOU}
            data-testid="router-pending-indicator"
            className="absolute right-0 bottom-0 size-2 rounded-full bg-status-active ring-2 ring-surface-sidebar"
          />
        )}
      </span>
      <span className="sr-only">Router</span>
    </button>
  );
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
  /** 项目经理用 hub ask 问了用户或有待决拍板，还没回答；比“等你”更醒目，两个都有时只显示它。 */
  asking: boolean;
  /** 名字后面标是哪台设备（需要区分同名条目时）。 */
  device?: string;
  onSelect: () => void;
}) {
  // 右边只放一个标注：已归档显示剩余删除天数；否则 等你确定圆点 > 等你圆点 > 时间（在忙不另加标记）。圆点不带字，名字只给读屏和悬停
  const tag =
    entry.pm?.archivedAt != null ? (
      <span className="text-xs text-muted-foreground tabular-nums">{formatArchiveRemaining(entry.pm.archivedAt)}</span>
    ) : asking ? (
      <span role="img" aria-label={NEEDS_YOU} title={NEEDS_YOU} data-testid="asking-indicator" className="size-2 rounded-full bg-status-active" />
    ) : waiting ? (
      <span role="img" aria-label={YOUR_TURN} title={YOUR_TURN} data-testid="waiting-indicator" className="size-2 shrink-0 rounded-full bg-status-active" />
    ) : entry.lastMessage ? (
      <span className="text-xs text-muted-foreground tabular-nums">{formatTime(entry.lastMessage.createdAt)}</span>
    ) : null;
  const preview = previewText(entry);
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      className={cn(ROW, JELLY_ROW(active))}
      style={jellyStyleOf(entry.look.color)}
      onClick={onSelect}
    >
      <Avatar look={entry.look} size={ROW_AVATAR} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
            <span title={entry.name} className={cn(ROW_NAME, device && "max-w-[70%] shrink-0")}>{entry.name}</span>
            {device && (
              <span data-testid="entry-device" title={device} className="min-w-0 truncate text-xs text-muted-foreground">
                {device}
              </span>
            )}
          </span>
          {tag && <span className="flex shrink-0 items-center">{tag}</span>}
        </span>
        {/* 没有预览也留着第二行：名字不挪到正中，和别的行的名字在一条线上 */}
        <span title={preview || undefined} aria-hidden={preview === "" ? true : undefined} className={ROW_PREVIEW}>
          {preview || "\u00a0"}
        </span>
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
        JELLY_ROW(active),
      )}
      style={jellyStyleOf(entry.look.color)}
      onClick={onSelect}
    >
      <span className="relative">
        <Avatar look={entry.look} size={40} />
        {asking ? (
          <span
            role="img"
            aria-label={NEEDS_YOU}
            title={NEEDS_YOU}
            data-testid="asking-indicator"
            className={cn(RAIL_DOT, active && RAIL_DOT_ON_JELLY)}
          />
        ) : waiting ? (
          <span
            role="img"
            aria-label={YOUR_TURN}
            title={YOUR_TURN}
            data-testid="waiting-indicator"
            className={cn(RAIL_DOT, active && RAIL_DOT_ON_JELLY)}
          />
        ) : null}
      </span>
      <span className="sr-only">{entry.name}</span>
    </button>
  );
}

/** 按项目经理的名字和项目名筛，不区分大小写，前后空格不算。 */
function matches(entry: ConversationEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || entry.name.toLowerCase().includes(q) || (entry.project?.name.toLowerCase().includes(q) ?? false);
}

/** 一台设备的组头：设备名 + 状态点 + 系统图标，点了折叠。离线的整组变灰。 */
function DeviceGroup({ group, open, onToggle, children }: { group: SidebarGroup; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section aria-label={group.name} data-device-status={group.status} className="pt-4 first:pt-0">
      <button
        type="button"
        aria-expanded={open}
        className={GROUP_HEADER}
        onClick={onToggle}
      >
        <span className="truncate">{group.name}</span>
        <ChevronRight className={cn("size-pixel-sm shrink-0 transition-transform", open && "rotate-90")} aria-hidden="true" />
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs font-normal">
          <StatusText status={group.status} lastOnlineAt={group.lastOnlineAt} />
          <StatusDot status={group.status} />
          <PlatformIcon platform={group.platform} />
        </span>
      </button>
      {/* 离线、没连上过的组只把头像调淡：字照常，调淡了对比度就不够（组头的 Offline 和灰点已经说明状态） */}
      {open && <div className={cn("mt-1 space-y-1", isReadOnly(group.status) && "[&_[data-slot=avatar]]:opacity-50")}>{children}</div>}
    </section>
  );
}

function sameDeviceSettings(a: DeviceSettings | null | undefined, b: DeviceSettings | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.tunnel !== b.tunnel || a.publicEntry !== b.publicEntry || a.repoDir !== b.repoDir || a.onChanged !== b.onChanged) return false;
  if (a.devices.length !== b.devices.length) return false;
  return a.devices.every((d, i) => {
    const o = b.devices[i]!;
    return d.key === o.key && d.info === o.info && d.status === o.status && (d.status !== "offline" || d.lastOnlineAt === o.lastOnlineAt);
  });
}

function sameRouterProp(a: SidebarRouterEntry | null | undefined, b: SidebarRouterEntry | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.active === b.active &&
    a.pendingCount === b.pendingCount &&
    a.unreadReportCount === b.unreadReportCount &&
    a.subtitle === b.subtitle &&
    a.working === b.working &&
    a.onSelect === b.onSelect
  );
}

/**
 * 左栏：顶部固定置顶嫩芽铃 Router 入口（跨设备待决与未读汇报总览），下方按设备分组展示项目经理对话。
 * layout 三档：wide 是 300px 宽栏，rail 是 72px 垂直头像窄栏（窄屏 1100px 以下，docs/ui-standard.md 第 16 条），page 是手机的整屏列表页（宽栏的内容、铺满、不显示选中）。
 */
export const Sidebar = memo(
  function Sidebar({
    groups,
    active: propActive,
    router = null,
    waiting,
    asking,
    notify,
    devices = null,
    quota,
    quotaFetchable = false,
    layout: propLayout,
    settingsOpen: propSettingsOpen,
    defaultSettingsSection,
    defaultProviderDevice,
    onSettingsOpenChange,
    onOpenSettings,
    onSelect,
    onNewPm,
  }: {
    groups: SidebarGroup[];
    active: ConversationRef | null;
    router?: SidebarRouterEntry | null;
    /** 在“等你”的对话（devices.ts 的 conversationKey）。 */
    waiting: ReadonlySet<string>;
    /** 有“等你确定”的提问或待决项没处理的对话（同上）。 */
    asking: ReadonlySet<string>;
    notify: NotifySettings;
    /** 设置里的“设备”一组；null（守护进程还没有联机）不显示。 */
    devices?: DeviceSettings | null;
    quota?: QuotaVendor[] | undefined;
    /** 有厂商的额度要按需查（QuotaPopover 的 fetchable）。 */
    quotaFetchable?: boolean;
    /** 外壳指定的布局。 */
    layout?: SidebarLayout;
    /** 桌面设置弹窗开关（跨断点从手机设置页拉宽切回桌面时受控打开）。 */
    settingsOpen?: boolean;
    defaultSettingsSection?: SettingsDialogSection;
    defaultProviderDevice?: DeviceKey;
    onSettingsOpenChange?: (open: boolean) => void;
    /** 手机整屏列表（layout === "page"）点设置齿轮跳到 #/settings，不挂 SettingsDialog。 */
    onOpenSettings?: () => void;
    onSelect: (ref: ConversationRef) => void;
    onNewPm: () => void;
  }) {
    const queryNarrow = useMediaQuery(NARROW_QUERY);
    const layout: SidebarLayout = propLayout ?? (queryNarrow ? "rail" : "wide");
    const narrow = layout === "rail";
    // 整屏列表页是“选一个进去”，不标选中；其余布局不变
    const active = layout === "page" ? null : propActive;
    const routerActive = layout === "page" ? false : Boolean(router?.active);
    const [query, setQuery] = useState("");
    const [internalSettingsOpen, setInternalSettingsOpen] = useState(false);
    const dialogOpen = propSettingsOpen ?? internalSettingsOpen;
    const setDialogOpen = onSettingsOpenChange ?? setInternalSettingsOpen;
    const handleOpenSettings = () => {
      if (layout === "page" && onOpenSettings) onOpenSettings();
      else setDialogOpen(true);
    };
    const [collapsed, setCollapsed] = useState<ReadonlySet<DeviceKey>>(new Set());
    const [archivedOpen, setArchivedOpen] = useState<ReadonlySet<DeviceKey>>(new Set());
    const grouped = groups.length > 1;
    const searching = query.trim() !== "";
    const anyMatch = groups.some((g) => g.entries.some((entry) => matches(entry, query)));
    // 搜索时置顶的 Router 也要对得上才留着，不然像是搜到了它
    const routerMatches = !searching || "router".includes(query.trim().toLowerCase());

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
                className={GROUP_HEADER}
                onClick={() =>
                  setArchivedOpen((prev) => {
                    const next = new Set(prev);
                    if (!next.delete(group.key)) next.add(group.key);
                    return next;
                  })
                }
              >
                <span>Archived</span>
                <ChevronRight className={cn("size-pixel-sm shrink-0 transition-transform", showArchived && "rotate-90")} aria-hidden="true" />
                <span className="ml-auto text-xs font-normal tabular-nums">{archivedEntries.length}</span>
              </button>
              {showArchived && <div className="mt-1 space-y-1">{archivedEntries.map((entry) => row(group, entry))}</div>}
            </div>
          )}
        </>
      );
    };

    return (
      <aside
        id="sidebar"
        aria-label="Sidebar"
        className={cn(
          "tint-fade flex shrink-0 flex-col bg-surface-sidebar pt-[calc(var(--safe-top)+var(--macos-traffic-lights-height))] pb-[var(--safe-bottom)]",
          layout === "rail" ? "w-18 border-r border-line" : layout === "page" ? "w-full" : "w-75",
        )}
      >
        {narrow ? (
          <>
            <div data-window-drag className="h-3 shrink-0" />
            {router && (
              <div className="flex shrink-0 flex-col items-center gap-2 pb-2">
                <NarrowRouterButton router={router} active={routerActive} />
                <div className="w-8 border-b border-line" aria-hidden="true" />
              </div>
            )}
            <nav
              className="sidebar-list flex flex-1 flex-col items-center gap-1.5 overflow-x-hidden overflow-y-auto overscroll-y-contain px-0 pt-3 pb-5"
              aria-label="Conversations"
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
              <Button variant="slot" size="icon" aria-label="New project manager" onClick={onNewPm}>
                <Plus aria-hidden="true" />
              </Button>
              {quota && <QuotaPopover quota={quota} fetchable={quotaFetchable} />}
              <Button variant="slot" size="icon" aria-label="Settings" onClick={handleOpenSettings}>
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
              {/* 搜索框的外形在这一层：放大镜、输入、清除键并排，清除键不压在输入框上 */}
              <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl bg-sidebar-active pr-0.5 pl-3 pointer-coarse:h-11">
                <Search className="size-pixel-sm shrink-0 text-muted-foreground" aria-hidden="true" />
                <Input
                  type="search"
                  aria-label="Search"
                  placeholder="Search"
                  className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 pointer-coarse:h-full"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {searching && (
                  <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Clear search" onClick={() => setQuery("")}>
                    <X aria-hidden="true" />
                  </Button>
                )}
              </div>
              <Button variant="slot" size="icon" className="shrink-0" aria-label="New project manager" onClick={onNewPm}>
                <Plus aria-hidden="true" />
              </Button>
            </div>
            {router && routerMatches && (
              <div className="shrink-0 px-3">
                <RouterRowButton router={router} active={routerActive} />
                <div className="mx-3 mt-2 border-b border-line" aria-hidden="true" />
              </div>
            )}
            <nav className={cn("sidebar-list flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 pt-3 pb-5", !grouped && "space-y-1")} aria-label="Conversations">
              {searching && !anyMatch && !routerMatches && <p className="flex h-9 items-center px-3 text-minor text-muted-foreground">No matching conversations</p>}
              {grouped
                ? groups.map((group) => (
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
                  ))
                : groups.map((group) => <Fragment key={group.key}>{renderGroupEntries(group)}</Fragment>)}
            </nav>
            <div className="flex items-center gap-1 px-3 py-3">
              {quota && <QuotaPopover quota={quota} fetchable={quotaFetchable} />}
              <Button variant="slot" size="icon" className="ml-auto" aria-label="Settings" onClick={handleOpenSettings}>
                <Settings aria-hidden="true" />
              </Button>
            </div>
          </>
        )}
        {layout !== "page" && (
          <SettingsDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            {...(defaultSettingsSection !== undefined ? { defaultSection: defaultSettingsSection } : {})}
            {...(defaultProviderDevice !== undefined ? { defaultProviderDevice } : {})}
            notify={notify}
            devices={devices}
          />
        )}
      </aside>
    );
  },
  (prev, next) =>
    prev.groups === next.groups &&
    prev.active === next.active &&
    sameRouterProp(prev.router, next.router) &&
    prev.waiting === next.waiting &&
    prev.asking === next.asking &&
    prev.notify === next.notify &&
    sameDeviceSettings(prev.devices, next.devices) &&
    prev.quota === next.quota &&
    prev.quotaFetchable === next.quotaFetchable &&
    prev.layout === next.layout &&
    prev.settingsOpen === next.settingsOpen &&
    prev.defaultSettingsSection === next.defaultSettingsSection &&
    prev.defaultProviderDevice === next.defaultProviderDevice &&
    prev.onSettingsOpenChange === next.onSettingsOpenChange &&
    prev.onOpenSettings === next.onOpenSettings &&
    prev.onSelect === next.onSelect &&
    prev.onNewPm === next.onNewPm,
);

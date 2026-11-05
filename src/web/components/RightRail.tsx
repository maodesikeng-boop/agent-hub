import { Bot, ChevronRight, MessageCircleQuestionMark, PanelRight, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_AGENT_VENDOR, effortLabel, isAgentVendor, modelShortLabel } from "../../shared/index.ts";
import type { ConversationId, Message, MessageId } from "../../shared/index.ts";
import { formatContext, formatTokenDetail, NO_DATA } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useModelCatalog } from "../models.tsx";
import { stripMarkdown } from "../plainText.ts";
import type { WorkerEntry } from "../selectors.ts";
import type { WorkerTone } from "../worker-status.ts";
import { Button } from "../ui/button.tsx";
import { Markdown } from "./Markdown.tsx";

/** 会话 activity → 状态词（英文，docs/ui-standard.md 第 12 条）。以后有新的 activity 只在这里加一行。 */
const ACTIVITY_TEXT: Readonly<Record<string, string>> = {
  working: "Working…",
  stopping: "Stopping…",
  preparing: "Setting up…",
  idle: "Idle",
};
/** 这几种算“在忙”（状态词和小圆点用主色，列表排在前面）：干活中、准备中（在跑项目的准备命令）；不认识的 activity 也当在忙。 */
const BUSY_ACTIVITIES: ReadonlySet<string> = new Set(["working", "preparing"]);
const UNKNOWN_ACTIVITY_TEXT = "Working…";
const ENDED_TEXT = "Ended";
/** 每组默认只列几条，多了出一行 Show more（照 Claude desktop 的右栏）。 */
export const RIGHT_RAIL_VISIBLE_ROWS = 3;

const statusText = (worker: WorkerEntry) => (worker.ended ? ENDED_TEXT : (ACTIVITY_TEXT[worker.activity] ?? UNKNOWN_ACTIVITY_TEXT));
const isBusy = (worker: WorkerEntry) => !worker.ended && (BUSY_ACTIVITIES.has(worker.activity) || !(worker.activity in ACTIVITY_TEXT));

export const RIGHT_RAIL_ID = "right-rail";

/**
 * 右栏的字号（第 12 条）：组标题 / 状态词 13px，行的名字、Show more、“已收工 N ›” 14px，第二行 13px（行高 18px）。图标 16px 线条（stroke 1.5）。
 * 行：左右 8px 内边距、负外边距，所以悬停底色比字宽一圈，字和组标题、分隔线对齐在同一条线上；一行单行 32px。
 */
const ROW = "flex w-[calc(100%+1rem)] cursor-pointer gap-3 -mx-2 rounded-xl px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const ROW_ICON = "size-4 shrink-0 text-muted-foreground";
const ICON_STROKE = 1.5;
/** 空闲 Worker 的小圆点颜色：跟着最近一次汇报（worker-status.ts 的 tone），和汇报气泡头像上的色点一样；没汇报是灰。 */
const TONE_DOT: Record<WorkerTone, string> = { success: "bg-success", warn: "bg-caution", danger: "bg-danger", neutral: "bg-muted-foreground/50" };

/** 每组的收起状态记在这个 localStorage 键里：{ asks?: true, workers?: true }，没写的是展开。 */
export const RIGHT_RAIL_COLLAPSED_KEY = "agent-hub.rightRail.collapsed";
type GroupKey = "asks" | "workers";
const readCollapsed = (): Partial<Record<GroupKey, true>> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RIGHT_RAIL_COLLAPSED_KEY) ?? "{}");
    if (parsed === null || typeof parsed !== "object") return {};
    const value = parsed as Record<string, unknown>;
    return { ...(value.asks === true && { asks: true as const }), ...(value.workers === true && { workers: true as const }) };
  } catch {
    return {};
  }
};
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (key: GroupKey) =>
    setCollapsed((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      try {
        if (Object.keys(next).length > 0) localStorage.setItem(RIGHT_RAIL_COLLAPSED_KEY, JSON.stringify(next));
        else localStorage.removeItem(RIGHT_RAIL_COLLAPSED_KEY);
      } catch {
        // 存不了（隐私模式、满了）：这次照样收起，只是刷新后不记得
      }
      return next;
    });
  return { collapsed, toggle };
}

/**
 * 组标题：整行是一个按钮（aria-expanded），点一下收起或展开这一组，标题后面一个小三角（展开朝下、收起朝右，照 Claude 右栏的 “Context ▸”）。
 * 收起时标题后面带这一组的个数（12px），还有几条没处理看得出来。和整栏的开关（RightRailToggle）是两回事。
 * trailing：同一行右边放的东西（并排的右栏里第一组放整栏的开关，这样顶上不多占一行）。
 */
function GroupTitle({ id, bodyId, children, count, collapsed, onToggle, dot = false, trailing }: { id: string; bodyId: string; children: React.ReactNode; count: number; collapsed: boolean; onToggle: () => void; dot?: boolean; trailing?: React.ReactNode }) {
  const title = (
    <h2 id={id} className={cn("h-8 text-[13px] font-normal text-foreground", trailing && "min-w-0 flex-1")}>
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        className="-mx-2 flex h-8 w-[calc(100%+1rem)] cursor-pointer items-center gap-2 rounded-xl px-2 text-left transition-colors outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={onToggle}
      >
        {dot && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />}
        {children}
        {collapsed && <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span>}
        <Play className={cn("size-2.5 shrink-0 fill-current text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", !collapsed && "rotate-90")} aria-hidden="true" />
      </button>
    </h2>
  );
  if (!trailing) return title;
  return (
    <div className="flex items-center gap-2">
      {title}
      {/* 开关的图标和收起时在顶栏右边的位置一样（右边 12px），点开关时不跳 */}
      <div className="-mr-2 shrink-0">{trailing}</div>
    </div>
  );
}

/** 一组的内容：收起时只剩标题。高度用网格行 0fr↔1fr 过渡（很短，不跳；减弱动效时关掉）；收起后 inert + aria-hidden，键盘和读屏都够不着。 */
function GroupBody({ id, collapsed, children }: { id: string; collapsed: boolean; children: React.ReactNode }) {
  return (
    <div
      id={id}
      data-group-body
      aria-hidden={collapsed || undefined}
      inert={collapsed}
      className={cn("grid transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none", collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]")}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** “Show more / Show less”，“已收工 N ›” 同一类：灰色小字、没有底色，悬停变前景色。 */
function MoreToggle({ expanded, onClick, children, ...rest }: { expanded: boolean; onClick: () => void; children: React.ReactNode } & React.AriaAttributes) {
  return (
    <button type="button" aria-expanded={expanded} className={cn(ROW, "h-8 items-center text-[14px] text-muted-foreground hover:bg-sidebar-hover hover:text-foreground")} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}

/** 一个提问一行：去掉 Markdown 的第一行；点开在下面看全文，同时让对话滚到那条消息。 */
function AskRow({ ask, open, onToggle }: { ask: Message; open: boolean; onToggle: () => void }) {
  const summary = ask.text.split("\n").map(stripMarkdown).find((line) => line !== "") ?? "";
  return (
    <li>
      <button type="button" aria-expanded={open} className={cn(ROW, "items-start", open ? "bg-sidebar" : "hover:bg-sidebar-hover")} onClick={onToggle}>
        <MessageCircleQuestionMark className={cn(ROW_ICON, "mt-0.5")} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[14px] leading-5">{summary}</span>
        <ChevronRight className={cn(ROW_ICON, "mt-0.5 size-3.5 transition-transform", open && "rotate-90")} aria-hidden="true" />
      </button>
      {open && (
        <div className="-mx-2 rounded-b-xl bg-sidebar px-2 pb-3 text-[13px]">
          <div className="pl-7">
            <Markdown text={ask.text} messageId={ask.id} />
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * 一个 Worker 一行（信息靠层次区分，不用符号拼接）：左边线条图标（右下角一个小色点表示状态：在忙强调色、空闲的跟着最近一次汇报的状态色、收工没有），
 * 第一行标题 + 右边英文状态词；第二行小一号灰字：模型、思考程度（有才显示）、现在的对话长度（“158K context”），之间用间距隔开。context 悬停看累计明细。收工的淡一些。
 */
function WorkerRow({ worker, active, onOpen }: { worker: WorkerEntry; active: boolean; onOpen: () => void }) {
  const vendor = isAgentVendor(worker.vendor) ? worker.vendor : DEFAULT_AGENT_VENDOR;
  const catalog = useModelCatalog(vendor);
  const busy = isBusy(worker);
  const context = formatContext(worker.usage);
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      className={cn(ROW, "items-start", active ? "bg-sidebar-active" : "hover:bg-sidebar-hover", worker.ended && "opacity-60")}
      onClick={onOpen}
    >
      <span className="relative mt-0.5 size-4 shrink-0">
        <Bot className={ROW_ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {!worker.ended && (
          <span
            data-testid="status-dot"
            className={cn("absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-background", busy ? "bg-primary" : TONE_DOT[worker.tone])}
            aria-hidden="true"
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[14px] leading-5">{worker.title}</span>
          <span className={cn("shrink-0 text-[13px]", busy ? "text-primary" : "text-muted-foreground")}>{statusText(worker)}</span>
        </span>
        <span data-testid="worker-meta" className="flex items-baseline gap-3 text-[13px] leading-[18px] text-muted-foreground">
          {worker.vendor !== undefined && <span className="min-w-0 truncate">{modelShortLabel(vendor, worker.model ?? null, catalog)}</span>}
          {worker.effort && <span className="shrink-0">{effortLabel(worker.effort)}</span>}
          {(context !== NO_DATA || (worker.vendor === undefined && !worker.effort)) && (
            <span className="shrink-0 tabular-nums" title={formatTokenDetail(worker.usage)}>
              {context}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

/** 右栏开关：ghost 图标按钮，右栏展开时在右栏第一组标题的同一行右边，收起（或太窄）时在顶栏右边；右栏没内容时不显示。收着、又有没回答的提问时右上角一个主色小圆点。 */
export function RightRailToggle({ visible, open, attention, onToggle }: { visible: boolean; open: boolean; attention: boolean; onToggle: () => void }) {
  if (!visible) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={open ? "收起右栏" : attention ? "展开右栏（有等你确定的事）" : "展开右栏"}
      aria-expanded={open}
      aria-controls={RIGHT_RAIL_ID}
      className={cn("relative shrink-0", open && "text-foreground")}
      onClick={onToggle}
    >
      <PanelRight aria-hidden="true" />
      {!open && attention && <span className="absolute top-2 right-2 size-1.5 rounded-full bg-primary" aria-hidden="true" />}
    </Button>
  );
}

/** 一组最多列 RIGHT_RAIL_VISIBLE_ROWS 条，多了出 Show more；mustShow 的那一项在被收起的里面时自动展开，保证看得见。 */
function useLimited<T>(items: readonly T[], mustShow: (item: T) => boolean) {
  const [expanded, setExpanded] = useState(false);
  const hiddenMustShow = items.slice(RIGHT_RAIL_VISIBLE_ROWS).some(mustShow);
  useEffect(() => {
    if (hiddenMustShow) setExpanded(true);
  }, [hiddenMustShow]);
  const limited = items.length > RIGHT_RAIL_VISIBLE_ROWS;
  return { shown: limited && !expanded ? items.slice(0, RIGHT_RAIL_VISIBLE_ROWS) : items, limited, expanded, toggle: () => setExpanded((v) => !v) };
}

function ShowMore({ limited, expanded, onToggle }: { limited: boolean; expanded: boolean; onToggle: () => void }) {
  if (!limited) return null;
  return (
    <MoreToggle expanded={expanded} onClick={onToggle}>
      {expanded ? "Show less" : "Show more"}
    </MoreToggle>
  );
}

/** 收工的 Worker 收成一行“已收工 N ›”（和 Show more 同一类），点开才展开（默认收着）；正开着的是收工的 Worker 时自动展开，当前那行看得见。 */
function EndedWorkers({ workers, openWorkerId, onOpenWorker }: { workers: WorkerEntry[]; openWorkerId: ConversationId | null; onOpenWorker: (id: ConversationId) => void }) {
  const [open, setOpen] = useState(false);
  const activeEnded = workers.some((w) => w.conversationId === openWorkerId);
  useEffect(() => {
    if (activeEnded) setOpen(true);
  }, [activeEnded, openWorkerId]);
  return (
    <>
      <MoreToggle expanded={open} onClick={() => setOpen((v) => !v)}>
        已收工 <span className="-ml-2 text-xs tabular-nums">{workers.length}</span>
        <ChevronRight className={cn("-ml-1.5 size-3.5 shrink-0 self-center transition-transform", open && "rotate-90")} aria-hidden="true" />
      </MoreToggle>
      {open && (
        <ul>
          {workers.map((worker) => (
            <li key={worker.conversationId}>
              <WorkerRow worker={worker} active={worker.conversationId === openWorkerId} onOpen={() => onOpenWorker(worker.conversationId)} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * 对话右边的右栏（docs/ui-standard.md 第 12 条，照 Claude desktop 的右栏）：只有两组，“等你确定”（这个项目经理还没回答的 hub ask）和 Worker
 * （它派的：在忙的排前面，最多列 3 条，多了 Show more；收工的收成最下面一行）。组之间一条细分隔线。layout：side 是和对话并排的一栏
 * （推开对话），右栏开关（toggle）放在第一组标题的同一行右边，内容从最顶上开始；top 是太窄时顶栏下面的一块，开关留在顶栏。
 */
export function RightRail({
  asks,
  workers,
  openWorkerId,
  layout,
  toggle,
  onOpenAsk,
  onOpenWorker,
}: {
  asks: Message[];
  workers: WorkerEntry[];
  /** 正开着的 Worker 的对话。 */
  openWorkerId: ConversationId | null;
  layout: "side" | "top";
  /** side：放在右栏顶部的开关（RightRailToggle）。 */
  toggle?: React.ReactNode;
  /** 点开一个提问：对话滚到那条消息。 */
  onOpenAsk: (messageId: MessageId) => void;
  onOpenWorker: (conversationId: ConversationId) => void;
}) {
  const [openAsks, setOpenAsks] = useState<ReadonlySet<MessageId>>(new Set());
  const toggleAsk = (id: MessageId) => {
    const opening = !openAsks.has(id);
    setOpenAsks((prev) => {
      const next = new Set(prev);
      if (opening) next.add(id);
      else next.delete(id);
      return next;
    });
    if (opening) onOpenAsk(id);
  };
  const live = useMemo(() => workers.filter((w) => !w.ended).toSorted((a, b) => Number(isBusy(b)) - Number(isBusy(a))), [workers]);
  const ended = workers.filter((w) => w.ended);
  const shownAsks = useLimited(asks, (ask) => openAsks.has(ask.id));
  const shownLive = useLimited(live, (w) => w.conversationId === openWorkerId);
  const groups = useCollapsedGroups();
  const side = layout === "side";
  return (
    <aside
      id={RIGHT_RAIL_ID}
      aria-label="右栏"
      className={cn("flex shrink-0 flex-col bg-background", side ? "w-[320px] border-l border-border" : "max-h-[40dvh] border-b border-border")}
    >
      <div className={cn("min-h-0 flex-1 divide-y divide-border overflow-y-auto px-5", side ? "pb-4" : "py-1")}>
        {asks.length > 0 && (
          <section aria-labelledby="rail-asks" className="py-3">
            <GroupTitle id="rail-asks" bodyId="rail-asks-body" count={asks.length} collapsed={groups.collapsed.asks === true} onToggle={() => groups.toggle("asks")} dot trailing={side ? toggle : undefined}>
              等你确定
            </GroupTitle>
            <GroupBody id="rail-asks-body" collapsed={groups.collapsed.asks === true}>
              <ul>
                {shownAsks.shown.map((ask) => (
                  <AskRow key={ask.id} ask={ask} open={openAsks.has(ask.id)} onToggle={() => toggleAsk(ask.id)} />
                ))}
              </ul>
              <ShowMore limited={shownAsks.limited} expanded={shownAsks.expanded} onToggle={shownAsks.toggle} />
            </GroupBody>
          </section>
        )}
        {workers.length > 0 && (
          <section aria-labelledby="rail-workers" className="py-3">
            <GroupTitle id="rail-workers" bodyId="rail-workers-body" count={live.length} collapsed={groups.collapsed.workers === true} onToggle={() => groups.toggle("workers")} trailing={side && asks.length === 0 ? toggle : undefined}>
              Worker
            </GroupTitle>
            <GroupBody id="rail-workers-body" collapsed={groups.collapsed.workers === true}>
              <ul>
                {shownLive.shown.map((worker) => (
                  <li key={worker.conversationId}>
                    <WorkerRow worker={worker} active={worker.conversationId === openWorkerId} onOpen={() => onOpenWorker(worker.conversationId)} />
                  </li>
                ))}
              </ul>
              <ShowMore limited={shownLive.limited} expanded={shownLive.expanded} onToggle={shownLive.toggle} />
              {ended.length > 0 && <EndedWorkers workers={ended} openWorkerId={openWorkerId} onOpenWorker={onOpenWorker} />}
            </GroupBody>
          </section>
        )}
      </div>
    </aside>
  );
}

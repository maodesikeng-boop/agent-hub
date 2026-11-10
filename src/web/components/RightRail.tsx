import { ChevronRight, MessageCircleQuestionMark } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_AGENT_VENDOR, agentEffortOf, isAgentVendor, modelShortLabel } from "../../shared/index.ts";
import type { ConversationId, Message, MessageId } from "../../shared/index.ts";
import { cleanPieceTitle, DEFAULT_CHOICE, formatContext, formatTokenDetail, NEEDS_YOU, NO_DATA } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useModelCatalog } from "../models.tsx";
import { stripMarkdown } from "../plainText.ts";
import type { WorkerEntry } from "../selectors.ts";
import type { WorkerTone } from "../worker-status.ts";
import { Button } from "../ui/button.tsx";
import { Avatar } from "./Avatar.tsx";
import { Markdown } from "./Markdown.tsx";

/**
 * 这几种算“在忙”（docs/ui-standard.md 第 12 条：行里不写状态词，在忙的标题字带流光，排在前面）：干活中、准备中（在跑项目的准备命令）、
 * 在等后台命令跑完；不认识的 activity 也当在忙。以后有新的 activity 只在这两处加。
 */
const BUSY_ACTIVITIES: ReadonlySet<string> = new Set(["working", "preparing", "background"]);
const IDLE_ACTIVITIES: ReadonlySet<string> = new Set(["stopping", "idle"]);
/** 每组默认只列几条，多了出一行 Show more（照 Claude desktop 的右栏）。 */
export const RIGHT_RAIL_VISIBLE_ROWS = 3;

const isBusy = (worker: WorkerEntry) => !worker.ended && (BUSY_ACTIVITIES.has(worker.activity) || !IDLE_ACTIVITIES.has(worker.activity));

const RIGHT_RAIL_ID = "right-rail";

/**
 * 右栏的字号和左栏、对话区同一套（第 3 条的 4 档）：组标题（Needs You、Pieces、Completed）12px 灰，行的名字 15px，Show more 13.5px。图标 16px 线条（stroke 1.5）。
 * 行：左右 10px 内边距、同样多的负外边距，所以悬停底色比字宽一圈，字和组标题、分隔线对齐在同一条线上；一行单行 36px，留出呼吸感。
 */
const ROW_BASE = "flex w-[calc(100%+1.25rem)] pointer-coarse:min-h-11 cursor-pointer -mx-2.5 rounded-xl px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const ROW = cn(ROW_BASE, "gap-3");
/** 列表项（提问、Piece）的悬停 / 选中底：当前项目经理水果色的极淡果冻底（styles.css 的 --color-jelly）。 */
const ITEM_HOVER = "hover:bg-jelly-hover";
const ITEM_SELECTED = "bg-jelly";
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
 * 组标题（Needs You、Pieces、Completed 三组一模一样）：12px 灰字，整行是一个按钮（aria-expanded），点一下收起或展开这一组，
 * 标题后面是普通箭头（ChevronRight）。不带个数。和整栏的开关（RightRailToggle）是两回事。
 * trailing：同一行右边放的东西（并排的右栏里第一组放整栏的开关，这样顶上不多占一行）。
 */
function GroupTitle({
  id,
  bodyId,
  children,
  collapsed,
  onToggle,
  dot = false,
  trailing,
}: {
  id: string;
  bodyId: string;
  children: React.ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  dot?: boolean;
  trailing?: React.ReactNode;
}) {
  const title = (
    <h2 id={id} className={cn("h-8 pointer-coarse:h-11 text-xs font-medium text-muted-foreground", trailing && "min-w-0 flex-1")}>
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        className="-mx-2.5 flex h-8 pointer-coarse:h-11 w-[calc(100%+1.25rem)] cursor-pointer items-center gap-2 rounded-xl px-2.5 text-left transition-colors outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={onToggle}
      >
        {dot && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />}
        {children}
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
            !collapsed && "rotate-90",
          )}
          aria-hidden="true"
        />
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
      {/* 高度过渡要 overflow-hidden；行向两边伸出 10px（ROW 的 -mx-2.5），键盘聚焦圈再 2px，所以这层也向两边多留 12px（-mx-3 px-3），圆角和圈才不会被剪成方的 */}
      <div className="-mx-3 min-h-0 overflow-hidden px-3">{children}</div>
    </div>
  );
}

/** “Show more / Show less”：灰色小字、没有底色，悬停变前景色。 */
function MoreToggle({ expanded, onClick, children, ...rest }: { expanded: boolean; onClick: () => void; children: React.ReactNode } & React.AriaAttributes) {
  return (
    <button type="button" aria-expanded={expanded} className={cn(ROW, "h-8 pointer-coarse:h-11 items-center text-minor text-muted-foreground hover:bg-sidebar-hover hover:text-foreground")} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}

/** 提问的第一行非空文字（去掉 Markdown）：找到就停，长提问不会每次渲染把每一行都跑一遍正则。 */
function askSummary(text: string): string {
  for (const line of text.split("\n")) {
    const plain = stripMarkdown(line);
    if (plain !== "") return plain;
  }
  return "";
}

/** 一个提问一行：去掉 Markdown 的第一行；点开在下面看全文，同时让对话滚到那条消息。 */
function AskRow({ ask, open, onToggle }: { ask: Message; open: boolean; onToggle: () => void }) {
  const summary = askSummary(ask.text);
  return (
    <li>
      <button type="button" aria-expanded={open} className={cn(ROW, "items-start", open ? "bg-sidebar" : ITEM_HOVER)} onClick={onToggle}>
        <MessageCircleQuestionMark className={cn(ROW_ICON, "mt-0.5")} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-body leading-5">{summary}</span>
        <ChevronRight className={cn(ROW_ICON, "mt-0.5 size-3.5 transition-transform", open && "rotate-90")} aria-hidden="true" />
      </button>
      {open && (
        <div className="-mx-2.5 rounded-b-xl bg-sidebar px-2.5 pb-3 text-minor">
          <div className="pl-7">
            <Markdown text={ask.text} messageId={ask.id} />
          </div>
        </div>
      )}
    </li>
  );
}

/** Piece 的模型、思考程度（有才有）、现在的对话长度（“158K context”，没记录是 null）：右栏行的悬停提示和 Piece 对话顶栏（PieceMeta）共用。 */
function usePieceMeta(worker: WorkerEntry): { model: string | null; effort: string | null; context: string | null } {
  const vendor = isAgentVendor(worker.vendor) ? worker.vendor : DEFAULT_AGENT_VENDOR;
  const catalog = useModelCatalog(vendor);
  const context = formatContext(worker.usage);
  // 老数据里 agy 的模型可能是带档位的完整 ID：档位从 ID 里取，和资料页一样显示成 模型 + 思考程度
  const model = worker.model ?? null;
  const effort = agentEffortOf(vendor, model, worker.effort ?? null);
  return {
    model: worker.vendor === undefined ? null : model === null ? (catalog.defaultModel ?? DEFAULT_CHOICE) : modelShortLabel(vendor, model, catalog),
    effort: effort || null,
    context: context !== NO_DATA ? context : null,
  };
}

/** Piece 对话顶栏右边的一行小字：模型、思考程度、对话长度，之间用间距隔开（不用符号拼接）；context 悬停看累计明细。都没有就不显示。 */
export function PieceMeta({ worker }: { worker: WorkerEntry }) {
  const { model, effort, context } = usePieceMeta(worker);
  if (model === null && effort === null && context === null) return null;
  return (
    <span data-testid="piece-meta" className="flex shrink-0 items-baseline gap-3 text-xs text-muted-foreground max-[720px]:hidden">
      {model !== null && <span>{model}</span>}
      {effort !== null && <span className="shrink-0">{effort}</span>}
      {context !== null && (
        <span className="shrink-0 tabular-nums" title={formatTokenDetail(worker.usage)}>
          {context}
        </span>
      )}
    </span>
  );
}

/**
 * 一个 Piece 一行（docs/ui-standard.md 第 12 条）：只有一行标题（去掉“界面：”这类分类前缀），不写状态词；在忙的标题字带流光（.status-shimmer，
 * 只挂在在忙的行上），其余静态，收工的淡一些。模型、思考程度、现在的对话长度不常驻显示，放进整行的悬停提示（title，第一行是完整标题），
 * 点进 Piece 的对话顶栏也能看到（PieceMeta）。
 */
function WorkerRow({ worker, active, onOpen }: { worker: WorkerEntry; active: boolean; onOpen: () => void }) {
  const meta = usePieceMeta(worker);
  const hint = [worker.title, meta.model, meta.effort, meta.context].filter((line): line is string => line !== null).join("\n");
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      aria-label={worker.title}
      title={hint}
      className={cn(ROW, "items-baseline", active ? ITEM_SELECTED : ITEM_HOVER)}
      onClick={onOpen}
    >
      {/* 收工的只把字调淡，选中的果冻底照样是完整的颜色 */}
      <span className={cn("min-w-0 truncate text-body leading-5", worker.ended && "opacity-60", isBusy(worker) && "status-shimmer")}>{cleanPieceTitle(worker.title)}</span>
    </button>
  );
}

/** 右栏开关：ghost 图标按钮，右栏展开时在右栏第一组标题的同一行右边，收起（或太窄）时在顶栏右边；右栏没内容时不显示。收着、又有没回答的提问时右上角一个主色小圆点。 */
export function RightRailToggle({
  visible,
  open,
  attention,
  avatarKey = 0,
  onToggle,
}: {
  visible: boolean;
  open: boolean;
  attention: boolean;
  avatarKey?: number;
  onToggle: () => void;
}) {
  if (!visible) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={open ? "Hide side panel" : attention ? "Show side panel (needs you)" : "Show side panel"}
      aria-expanded={open}
      aria-controls={RIGHT_RAIL_ID}
      className={cn("relative shrink-0", open && "text-foreground")}
      onClick={onToggle}
    >
      <Avatar colorKey={avatarKey} size={26} neutral />
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

/**
 * 收工的 Piece 单独一组 Completed（标题和 Needs You、Pieces 一样），默认收着（不记住）；正开着的是收工的 Piece 时自动展开，当前那行看得见。
 * 行里不写 Ended、不写状态词，标题字淡一些。
 */
function CompletedGroup({
  workers,
  openWorkerId,
  onOpenWorker,
  trailing,
}: {
  workers: WorkerEntry[];
  openWorkerId: ConversationId | null;
  onOpenWorker: (id: ConversationId) => void;
  trailing?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const activeEnded = workers.some((w) => w.conversationId === openWorkerId);
  useEffect(() => {
    if (activeEnded) setOpen(true);
  }, [activeEnded, openWorkerId]);
  return (
    <section aria-labelledby="rail-completed" className="tint-fade py-3">
      <GroupTitle id="rail-completed" bodyId="rail-completed-body" collapsed={!open} onToggle={() => setOpen((v) => !v)} trailing={trailing}>
        Completed
      </GroupTitle>
      {/* 已收工的会越来越多：收着时不挂载行（不跑每行的 usePieceMeta），点开才渲染 */}
      {open && (
        <GroupBody id="rail-completed-body" collapsed={false}>
          <ul>
            {workers.map((worker) => (
              <li key={worker.conversationId}>
                <WorkerRow worker={worker} active={worker.conversationId === openWorkerId} onOpen={() => onOpenWorker(worker.conversationId)} />
              </li>
            ))}
          </ul>
        </GroupBody>
      )}
    </section>
  );
}

/**
 * 对话右边的右栏（docs/ui-standard.md 第 12 条，照 Claude desktop 的右栏）：三组，Needs You（这个项目经理还没回答的 hub ask）、Pieces
 * （它派的、没收工的：在忙的排前面，最多列 3 条，多了 Show more）和 Completed（收工的，默认收着）。组之间一条细分隔线。layout：side 是和对话并排的一栏
 * （推开对话），右栏开关（toggle）放在第一组标题的同一行右边，内容从最顶上开始；top 是太窄时顶栏下面的一块，开关留在顶栏。
 */
export function RightRail({
  asks,
  workers,
  openWorkerId,
  layout,
  toggle,
  avatarKey = 0,
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
  /** 所属项目经理的水果颜色编号，用于显示 Worker 自然果瓣头像。 */
  avatarKey?: number;
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
      aria-label="Side panel"
      className={cn("tint-fade flex shrink-0 flex-col bg-surface-chat", side ? "w-80 border-l border-line" : "max-h-[40dvh] border-b border-line")}
    >
      <div className={cn("min-h-0 flex-1 divide-y divide-line overflow-x-hidden overflow-y-auto overscroll-y-contain px-5", side ? "pb-4" : "py-1")}>
        {asks.length > 0 && (
          <section aria-labelledby="rail-asks" className="tint-fade py-3">
            <GroupTitle
              id="rail-asks"
              bodyId="rail-asks-body"
              collapsed={groups.collapsed.asks === true}
              onToggle={() => groups.toggle("asks")}
              dot
              trailing={side ? toggle : undefined}
            >
              {NEEDS_YOU}
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
        {live.length > 0 && (
          <section aria-labelledby="rail-workers" className="tint-fade py-3">
            <GroupTitle
              id="rail-workers"
              bodyId="rail-workers-body"
              collapsed={groups.collapsed.workers === true}
              onToggle={() => groups.toggle("workers")}
              trailing={side && asks.length === 0 ? toggle : undefined}
            >
              Pieces
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
            </GroupBody>
          </section>
        )}
        {ended.length > 0 && (
          <CompletedGroup
            workers={ended}
            openWorkerId={openWorkerId}
            onOpenWorker={onOpenWorker}
            trailing={side && asks.length === 0 && live.length === 0 ? toggle : undefined}
          />
        )}
      </div>
    </aside>
  );
}

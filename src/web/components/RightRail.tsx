import { ChevronRight, PanelRight } from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULT_AGENT_VENDOR, effortLabel, isAgentVendor, modelShortLabel } from "../../shared/index.ts";
import type { ConversationId, Message, MessageId } from "../../shared/index.ts";
import { formatTokenDetail, formatUsageTotal } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useModelCatalog } from "../models.tsx";
import { stripMarkdown } from "../plainText.ts";
import type { WorkerEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import { Markdown } from "./Markdown.tsx";

/** 会话 activity → 状态词（英文，docs/ui-standard.md 第 12 条）。以后有新的 activity 只在这里加一行。 */
const ACTIVITY_TEXT: Readonly<Record<string, string>> = {
  working: "Working…",
  stopping: "Stopping…",
  preparing: "Setting up…",
  idle: "Idle",
};
/** 这几种用主色（在忙）：干活中、准备中（在跑项目的准备命令）。 */
const BUSY_ACTIVITIES: ReadonlySet<string> = new Set(["working", "preparing"]);
/** 不认识的 activity 当“在忙”显示。 */
const UNKNOWN_ACTIVITY_TEXT = "Working…";
const ENDED_TEXT = "Ended";

const statusText = (worker: WorkerEntry) => (worker.ended ? ENDED_TEXT : (ACTIVITY_TEXT[worker.activity] ?? UNKNOWN_ACTIVITY_TEXT));

export const RIGHT_RAIL_ID = "right-rail";

/** 列表行（第 13 条）：两组共用。 */
const ROW = "flex w-full cursor-pointer rounded-2xl px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

function GroupTitle({ id, children, count, dot = false }: { id: string; children: React.ReactNode; count: number; dot?: boolean }) {
  return (
    <h2 id={id} className="flex items-center gap-2 px-3 text-[13.5px] font-medium text-muted-foreground">
      {dot && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />}
      {children}
      <span className="text-xs font-normal tabular-nums">{count}</span>
    </h2>
  );
}

/** 一个提问一行：去掉 Markdown 的第一行；点开在下面看全文，同时让对话滚到那条消息。 */
function AskRow({ ask, open, onToggle }: { ask: Message; open: boolean; onToggle: () => void }) {
  const summary = ask.text.split("\n").map(stripMarkdown).find((line) => line !== "") ?? "";
  return (
    <li className={cn("rounded-2xl", open && "bg-sidebar")}>
      <button type="button" aria-expanded={open} className={cn(ROW, "items-center gap-2", !open && "hover:bg-sidebar-hover")} onClick={onToggle}>
        <span className="min-w-0 flex-1 truncate text-[15px]">{summary}</span>
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden="true" />
      </button>
      {open && (
        <div className="px-3 pb-3">
          <Markdown text={ask.text} messageId={ask.id} />
        </div>
      )}
    </li>
  );
}

/**
 * 一个 Worker 一行（信息靠层次区分，不用符号拼接）：第一行标题 + 右边状态词；第二行小一号灰字：模型、思考程度（有才显示）、token，
 * 之间用间距隔开。token 悬停看明细。收工的淡一些。
 */
function WorkerRow({ worker, active, onOpen }: { worker: WorkerEntry; active: boolean; onOpen: () => void }) {
  const vendor = isAgentVendor(worker.vendor) ? worker.vendor : DEFAULT_AGENT_VENDOR;
  const catalog = useModelCatalog(vendor);
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      className={cn(ROW, "flex-col", active ? "bg-sidebar-active" : "hover:bg-sidebar-hover", worker.ended && "opacity-60")}
      onClick={onOpen}
    >
      <span className="flex w-full items-baseline justify-between gap-3">
        <span className={cn("min-w-0 truncate text-[15px]", active ? "font-semibold" : "font-medium")}>{worker.title}</span>
        <span className={cn("shrink-0 text-xs", !worker.ended && BUSY_ACTIVITIES.has(worker.activity) ? "text-primary" : "text-muted-foreground")}>
          {statusText(worker)}
        </span>
      </span>
      <span className="flex w-full items-baseline gap-3 text-xs text-muted-foreground">
        {worker.vendor !== undefined && <span className="min-w-0 truncate">{modelShortLabel(vendor, worker.model ?? null, catalog)}</span>}
        {worker.effort && <span className="shrink-0">{effortLabel(worker.effort)}</span>}
        <span className="shrink-0 tabular-nums" title={formatTokenDetail(worker.usage)}>
          {formatUsageTotal(worker.usage)}
        </span>
      </span>
    </button>
  );
}

/** 右栏开关：ghost 图标按钮，右栏展开时在右栏顶部，收起（或太窄）时在顶栏右边；右栏没内容时不显示。收着、又有没回答的提问时右上角一个主色小圆点。 */
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

/** 收工的 Worker 收成一行“已收工 N ›”，点开才展开（默认收着）；正开着的是收工的 Worker 时自动展开，当前那行看得见。 */
function EndedWorkers({ workers, openWorkerId, onOpenWorker }: { workers: WorkerEntry[]; openWorkerId: ConversationId | null; onOpenWorker: (id: ConversationId) => void }) {
  const [open, setOpen] = useState(false);
  const activeEnded = workers.some((w) => w.conversationId === openWorkerId);
  useEffect(() => {
    if (activeEnded) setOpen(true);
  }, [activeEnded, openWorkerId]);
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        aria-expanded={open}
        className={cn(ROW, "items-center gap-2 text-[13.5px] text-muted-foreground hover:bg-sidebar-hover hover:text-foreground")}
        onClick={() => setOpen((v) => !v)}
      >
        已收工{" "}
        <span className="text-xs tabular-nums">{workers.length}</span>
        <ChevronRight className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} aria-hidden="true" />
      </button>
      {open && (
        <ul className="space-y-0.5">
          {workers.map((worker) => (
            <li key={worker.conversationId}>
              <WorkerRow worker={worker} active={worker.conversationId === openWorkerId} onOpen={() => onOpenWorker(worker.conversationId)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 对话右边的右栏（docs/ui-standard.md 第 12 条）：只有两组，“等你确定”（这个项目经理还没回答的 hub ask）和 Worker（它派的：
 * 干活的、等验收的列出来，收工的收成最下面一行）。layout：side 是和对话并排的一栏（推开对话），顶上放右栏开关（toggle）；
 * top 是太窄时顶栏下面的一块，开关留在顶栏。
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
  const live = workers.filter((w) => !w.ended);
  const ended = workers.filter((w) => w.ended);
  const side = layout === "side";
  return (
    <aside
      id={RIGHT_RAIL_ID}
      aria-label="右栏"
      className={cn("flex shrink-0 flex-col bg-background", side ? "w-[320px] border-l border-border" : "max-h-[40dvh] border-b border-border")}
    >
      {side && <div className="flex h-16 shrink-0 items-center justify-end px-3">{toggle}</div>}
      <div className={cn("flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3", side ? "pb-4" : "py-4")}>
        {asks.length > 0 && (
          <section aria-labelledby="rail-asks" className="flex flex-col gap-2">
            <GroupTitle id="rail-asks" count={asks.length} dot>
              等你确定
            </GroupTitle>
            <ul className="space-y-0.5">
              {asks.map((ask) => (
                <AskRow key={ask.id} ask={ask} open={openAsks.has(ask.id)} onToggle={() => toggleAsk(ask.id)} />
              ))}
            </ul>
          </section>
        )}
        {workers.length > 0 && (
          <section aria-labelledby="rail-workers" className="flex flex-col gap-2">
            <GroupTitle id="rail-workers" count={live.length}>
              Worker
            </GroupTitle>
            <ul className="space-y-0.5">
              {live.map((worker) => (
                <li key={worker.conversationId}>
                  <WorkerRow worker={worker} active={worker.conversationId === openWorkerId} onOpen={() => onOpenWorker(worker.conversationId)} />
                </li>
              ))}
            </ul>
            {ended.length > 0 && <EndedWorkers workers={ended} openWorkerId={openWorkerId} onOpenWorker={onOpenWorker} />}
          </section>
        )}
      </div>
    </aside>
  );
}

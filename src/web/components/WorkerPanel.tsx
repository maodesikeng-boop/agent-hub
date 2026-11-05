import { PanelRight } from "lucide-react";
import { DEFAULT_AGENT_VENDOR, effortLabel, isAgentVendor, modelLabel } from "../../shared/index.ts";
import type { ConversationId } from "../../shared/index.ts";
import { formatTokenDetail, formatUsageTotal } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useModelCatalog } from "../models.tsx";
import type { WorkerEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";

/** 会话 activity → 显示的字。以后有新的 activity（如 preparing）只在这里加一行。 */
const ACTIVITY_TEXT: Readonly<Record<string, string>> = {
  working: "干活中",
  stopping: "停止中",
  preparing: "准备中",
  idle: "空闲",
};
/** 这几种用主色（在忙）：干活中、准备中（在跑项目的准备命令）。 */
const BUSY_ACTIVITIES: ReadonlySet<string> = new Set(["working", "preparing"]);
/** 不认识的 activity 当“进行中”显示。 */
const UNKNOWN_ACTIVITY_TEXT = "进行中";
const ENDED_TEXT = "已收工";

const statusText = (worker: WorkerEntry) => (worker.ended ? ENDED_TEXT : (ACTIVITY_TEXT[worker.activity] ?? UNKNOWN_ACTIVITY_TEXT));

/** 窄屏（和左栏收窄同一个断点）：面板不再推开对话，改成浮在顶栏下面、右边，最高留出输入框的位置。 */
export const WORKER_PANEL_NARROW_QUERY = "(max-width: 1100px)";

/**
 * 一个 Worker 一行（信息靠层次区分，不用符号拼接）：第一行标题 + 右边状态；第二行小一号灰字：模型、思考程度（有才显示）、token，
 * 之间用间距隔开。token 悬停看明细。收工的淡一些。
 */
function WorkerRow({ worker, active, onOpen }: { worker: WorkerEntry; active: boolean; onOpen: () => void }) {
  const vendor = isAgentVendor(worker.vendor) ? worker.vendor : DEFAULT_AGENT_VENDOR;
  const catalog = useModelCatalog(vendor);
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full cursor-pointer flex-col rounded-2xl px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active ? "bg-sidebar-active" : "hover:bg-sidebar-hover",
        worker.ended && "opacity-60",
      )}
      onClick={onOpen}
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className={cn("min-w-0 truncate text-[15px]", active ? "font-semibold" : "font-medium")}>{worker.title}</span>
        <span className={cn("shrink-0 text-xs", !worker.ended && BUSY_ACTIVITIES.has(worker.activity) ? "text-primary" : "text-muted-foreground")}>
          {statusText(worker)}
        </span>
      </span>
      <span className="mt-0.5 flex items-baseline gap-3 text-xs text-muted-foreground">
        {worker.vendor !== undefined && <span className="min-w-0 truncate">{modelLabel(vendor, worker.model ?? null, catalog)}</span>}
        {worker.effort && <span className="shrink-0">{effortLabel(worker.effort)}</span>}
        <span className="shrink-0 tabular-nums" title={formatTokenDetail(worker.usage)}>
          {formatUsageTotal(worker.usage)}
        </span>
      </span>
    </button>
  );
}

/** 对话页顶栏右边的 Worker 按钮：列表图标 + 还没收工的个数，和顶栏别的图标按钮同一个样式；没有 Worker 不显示。 */
export function WorkerPanelToggle({ workers, open, onToggle }: { workers: WorkerEntry[]; open: boolean; onToggle: () => void }) {
  if (workers.length === 0) return null;
  const running = workers.filter((w) => !w.ended).length;
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Worker ${running}`}
      aria-expanded={open}
      aria-controls={WORKER_PANEL_ID}
      className={cn("ml-auto shrink-0 tabular-nums", open && "bg-accent text-foreground")}
      onClick={onToggle}
    >
      <PanelRight aria-hidden="true" />
      {running}
    </Button>
  );
}

const WORKER_PANEL_ID = "worker-panel";

/**
 * 对话右边的 Worker 面板（当前项目经理派的 Worker，进行中的在前、收工的在后）：展开时占一块地方、对话相应变窄；
 * 窄屏浮在顶栏下面。点一行打开那个 Worker 的对话，面板保持展开（窄屏会收起，不然盖着对话）。没有 Worker 或没展开就不渲染。
 */
export function WorkerSidePanel({
  workers,
  open,
  openId,
  onOpen,
  onClose,
}: {
  workers: WorkerEntry[];
  open: boolean;
  /** 正开着的 Worker 的对话。 */
  openId: ConversationId | null;
  onOpen: (conversationId: ConversationId) => void;
  onClose: () => void;
}) {
  if (!open || workers.length === 0) return null;
  return (
    <aside
      id={WORKER_PANEL_ID}
      aria-label="Worker"
      className="w-[320px] shrink-0 overflow-y-auto border-l border-border bg-background p-3 max-[1100px]:fixed max-[1100px]:top-16 max-[1100px]:right-3 max-[1100px]:z-20 max-[1100px]:max-h-[calc(100dvh-16rem)] max-[1100px]:w-[min(320px,calc(100vw-24px))] max-[1100px]:rounded-2xl max-[1100px]:border"
    >
      <ul className="space-y-1">
        {workers.map((worker) => (
          <li key={worker.conversationId}>
            <WorkerRow
              worker={worker}
              active={worker.conversationId === openId}
              onOpen={() => {
                if (window.matchMedia?.(WORKER_PANEL_NARROW_QUERY).matches) onClose();
                onOpen(worker.conversationId);
              }}
            />
          </li>
        ))}
      </ul>
    </aside>
  );
}

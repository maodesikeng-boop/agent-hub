import { useState } from "react";
import { DEFAULT_AGENT_VENDOR, effortLabel, isAgentVendor, modelLabel, vendorLabel } from "../../shared/index.ts";
import type { ConversationId } from "../../shared/index.ts";
import { formatTokenDetail, formatTokens } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useModelCatalog } from "../models.tsx";
import type { WorkerEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { SettingsGroup } from "./SettingsList.tsx";

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

/** 一个 Worker 一行：标题、状态；下面是厂商 · 模型 · 思考程度，右边是消耗的 token（悬停看明细）。 */
function WorkerRow({ worker, active, onOpen }: { worker: WorkerEntry; active: boolean; onOpen: () => void }) {
  const vendor = isAgentVendor(worker.vendor) ? worker.vendor : DEFAULT_AGENT_VENDOR;
  const catalog = useModelCatalog(vendor);
  const agent =
    worker.vendor === undefined
      ? ""
      : [vendorLabel(worker.vendor), modelLabel(vendor, worker.model ?? null, catalog), ...(worker.effort ? [`思考 ${effortLabel(worker.effort)}`] : [])].join(" · ");
  const { input, cacheRead, cacheWrite, output } = worker.usage;
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full cursor-pointer flex-col px-4 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
        active ? "bg-sidebar-active" : "hover:bg-sidebar-hover",
        worker.ended && "opacity-60",
      )}
      onClick={onOpen}
    >
      <span className="flex items-baseline justify-between gap-4">
        <span className={cn("min-w-0 truncate text-[15px]", active ? "font-semibold" : "font-medium")}>{worker.title}</span>
        <span className={cn("shrink-0 text-[13.5px]", !worker.ended && BUSY_ACTIVITIES.has(worker.activity) ? "text-primary" : "text-muted-foreground")}>
          {statusText(worker)}
        </span>
      </span>
      <span className="mt-0.5 flex items-baseline justify-between gap-4 text-[13.5px] text-muted-foreground">
        <span className="min-w-0 truncate">{agent}</span>
        <span className="shrink-0 tabular-nums" title={formatTokenDetail(worker.usage)}>
          {formatTokens(input + cacheRead + cacheWrite + output)}
        </span>
      </span>
    </button>
  );
}

/**
 * 对话页顶栏右边的“Worker 3”按钮（数字是还没收工的个数）：点开是当前项目经理派的 Worker 列表（进行中的在前，收工的在后），
 * 点一行打开那个 Worker 的对话并收起；再点按钮、点外面、按 Esc 也收起。没有 Worker 整个不显示。
 */
export function WorkerPanel({
  workers,
  openId,
  onOpen,
}: {
  workers: WorkerEntry[];
  /** 正开着的 Worker 的对话。 */
  openId: ConversationId | null;
  onOpen: (conversationId: ConversationId) => void;
}) {
  const [open, setOpen] = useState(false);
  if (workers.length === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" className="ml-auto shrink-0 bg-sidebar-active hover:bg-sidebar-hover">
          Worker {workers.filter((w) => !w.ended).length}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Worker" className="max-h-[min(70vh,480px)] w-[360px] max-w-[calc(100vw-24px)] overflow-y-auto">
        <SettingsGroup>
          {workers.map((worker) => (
            <WorkerRow
              key={worker.conversationId}
              worker={worker}
              active={worker.conversationId === openId}
              onOpen={() => {
                setOpen(false);
                onOpen(worker.conversationId);
              }}
            />
          ))}
        </SettingsGroup>
      </PopoverContent>
    </Popover>
  );
}

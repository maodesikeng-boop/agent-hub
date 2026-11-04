import { PanelRightOpen, X } from "lucide-react";
import { useState } from "react";
import type { ConversationId } from "../../shared/index.ts";
import { cn } from "../lib/utils.ts";
import type { WorkerEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";

/** 会话 activity → 显示的字。以后有新的 activity（如 preparing）只在这里加一行。 */
const ACTIVITY_TEXT: Readonly<Record<string, string>> = {
  working: "干活中",
  stopping: "停止中",
  preparing: "准备中",
  idle: "空闲",
};
/** 不认识的 activity 当“进行中”显示。 */
const UNKNOWN_ACTIVITY_TEXT = "进行中";
const ENDED_TEXT = "已收工";

const statusText = (worker: WorkerEntry) => (worker.ended ? ENDED_TEXT : (ACTIVITY_TEXT[worker.activity] ?? UNKNOWN_ACTIVITY_TEXT));

/**
 * 页面右侧的窄边栏：当前项目经理派的 Worker，点一行打开那个 Worker 的对话。没有 Worker 整个不显示。
 * 窄屏（1100px 以下）收起，右边缘有按钮展开，盖在对话上面。
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
  const [expanded, setExpanded] = useState(false);
  if (workers.length === 0) return null;
  return (
    <>
      <Button
        variant="secondary"
        size="icon-sm"
        aria-label="展开 Worker 列表"
        className={cn("absolute top-3 right-3 z-10 hidden bg-sidebar-active hover:bg-sidebar-hover", !expanded && "max-[1100px]:flex")}
        onClick={() => setExpanded(true)}
      >
        <PanelRightOpen aria-hidden="true" />
      </Button>
      <aside
        aria-label="Worker"
        className={cn(
          "flex w-[240px] shrink-0 flex-col bg-sidebar",
          "max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-20 max-[1100px]:border-l max-[1100px]:border-border",
          !expanded && "max-[1100px]:hidden",
        )}
      >
        <div className="flex h-16 shrink-0 items-center justify-between px-5">
          <span className="text-[17px] font-semibold tracking-tight">Worker</span>
          <Button variant="ghost" size="icon-sm" aria-label="收起 Worker 列表" className="hidden max-[1100px]:inline-flex" onClick={() => setExpanded(false)}>
            <X aria-hidden="true" />
          </Button>
        </div>
        <ul className="flex-1 space-y-1 overflow-y-auto px-3 pt-1 pb-3">
          {workers.map((worker) => {
            const active = worker.conversationId === openId;
            return (
              <li key={worker.conversationId}>
                <button
                  type="button"
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex w-full cursor-pointer flex-col gap-0.5 rounded-2xl px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    active ? "bg-sidebar-active" : "hover:bg-sidebar-hover",
                    worker.ended && "opacity-60",
                  )}
                  onClick={() => {
                    setExpanded(false);
                    onOpen(worker.conversationId);
                  }}
                >
                  <span className={cn("truncate text-[15px]", active ? "font-semibold" : "font-medium")}>{worker.title}</span>
                  <span className={cn("text-[13.5px]", !worker.ended && worker.activity === "working" ? "text-primary" : "text-muted-foreground")}>
                    {statusText(worker)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
    </>
  );
}

// /hub:worker 选的厂商、模型、思考程度显示成的小标签（docs/ui-standard.md 第 17、18 条）：
// 输入框里那个能点、能去掉（Composer.tsx），用户气泡上方那个只读（Messages.tsx），里面的图标和几项是同一份。
import { Bot } from "lucide-react";
import { useMemo } from "react";
import type { WorkerPick } from "../../shared/index.ts";
import { cn } from "../lib/utils.ts";
import { useModelCatalogs } from "../models.tsx";
import { workerPickLabels } from "../worker-pick.ts";

/** 标签上的几项（厂商名、模型名、思考程度）。名单只读缓存（和输入框列表同一份），不为它发请求，没拉到用打包的。 */
export function useWorkerPickLabels(pick: WorkerPick): string[] {
  const catalogs = useModelCatalogs(false);
  return useMemo(() => workerPickLabels(pick, catalogs), [pick.vendor, pick.model, pick.effort, catalogs]);
}

/** Bot 图标 + 几项，gap-2 隔开，不用 “·”。 */
export function WorkerPickParts({ labels }: { labels: readonly string[] }) {
  return (
    <>
      <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      {labels.map((label, i) => (
        <span key={i} className="min-w-0 truncate">
          {label}
        </span>
      ))}
    </>
  );
}

/** 用户气泡上方的只读标签：没有 ×、不能点。 */
export function WorkerPickTag({ pick, className }: { pick: WorkerPick; className?: string }) {
  const labels = useWorkerPickLabels(pick);
  return (
    <div role="group" aria-label="Worker model" className={cn("flex max-w-full items-center gap-2 rounded-full bg-muted px-3 py-1 text-minor", className)}>
      <WorkerPickParts labels={labels} />
    </div>
  );
}

import { Bot } from "../ui/icons.ts";
import { useMemo } from "react";
import type { WorkerPick } from "../../shared/index.ts";
import { cn } from "../lib/utils.ts";
import { useModelCatalogs } from "../models.tsx";
import { workerPickLabels } from "../worker-pick.ts";

export function useWorkerPickLabels(pick: WorkerPick): string[] {
  const catalogs = useModelCatalogs(false);
  return useMemo(() => workerPickLabels(pick, catalogs), [pick.vendor, pick.model, pick.effort, catalogs]);
}

export function WorkerPickParts({ labels, inComposer = false }: { labels: readonly string[]; inComposer?: boolean }) {
  return (
    <>
      <Bot className={cn("shrink-0 text-muted-foreground", inComposer ? "size-4" : "size-pixel-sm")} aria-hidden="true" />
      {labels.map((label, i) => (
        <span key={i} className="min-w-0 truncate">
          {label}
        </span>
      ))}
    </>
  );
}

export function WorkerPickTag({ pick, className }: { pick: WorkerPick; className?: string }) {
  const labels = useWorkerPickLabels(pick);
  return (
    <div role="group" aria-label="Worker model" className={cn("flex max-w-full items-center gap-2 rounded-sm border border-border bg-panel px-3 py-1 text-minor", className)}>
      <WorkerPickParts labels={labels} />
    </div>
  );
}

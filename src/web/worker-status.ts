import { WORKER_REPORT_STATUS_LABELS, type WorkerMessageMeta } from "../shared/index.ts";

export type WorkerTone = "success" | "warn" | "danger" | "neutral";

export function workerStatusOf(line: WorkerMessageMeta): { tone: WorkerTone; label: string | null } {
  if (line.event === "turn_failed" || line.event === "worktree_failed") return { tone: "danger", label: "Error" };
  switch (line.status) {
    case "done":
      return { tone: "success", label: WORKER_REPORT_STATUS_LABELS.done };
    case "problem":
      return { tone: "warn", label: WORKER_REPORT_STATUS_LABELS.problem };
    case "gave_up":
      return { tone: "danger", label: WORKER_REPORT_STATUS_LABELS.gave_up };
    default:
      return { tone: "neutral", label: null };
  }
}

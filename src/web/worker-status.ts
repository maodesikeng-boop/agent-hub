import type { WorkerMessageMeta } from "../shared/index.ts";

export type WorkerTone = "success" | "warn" | "danger" | "neutral";

const REPORT_LABELS: Readonly<Record<"done" | "problem" | "gave_up", string>> = {
  done: "Done",
  problem: "Problem",
  gave_up: "Gave up",
};

export function workerStatusOf(line: WorkerMessageMeta): { tone: WorkerTone; label: string | null } {
  if (line.event === "turn_failed" || line.event === "worktree_failed") return { tone: "danger", label: "Error" };
  switch (line.status) {
    case "done":
      return { tone: "success", label: REPORT_LABELS.done };
    case "problem":
      return { tone: "warn", label: REPORT_LABELS.problem };
    case "gave_up":
      return { tone: "danger", label: REPORT_LABELS.gave_up };
    default:
      return { tone: "neutral", label: null };
  }
}

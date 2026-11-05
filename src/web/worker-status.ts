// Worker 汇报的状态：对应哪种颜色、悬停和读屏说的字。项目经理对话里的汇报（Messages.tsx，头像右下角的色点）用它；
// 颜色全是 styles.css 的变量，docs/ui-standard.md 第 17 条。
import { WORKER_REPORT_STATUS_LABELS, type WorkerMessageMeta } from "../shared/index.ts";

/** 做完了偏绿、有问题偏黄、放弃了和出错偏红；没按格式的、没有状态的是中性灰。 */
export type WorkerTone = "success" | "warn" | "danger" | "neutral";

export function workerStatusOf(line: WorkerMessageMeta): { tone: WorkerTone; label: string | null } {
  if (line.event === "turn_failed" || line.event === "worktree_failed") return { tone: "danger", label: "出错" };
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

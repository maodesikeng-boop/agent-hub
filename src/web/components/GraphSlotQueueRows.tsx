import { memo } from "react";
import type { TaskNodeKey } from "../../shared/index.ts";
import type { SlotQueueRow } from "../work-status.ts";
import { WorkStatusIcon } from "./WorkStatusIcon.tsx";

export const GraphSlotQueueRows = memo(function GraphSlotQueueRows({
  rows,
  onOpenStep,
}: {
  rows: readonly SlotQueueRow[];
  onOpenStep: (key: TaskNodeKey) => void;
}) {
  return (
    <ul className="mt-2">
      {rows.map((row) => (
        <li key={row.key}>
          <button
            type="button"
            data-slot-queue={row.key}
            aria-label={`${row.title}, ${row.text}`}
            title={row.text}
            onClick={() => onOpenStep(row.key)}
            className="work-worker-row min-h-6.5 py-1 pointer-coarse:min-h-11"
          >
            <WorkStatusIcon status="pending" />
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-left">
              <span className="max-w-full truncate text-minor font-medium">{row.title}</span>
              <span className="max-w-full min-w-0 truncate text-xs text-muted-foreground">{row.text}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
});

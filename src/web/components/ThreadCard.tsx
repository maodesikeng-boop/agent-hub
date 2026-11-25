import type * as React from "react";
import type { AgentVendor, ConversationId, WorkerMessageMeta } from "../../shared/index.ts";
import { describeFailure } from "../../shared/errors.ts";
import type { SlimeLook } from "../../shared/slimes.ts";
import { ChevronRight } from "../ui/icons.ts";
import { cleanPieceTitle, formatTime } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { workerStatusOf, type WorkerTone } from "../worker-status.ts";
import { Avatar } from "./Avatar.tsx";

export interface ThreadCardProps {
  /** A report, turn_failed, or worktree_failed Worker event. */
  line: WorkerMessageMeta;
  /** The owning PM's look; the card's note sprite takes its color. */
  look: SlimeLook;
  /** The Worker is open in the side panel. */
  open: boolean;
  /** Message creation timestamp in epoch ms when available. */
  createdAt?: number;
  vendor?: AgentVendor;
  onOpen: (workerConversationId: ConversationId) => void;
}

const TONE_SQUARE: Record<Exclude<WorkerTone, "neutral">, string> = {
  success: "bg-success",
  warn: "bg-caution",
  danger: "bg-danger",
};

/**
 * Postcondition: renders one compact row with the note sprite and its status dot in the agent header's avatar column, the
 * cleaned Piece title, the report time, and a right chevron; the accessible name adds the status word and the first report
 * line (describeFailure text for failures); the open row takes the open fill.
 */
export function ThreadCard({ line, look, open, createdAt, vendor, onOpen }: ThreadCardProps): React.ReactElement {
  const { tone, label } = workerStatusOf(line);
  const failed = line.event !== "report";
  const summary = line.summary?.trim() ?? "";
  const body = failed && summary !== "" ? describeFailure(summary, { unknown: "raw", vendor }) : null;
  const fullText = body ? body.text : summary;
  const firstLine = fullText.split(/\r?\n/, 1)[0] ?? "";
  const cleanTitle = cleanPieceTitle(line.title);
  const ariaLabel = [cleanTitle, label, firstLine].filter(Boolean).join(", ");

  return (
    <article className="mt-4 flex flex-col items-start" data-side="left" data-worker-report data-tone={tone} data-open={open ? "" : undefined}>
      <button
        type="button"
        data-bubble
        aria-label={ariaLabel}
        className={cn(
          "group touch-target flex w-full cursor-pointer items-center gap-2 rounded-sm py-1 pr-3.5 text-left text-minor transition-colors outline-none focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-1 motion-reduce:transition-none pointer-coarse:min-h-11",
          open ? "bg-open" : "hover:bg-hover",
        )}
        onClick={() => onOpen(line.workerConversationId)}
      >
        <span className="relative flex shrink-0">
          <Avatar look={look} neutral size={26} />
          {tone !== "neutral" && (
            <span
              data-dot={tone}
              aria-hidden="true"
              className={cn("absolute -right-1 -bottom-0.5 size-2.5 rounded-full", open ? "shadow-[0_0_0_2px_var(--open)]" : "shadow-[0_0_0_2px_var(--background)] group-hover:shadow-[0_0_0_2px_var(--hover)]", TONE_SQUARE[tone])}
            />
          )}
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5 leading-5">
          <span className="min-w-0 truncate text-foreground" title={cleanTitle}>
            {cleanTitle}
          </span>
          {createdAt !== undefined && <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{formatTime(createdAt)}</span>}
        </div>
        <ChevronRight className="size-pixel-sm shrink-0 self-center text-muted-foreground" aria-hidden="true" />
      </button>
    </article>
  );
}

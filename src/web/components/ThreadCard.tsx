import type * as React from "react";
import type { AgentVendor, ConversationId, WorkerMessageMeta } from "../../shared/index.ts";
import { describeFailure } from "../../shared/errors.ts";
import type { SlimeLook } from "../../shared/slimes.ts";
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
 * Postcondition: renders one button-like card with the note sprite and status square, the cleaned Piece title, the
 * status word from workerStatusOf, the report time, and the report's first line truncated with its full text in title;
 * failures show describeFailure text; the open card uses the open fill and outline.
 */
export function ThreadCard({ line, look, open, createdAt, vendor, onOpen }: ThreadCardProps): React.ReactElement {
  const { tone, label } = workerStatusOf(line);
  const failed = line.event !== "report";
  const summary = line.summary?.trim() ?? "";
  const body = failed && summary !== "" ? describeFailure(summary, { unknown: "raw", vendor }) : null;
  const fullText = body ? body.text : summary;
  const firstLine = fullText.split(/\r?\n/, 1)[0] ?? "";
  const rawTitle = body ? body.raw : summary;
  const cleanTitle = cleanPieceTitle(line.title);
  const ariaLabel = [cleanTitle, label, firstLine].filter(Boolean).join(", ");

  return (
    <article className="mt-4 flex flex-col items-start" data-side="left" data-worker-report data-tone={tone} data-open={open ? "" : undefined}>
      <button
        type="button"
        data-bubble
        aria-label={ariaLabel}
        className={cn(
          "w-full max-w-136 cursor-pointer border-2 px-3.5 py-2.5 text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px]",
          open ? "border-open-line bg-open" : "border-border-strong bg-background hover:bg-hover",
        )}
        onClick={() => onOpen(line.workerConversationId)}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar look={look} neutral size={24} className="shrink-0" />
          {tone !== "neutral" && <span data-dot={tone} aria-hidden="true" className={cn("size-2 shrink-0", TONE_SQUARE[tone])} />}
          <span className="min-w-0 flex-1 truncate text-body font-semibold text-foreground" title={cleanTitle}>
            {cleanTitle}
          </span>
          {label && <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span>}
          {createdAt !== undefined && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatTime(createdAt)}</span>}
        </div>
        {firstLine !== "" && (
          <p className="mt-1 truncate text-minor text-muted-foreground" title={rawTitle !== "" ? rawTitle : undefined}>
            {firstLine}
          </p>
        )}
      </button>
    </article>
  );
}

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

const TONE_LABEL: Record<WorkerTone, string> = {
  neutral: "text-muted-foreground",
  success: "text-success",
  warn: "text-warn-foreground",
  danger: "text-danger",
};

/**
 * Postcondition: renders one button-like card with the note sprite and status square anchored at its corner, the cleaned
 * Piece title, the tone-colored status word, the report time, the indented first report line truncated with its full
 * text in title, and a right chevron; failures show describeFailure text; the open card uses the open fill and outline.
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
          "flex w-full max-w-136 cursor-pointer items-start gap-3 border-2 px-3 py-2.5 text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px]",
          open ? "border-open-line bg-open" : "border-border-strong bg-background hover:bg-hover",
        )}
        onClick={() => onOpen(line.workerConversationId)}
      >
        <span className="relative mt-0.5 shrink-0">
          <Avatar look={look} neutral size={24} />
          {tone !== "neutral" && (
            <span
              data-dot={tone}
              aria-hidden="true"
              className={cn("absolute -right-1 -bottom-0.5 size-2.5 border-2", open ? "border-open" : "border-background", TONE_SQUARE[tone])}
            />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <span className="min-w-0 truncate text-body font-medium text-foreground" title={cleanTitle}>
              {cleanTitle}
            </span>
            {label && <span className={cn("shrink-0 text-xs font-medium", TONE_LABEL[tone])}>{label}</span>}
            {createdAt !== undefined && <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{formatTime(createdAt)}</span>}
          </div>
          {firstLine !== "" && (
            <p className="mt-0.5 truncate text-minor text-muted-foreground" title={rawTitle !== "" ? rawTitle : undefined}>
              {firstLine}
            </p>
          )}
        </div>
        <ChevronRight className="size-pixel-sm shrink-0 self-center text-muted-foreground" aria-hidden="true" />
      </button>
    </article>
  );
}

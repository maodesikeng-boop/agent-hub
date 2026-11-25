import { useState } from "react";
import type * as React from "react";
import { isAgentVendor, type ModelCatalog, type SessionState } from "../../shared/index.ts";
import { cn } from "../lib/utils.ts";
import type { WorkerEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import { MoreHorizontal } from "../ui/icons.ts";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import type { WorkStatus } from "../work-status.ts";
import { formatModelSummary } from "./InfoTab.tsx";
import { WorkPanelDetailHeader } from "./WorkPanel.tsx";
import { WorkStatusIcon } from "./WorkStatusIcon.tsx";

export interface WorkerMenuFacts {
  /** `Opus 5.5 Max`, or null when unknown. */
  model: string | null;
  /** `12m`, or null before the Worker starts. */
  duration: string | null;
  branch: string | null;
  readonly?: boolean;
}

export interface WorkerDetailHeaderProps {
  title: string;
  status: WorkStatus;
  facts: WorkerMenuFacts;
  /** Null hides Stop (nothing running). */
  onStop: (() => void) | null;
  /** Null hides End (already ended or read-only). */
  onEnd: (() => void) | null;
  onBack: () => void;
  backLabel: string;
  /** Omitted on full-screen phone pages where Back is the sole exit. */
  onClose?: () => void;
}

export function formatWorkerDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${totalMinutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function workerMenuFactsOf({
  worker,
  session,
  createdAt,
  endedAt,
  branch,
  readonly,
  catalog,
  now,
}: {
  worker: WorkerEntry | undefined;
  session: SessionState | null;
  createdAt: number | null;
  endedAt: number | null;
  branch: string | null;
  readonly?: boolean;
  catalog: ModelCatalog | null;
  now: number;
}): WorkerMenuFacts {
  const vendor = worker?.vendor ?? session?.vendor;
  const rawModel = worker?.model ?? session?.model ?? null;
  const rawEffort = worker?.effort ?? session?.effort ?? null;
  const model =
    isAgentVendor(vendor) && catalog !== null && (rawModel !== null || rawEffort !== null || catalog.defaultModel !== null)
      ? formatModelSummary({ vendor, model: rawModel, effort: rawEffort }, catalog)
      : null;
  const endRef = worker?.ended ? (endedAt ?? session?.lastEventAt ?? null) : now;
  const duration = createdAt !== null && endRef !== null ? formatWorkerDuration(endRef - createdAt) : null;
  const isReadonly = readonly === true;
  return {
    model,
    duration,
    branch: branch ?? worker?.branch ?? null,
    ...(isReadonly ? { readonly: true } : {}),
  };
}

/**
 * Postcondition: back arrow, status icon, title, a `⋯` popover holding model and effort, duration, branch, Stop, and
 * End, then Close; no meta line under the header. The body below is the existing WorkerConversation, whose message list
 * and composer are the main chat's.
 */
export function WorkerDetailHeader({
  title,
  status,
  facts,
  onStop,
  onEnd,
  onBack,
  backLabel,
  onClose,
}: WorkerDetailHeaderProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const hasFacts = facts.model !== null || facts.duration !== null || facts.branch !== null || facts.readonly === true;
  const hasActions = onStop !== null || onEnd !== null;

  return (
    <WorkPanelDetailHeader
      title={
        <div className="flex min-w-0 items-center gap-2">
          <WorkStatusIcon status={status} />
          <h1 title={title} className="min-w-0 truncate text-minor font-semibold text-foreground">
            {title}
          </h1>
        </div>
      }
      backLabel={backLabel}
      onBack={onBack}
      {...(onClose !== undefined ? { onClose } : {})}
      actions={
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="work-panel-close shrink-0"
              aria-label="More worker actions"
              title="More worker actions"
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-60 p-0">
            {hasFacts && (
              <dl className="grid grid-cols-1 gap-1.5 px-3 py-2.5 text-xs">
                {facts.model !== null && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">Model</dt>
                    <dd title={facts.model} className="min-w-0 truncate font-medium text-foreground">
                      {facts.model}
                    </dd>
                  </div>
                )}
                {facts.duration !== null && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">Duration</dt>
                    <dd className="shrink-0 text-foreground tabular-nums">{facts.duration}</dd>
                  </div>
                )}
                {facts.branch !== null && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">Branch</dt>
                    <dd title={facts.branch} className="min-w-0 truncate font-mono text-foreground">
                      {facts.branch}
                    </dd>
                  </div>
                )}
                {facts.readonly === true && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">Access</dt>
                    <dd className="shrink-0 text-foreground">Read-only</dd>
                  </div>
                )}
              </dl>
            )}
            {hasActions && (
              <div className={cn("p-1.5", hasFacts && "border-t border-border")}>
                {onStop !== null && (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onStop();
                    }}
                    className="flex min-h-8 pointer-coarse:min-h-11 w-full cursor-pointer items-center rounded-xs px-2.5 py-1.5 text-left text-minor font-medium text-foreground transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus"
                  >
                    Stop
                  </button>
                )}
                {onEnd !== null && (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onEnd();
                    }}
                    className="flex min-h-8 pointer-coarse:min-h-11 w-full cursor-pointer items-center rounded-xs px-2.5 py-1.5 text-left text-minor font-medium text-danger transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus"
                  >
                    End
                  </button>
                )}
              </div>
            )}
            {!hasFacts && !hasActions && <p className="px-3 py-2.5 text-xs text-muted-foreground">No details available</p>}
          </PopoverContent>
        </Popover>
      }
    />
  );
}

import { memo, useEffect, useState } from "react";
import { systemNoticeText, workerEventOf, type ChecklistStatus, type Message, type WorkerMessageMeta } from "../../shared/index.ts";
import { workerLineParts } from "../format.ts";
import type { WorkStatus } from "../work-status.ts";
import { WorkStatusIcon } from "./WorkStatusIcon.tsx";
import { cn } from "../lib/utils.ts";
import { ACTION_ELAPSED_TICK_MS } from "../limits.ts";
import { formatDuration, workedFor } from "../step-labels.ts";
import type { ChecklistStepView, TurnProgressModel } from "../turn-progress.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { ChevronRight } from "../ui/icons.ts";
import type { MessageActions } from "./Messages.tsx";

// Invariant: a turn shows exactly one progress block, in the slot above its reply text, and only one elapsed time.

const SECONDARY = "text-minor text-muted-foreground";
const TEXT_BUTTON = "touch-target cursor-pointer transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus";
const CHEVRON_CLS = "size-pixel-sm shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-90 motion-reduce:transition-none";
const STATUS_LABEL: Readonly<Record<ChecklistStatus, string>> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export interface TurnProgressProps {
  progress: TurnProgressModel;
  /** Live action text from AgentStatus while the turn runs; null once the turn ended. */
  status: React.ReactNode | null;
  /** Start of the shown action in epoch ms; null hides the live time. */
  stepStartedAt: number | null;
  workedForMs: number | null;
  showDuration?: boolean;
  onOpenWorker: MessageActions["onOpenWorker"];
}

function WorkerLineButton({ line, onOpen }: { line: WorkerMessageMeta; onOpen: MessageActions["onOpenWorker"] }) {
  const { title, state, detail } = workerLineParts(line);
  return (
    <button
      type="button"
      aria-label={[title, state, detail].filter((part) => part !== "").join(" ")}
      className={cn(TEXT_BUTTON, "inline-flex flex-wrap gap-x-2 text-left [overflow-wrap:anywhere]")}
      onClick={() => onOpen(line.workerConversationId)}
    >
      <span className="text-foreground">{title}</span>
      <span>{state}</span>
      {detail !== "" && <span>{detail}</span>}
    </button>
  );
}

function WorkStep({ message, onOpenWorker }: { message: Message; onOpenWorker: MessageActions["onOpenWorker"] }) {
  const line = workerEventOf(message);
  if (line) {
    return (
      <li>
        <WorkerLineButton line={line} onOpen={onOpenWorker} />
      </li>
    );
  }
  if (message.sender === "system") return <li className="[overflow-wrap:anywhere]">{systemNoticeText(message)}</li>;
  return <li className="font-mono [overflow-wrap:anywhere]">{message.text}</li>;
}

function ProcessList({ work, onOpenWorker, className }: { work: readonly Message[]; onOpenWorker: MessageActions["onOpenWorker"]; className?: string }) {
  return (
    <ul className={cn("space-y-1 text-xs leading-relaxed text-muted-foreground", className)} data-progress-process>
      {work.map((m) => (
        <WorkStep key={m.id} message={m} onOpenWorker={onOpenWorker} />
      ))}
    </ul>
  );
}

const CHECKLIST_WORK_STATUS = {
  completed: "done",
  in_progress: "running",
  pending: "pending",
  cancelled: "cancelled",
} satisfies Record<ChecklistStatus, WorkStatus>;

export function ChecklistStatusIcon({ status }: { status: ChecklistStatus }) {
  return <WorkStatusIcon status={CHECKLIST_WORK_STATUS[status]} className="turn-progress-icon rounded-full" />;
}

/** Ticks every ACTION_ELAPSED_TICK_MS and formats now - startedAt with formatDuration; stops ticking on unmount. */
export function ActionElapsed({ startedAt }: { startedAt: number }): React.ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ACTION_ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [startedAt]);
  return (
    <span className="shrink-0 tabular-nums" data-action-elapsed>
      {formatDuration(now - startedAt)}
    </span>
  );
}

function ChecklistRow({ step, running, onOpenWorker }: { step: ChecklistStepView; running: boolean; onOpenWorker: MessageActions["onOpenWorker"] }) {
  const [open, setOpen] = useState(false);
  const { item, process } = step;
  const label = running && item.status === "in_progress" ? (item.activeTitle ?? item.title) : item.title;
  const tone = item.status === "in_progress" ? "font-semibold text-foreground" : item.status === "completed" ? "turn-progress-done" : "turn-progress-muted";
  const title = (
    <span className="min-w-0 [overflow-wrap:anywhere]">
      {label}<span className="sr-only">, {STATUS_LABEL[item.status]}</span>
    </span>
  );
  const expandable = !running && process.length > 0;
  if (!expandable) {
    return (
      <li className="turn-progress-item" data-checklist-item={item.id} data-status={item.status}>
        <div className={cn("turn-progress-row", tone)}>
          <ChecklistStatusIcon status={item.status} />
          {title}
        </div>
      </li>
    );
  }
  return (
    <li className="turn-progress-item" data-checklist-item={item.id} data-status={item.status}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className={cn(
            "group/step turn-progress-row turn-progress-step-trigger w-fit max-w-full min-w-11 cursor-pointer rounded-sm text-left transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus",
            tone,
          )}
        >
          <ChecklistStatusIcon status={item.status} />
          {title}
          <ChevronRight
            className="mt-1 size-pixel-sm shrink-0 text-muted-foreground opacity-55 transition-transform duration-200 group-hover/step:opacity-100 group-data-[state=open]/step:rotate-90 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ProcessList work={process} onOpenWorker={onOpenWorker} className="turn-progress-step-process pt-0.5 pb-1.5" />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function Checklist({
  steps,
  running,
  onOpenWorker,
  className,
}: {
  steps: readonly ChecklistStepView[];
  running: boolean;
  onOpenWorker: MessageActions["onOpenWorker"];
  className?: string;
}) {
  return (
    <ol className={cn("turn-progress-list", className)} data-checklist data-ended={running ? undefined : ""}>
      {steps.map((step) => (
        <ChecklistRow key={step.item.id} step={step} running={running} onOpenWorker={onOpenWorker} />
      ))}
    </ol>
  );
}

/**
 * Running: the checklist rows (when steps exist, with no row chevrons) joined by a rail, then one action line with the
 * live time; the action-line chevron opens the in-progress step's process below the action line (or all work when the
 * turn has no steps).
 * Ended: one `Worked for` line; activating it opens the checklist below the line with each step's last reported status
 * verbatim, and each step row opens its own process. A turn without steps opens the flat process log instead, as before.
 */
export const TurnProgress = memo(function TurnProgress({ progress, status, stepStartedAt, workedForMs, showDuration, onOpenWorker }: TurnProgressProps): React.ReactNode {
  const [actionOpen, setActionOpen] = useState(false);
  const [endedOpen, setEndedOpen] = useState(false);
  const steps = progress.steps;
  const hasSteps = steps !== null && steps.length > 0;

  if (workedForMs === null || status !== null) {
    const runningProcess = hasSteps ? (steps.find((s) => s.item.status === "in_progress")?.process ?? []) : progress.unassigned;
    return (
      <div className="flex flex-col" data-turn-progress="running">
        {hasSteps && <Checklist steps={steps} running onOpenWorker={onOpenWorker} className="mb-1.5" />}
        {status === null ? null : runningProcess.length > 0 ? (
          <Collapsible open={actionOpen} onOpenChange={setActionOpen} className={SECONDARY} data-work-line>
            <CollapsibleTrigger className={cn("group inline-flex max-w-full items-center gap-2 text-left", TEXT_BUTTON, SECONDARY)}>
              <span className="min-w-0 [overflow-wrap:anywhere]">{status}</span>
              {stepStartedAt !== null && <ActionElapsed startedAt={stepStartedAt} />}
              <ChevronRight className={CHEVRON_CLS} aria-hidden="true" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ProcessList work={runningProcess} onOpenWorker={onOpenWorker} className="mt-1.5 mb-1 border-l border-border pl-3" />
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <div className={cn("inline-flex max-w-full items-center gap-2", SECONDARY)} data-work-line>
            <span className="min-w-0 [overflow-wrap:anywhere]">{status}</span>
            {stepStartedAt !== null && <ActionElapsed startedAt={stepStartedAt} />}
          </div>
        )}
      </div>
    );
  }

  if (!hasSteps && progress.unassigned.length === 0) {
    return showDuration ? <div className={cn(SECONDARY, "tabular-nums")} data-turn-progress="ended">{workedFor(workedForMs)}</div> : null;
  }

  return (
    <div className="flex flex-col" data-turn-progress="ended">
      <Collapsible open={endedOpen} onOpenChange={setEndedOpen} className={SECONDARY} data-work-line>
        <CollapsibleTrigger className={cn("group inline-flex max-w-full items-center gap-1.5 text-left tabular-nums", TEXT_BUTTON, SECONDARY)}>
          <span>{workedFor(workedForMs)}</span>
          <ChevronRight className={CHEVRON_CLS} aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          {hasSteps ? (
            <Checklist steps={steps} running={false} onOpenWorker={onOpenWorker} className="mt-1" />
          ) : (
            <ProcessList work={progress.unassigned} onOpenWorker={onOpenWorker} className="mt-1.5 mb-1 border-l border-border pl-3" />
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
});

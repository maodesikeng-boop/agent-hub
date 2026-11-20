import { ArrowUp } from "../ui/icons.ts";
import { memo } from "react";
import type { ConversationId } from "../../shared/index.ts";
import { cleanOptionLabel, recommendedIndexOf } from "../decision-actions.ts";
import { formatTime, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import type { FleetDecisionEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { DeviceScopeOf } from "../device-scope.tsx";
import { Avatar } from "./Avatar.tsx";
import { CardBody } from "./Deliverables.tsx";
import { OptionRow } from "./OptionRow.tsx";
import { RowError } from "./SettingsList.tsx";

export interface RouterDecisionCardProps {
  entry: FleetDecisionEntry;
  multiDevice: boolean;
  busy: boolean;
  note: string;
  error: ErrorLike | null;
  onNoteChange: (key: string, value: string) => void;
  onSubmit: (entry: FleetDecisionEntry, optionIndex: number | null, note: string) => void;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
}

export const RouterDecisionCard = memo(function RouterDecisionCard({
  entry,
  multiDevice,
  busy,
  note,
  error,
  onNoteChange,
  onSubmit,
  onOpenConversation,
}: RouterDecisionCardProps) {
  const { decision, online } = entry;
  const recommendedIdx = recommendedIndexOf(decision);
  const disabled = !online || busy;
  const canSendCustom = !disabled && note.trim().length > 0;
  const showProject = decision.projectName !== null && decision.projectName !== decision.pmName;
  const showDevice = multiDevice || !entry.self;
  const blockedCount = decision.source.kind === "gate" ? decision.source.blockedNodeCount : 0;

  return (
    <article
      aria-label={decision.question}
      className={cn("rounded-2xl border border-border bg-background p-4", !online && "[&_[data-slot=avatar]]:opacity-50")}
    >
      <div className="flex flex-wrap items-center gap-2 text-minor">
        <button
          type="button"
          className="touch-target inline-flex cursor-pointer items-center gap-2 rounded-full text-left font-semibold text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => onOpenConversation(entry.deviceKey, decision.conversationId)}
        >
          <Avatar look={entry.look} size={24} />
          <span className="truncate">{decision.pmName}</span>
        </button>
        {showProject && <span className="truncate text-muted-foreground">{decision.projectName}</span>}
        {showDevice && <span className="truncate text-xs text-muted-foreground">{entry.deviceName}</span>}
        {!online && (
          <span className="rounded-full bg-sidebar px-2 py-0.5 text-xs font-medium text-muted-foreground">Offline</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{formatTime(decision.createdAt)}</span>
      </div>

      <h3 className="mt-2.5 text-body font-medium text-foreground">{decision.question}</h3>
      <DeviceScopeOf deviceKey={entry.deviceKey}>
        <CardBody
          key={decision.key}
          text={decision.context}
          deliverables={decision.deliverables}
          extra={
            blockedCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {blockedCount === 1 ? "1 downstream step waiting" : `${blockedCount} downstream steps waiting`}
              </p>
            )
          }
          className="mt-1"
          textClassName="text-minor text-muted-foreground"
        />
      </DeviceScopeOf>

      {decision.options.length > 0 && (
        <div className="mt-3 space-y-2">
          {decision.options.map((rawOption, idx) => {
            const label = cleanOptionLabel(rawOption);
            const isRecommended = idx === recommendedIdx;
            return (
              <OptionRow key={`${decision.key}-opt-${idx}`} index={idx} disabled={disabled} recommended={isRecommended} onClick={() => onSubmit(entry, idx, note)}>
                {label}
              </OptionRow>
            );
          })}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        <Input
          value={note}
          disabled={disabled}
          aria-label="Note or custom reply"
          placeholder="Add a note, or type a custom reply…"
          className="min-w-0 flex-1"
          onChange={(e) => onNoteChange(decision.key, e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            if (canSendCustom) onSubmit(entry, null, note);
          }}
        />
        <Button
          size="icon"
          aria-label="Send reply"
          disabled={!canSendCustom}
          onClick={() => onSubmit(entry, null, note)}
        >
          <ArrowUp className="size-pixel" aria-hidden="true" />
        </Button>
      </div>

      {error && (
        <div className="mt-2">
          <RowError error={error} />
        </div>
      )}
    </article>
  );
});

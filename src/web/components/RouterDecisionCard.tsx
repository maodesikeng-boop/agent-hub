import { memo } from "react";
import type { ConversationId } from "../../shared/index.ts";
import { cleanOptionLabel, recommendedIndexOf } from "../decision-actions.ts";
import { getDecisionDraft, routerDecisionDraftKey, useDecisionDraft } from "../decision-drafts.ts";
import { formatTime, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import type { FleetDecisionEntry } from "../selectors.ts";
import { DeviceScopeOf } from "../device-scope.tsx";
import { Avatar } from "./Avatar.tsx";
import { CardBody, CardNoteForm } from "./Deliverables.tsx";
import { OPTION_LIST, OptionRow } from "./OptionRow.tsx";
import { RowError } from "./SettingsList.tsx";

export interface RouterDecisionCardProps {
  entry: FleetDecisionEntry;
  multiDevice: boolean;
  busy: boolean;
  error: ErrorLike | null;
  onNoteFocus: (decisionKey: string) => void;
  onNoteChange: (decisionKey: string, draftKey: string, value: string) => void;
  onSubmit: (entry: FleetDecisionEntry, optionIndex: number | null, note: string) => void;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
}

export const RouterDecisionCard = memo(function RouterDecisionCard({
  entry,
  multiDevice,
  busy,
  error,
  onNoteFocus,
  onNoteChange,
  onSubmit,
  onOpenConversation,
}: RouterDecisionCardProps) {
  const { decision, online } = entry;
  const draftKey = routerDecisionDraftKey(entry.deviceId, decision);
  const note = useDecisionDraft(draftKey);
  const recommendedIdx = recommendedIndexOf(decision);
  const disabled = !online || busy;
  const showProject = decision.projectName !== null && decision.projectName !== decision.pmName;
  const showDevice = multiDevice || !entry.self;
  const blockedCount = decision.source.kind === "gate" ? decision.source.blockedNodeCount : 0;

  return (
    <article
      aria-label={decision.question}
      className={cn("overflow-hidden rounded-sm border border-border bg-background p-4", !online && "[&_[data-slot=avatar]]:opacity-50")}
    >
      <div className="flex flex-wrap items-center gap-2 text-minor">
        <button
          type="button"
          className="touch-target inline-flex cursor-pointer items-center gap-2 text-left font-semibold text-foreground outline-none hover:underline focus-visible:outline-2 focus-visible:outline-border-focus"
          onClick={() => onOpenConversation(entry.deviceKey, decision.conversationId)}
        >
          <Avatar look={entry.look} size={24} />
          <span className="truncate">{decision.pmName}</span>
        </button>
        {showProject && <span className="truncate text-muted-foreground">{decision.projectName}</span>}
        {showDevice && <span className="truncate text-xs text-muted-foreground">{entry.deviceName}</span>}
        {!online && (
          <span className="rounded-sm bg-panel px-2 py-0.5 text-xs font-medium text-muted-foreground">Offline</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{formatTime(decision.createdAt)}</span>
      </div>

      <h3 className="mt-2.5 text-body font-medium text-foreground">{decision.question}</h3>
      <DeviceScopeOf deviceKey={entry.deviceKey}>
        <CardBody
          key={decision.key}
          text={decision.context}
          titleText={decision.question}
          deliverables={decision.deliverables}
          extra={
            blockedCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {blockedCount === 1 ? "1 downstream step waiting" : `${blockedCount} downstream steps waiting`}
              </p>
            )
          }
          className="mt-2"
          textClassName="text-body leading-relaxed text-foreground"
        />
      </DeviceScopeOf>

      {decision.options.length > 0 && (
        <div className={OPTION_LIST} role="group" aria-label="Options">
          {decision.options.map((rawOption, idx) => {
            const label = cleanOptionLabel(rawOption);
            const isRecommended = idx === recommendedIdx;
            return (
              <OptionRow
                key={`${decision.key}-opt-${idx}`}
                index={idx}
                disabled={disabled}
                recommended={isRecommended}
                onClick={() => onSubmit(entry, idx, getDecisionDraft(draftKey))}
              >
                {label}
              </OptionRow>
            );
          })}
        </div>
      )}

      {error && (
        <div className="my-2">
          <RowError error={error} />
        </div>
      )}

      <CardNoteForm
        key={draftKey}
        variant="row"
        value={note}
        onFocus={() => onNoteFocus(decision.key)}
        onChange={(next) => onNoteChange(decision.key, draftKey, next)}
        disabled={disabled}
        pending={busy}
        onSubmitNote={(raw) => onSubmit(entry, null, raw)}
        className={error || decision.options.length > 0 ? undefined : "mt-3"}
      />
    </article>
  );
});

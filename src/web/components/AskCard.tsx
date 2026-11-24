import { useMutation } from "@tanstack/react-query";
import { PencilLine } from "../ui/icons.ts";
import { memo, useMemo, useRef, useState } from "react";
import {
  CONFIRM_REJECT_OPTION,
  sentFilesOf,
  splitCardTitle,
  type Deliverable,
  type ExtractedAskCard,
  type MessageId,
} from "../../shared/index.ts";
import { askDecisionDraftKey, clearDecisionDraft, getDecisionDraft, setDecisionDraft, useDecisionDraft } from "../decision-drafts.ts";
import { useClient } from "../device-scope.tsx";
import { errorLine, errorText, errorTitle, newClientId, type ErrorLike } from "../format.ts";
import { useHubQueryClient } from "../query-client.ts";
import { CardBody, CardNoteForm, UnsentDraftBanner } from "./Deliverables.tsx";
import { Markdown } from "./Markdown.tsx";
import type { MessageActions } from "./Messages.tsx";
import { OptionRow } from "./OptionRow.tsx";

export const AskCard = memo(function AskCard({
  card,
  files,
  deliverables,
  messageId,
  onAnswerAsk,
}: {
  card: ExtractedAskCard;
  files: ReturnType<typeof sentFilesOf>;
  deliverables: readonly Deliverable[];
  messageId: MessageId;
  onAnswerAsk?: MessageActions["onAnswerAsk"];
}) {
  const client = useClient();
  const qc = useHubQueryClient();
  const gateRef = card.gateRef;
  const draftKey = askDecisionDraftKey(client.device, messageId);
  const draft = useDecisionDraft(draftKey);
  const hasOptions = card.options.length > 0;
  const [submitted, setSubmitted] = useState<{ chosenOption?: string; note?: string } | null>(null);
  const [err, setErr] = useState<ErrorLike | null>(null);
  const clientIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  const decideMutation = useMutation(
    {
      mutationFn: async (vars: { choice: string | null; note: string | null }) => {
        clientIdRef.current ??= newClientId();
        const body = { clientId: clientIdRef.current, choice: vars.choice, ...(vars.note !== null ? { note: vars.note } : {}) };
        if (gateRef === undefined) return onAnswerAsk?.(messageId, body);
        return client.postTaskGraphDecide(gateRef.graphId, gateRef.nodeKey, body);
      },
      onMutate: () => setErr(null),
      onSuccess: (_data, vars) => {
        clientIdRef.current = null;
        const chosenOption = vars.choice ?? (gateRef?.checkpoint ? CONFIRM_REJECT_OPTION : null);
        setSubmitted({ ...(chosenOption !== null ? { chosenOption } : {}), ...(vars.note !== null ? { note: vars.note } : {}) });
        clearDecisionDraft(draftKey);
      },
      onError: (error) => {
        setErr(errorText(error));
      },
      onSettled: () => {
        inFlightRef.current = false;
      },
    },
    qc,
  );

  const submit = (choice: string | null, rawNote: string) => {
    if (inFlightRef.current) return;
    const trimmed = rawNote.trim();
    if (choice === null && trimmed === "") return;
    inFlightRef.current = true;
    decideMutation.mutate({ choice, note: trimmed === "" ? null : trimmed });
  };

  const effectiveChosen = card.chosenOption ?? submitted?.chosenOption;
  const answerNote = card.answerNote ?? submitted?.note;
  const answered = card.answered || submitted !== null;
  const disabled = answered || (gateRef === undefined && !onAnswerAsk) || decideMutation.isPending;
  const { title: cardTitle, body: cardBody } = useMemo(() => splitCardTitle(card.question), [card.question]);
  const showUnsentDraft =
    answered &&
    !decideMutation.isPending &&
    draft.trim() !== "" &&
    (answerNote === undefined || answerNote.trim() !== draft.trim());

  return (
    <div className="w-full min-w-0 rounded-sm border border-border bg-background p-4" data-ask-card>
      <div className="w-full min-w-0 text-body leading-relaxed font-medium text-foreground">
        <Markdown text={cardTitle} files={files} messageId={messageId} />
      </div>
      <CardBody
        text={cardBody}
        titleText={cardTitle}
        deliverables={deliverables}
        files={files}
        messageId={messageId}
        className="mt-2"
        textClassName="text-body leading-relaxed text-foreground"
      />
      {(hasOptions || answerNote !== undefined) && (
        <div className="mt-3 flex flex-col gap-2" role="group" aria-label="Options">
          {card.options.map((opt, i) => {
            const isChosen = effectiveChosen === opt;
            const isRecommended = card.recommended !== undefined && opt === card.recommended;
            return (
              <OptionRow
                key={i}
                index={i}
                data-ask-option
                disabled={disabled}
                chosen={isChosen}
                recommended={isRecommended}
                onClick={() => {
                  if (disabled) return;
                  submit(opt, getDecisionDraft(draftKey));
                }}
              >
                <Markdown text={opt} files={files} messageId={messageId} />
              </OptionRow>
            );
          })}
          {answerNote !== undefined && (
            <div data-ask-answer className="flex min-h-11 w-full items-start gap-3 rounded-sm bg-panel px-3 py-2.5 leading-6">
              <span className="flex h-6 w-5 shrink-0 items-center justify-center text-muted-foreground">
                <PencilLine className="size-pixel-sm" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 text-body whitespace-pre-wrap [overflow-wrap:anywhere]">{answerNote}</span>
            </div>
          )}
        </div>
      )}
      {card.closed && <p className="mt-2 text-minor text-muted-foreground">Closed</p>}
      {!answered && (
        <CardNoteForm
          value={draft}
          onChange={(next) => setDecisionDraft(draftKey, next)}
          disabled={disabled}
          pending={decideMutation.isPending}
          onSubmitNote={(raw) => submit(null, raw)}
        />
      )}
      {showUnsentDraft && <UnsentDraftBanner draft={draft} onDismiss={() => clearDecisionDraft(draftKey)} />}
      {err !== null && (
        <p role="alert" title={errorTitle(err)} className="mt-2 text-xs text-danger">
          {errorLine(err)}
        </p>
      )}
    </div>
  );
});

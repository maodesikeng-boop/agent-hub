import { useMutation } from "@tanstack/react-query";
import { memo, useRef, useState } from "react";
import type { TaskGraphId, TaskNode, WorkerId } from "../../shared/index.ts";
import type { HubClient } from "../client.ts";
import { clearDecisionDraft, gateDecisionDraftKey, getDecisionDraft, setDecisionDraft, useDecisionDraft } from "../decision-drafts.ts";
import { errorLine, errorText, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import type { WorkerEntry } from "../selectors.ts";
import { CardBody, CardNoteForm } from "./Deliverables.tsx";

function makeClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `gate-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function resolveBoundWorker(
  node: TaskNode,
  workerByKey: ReadonlyMap<WorkerId, WorkerEntry>,
): { workerId: WorkerId | null; worker: WorkerEntry | null } {
  const wid = node.activeWorkerId ?? node.workerIds.at(-1) ?? null;
  if (wid === null) return { workerId: null, worker: null };
  return { workerId: wid, worker: workerByKey.get(wid) ?? null };
}

export const GateDecisionCard = memo(function GateDecisionCard({
  graphId,
  node,
  client,
}: {
  graphId: TaskGraphId;
  node: TaskNode;
  client: HubClient;
}) {
  const qc = useHubQueryClient();
  const draftKey = gateDecisionDraftKey(client.device, graphId, node.key, node.gateAskMessageId);
  const draft = useDecisionDraft(draftKey);
  const hasOptions = node.gateOptions.length > 0;
  const [err, setErr] = useState<ErrorLike | null>(null);
  const clientIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  const decideMutation = useMutation(
    {
      mutationFn: async (vars: { choice: string | null; note: string | null }) => {
        clientIdRef.current ??= makeClientId();
        return client.postTaskGraphDecide(graphId, node.key, {
          clientId: clientIdRef.current,
          ...(node.gateAskMessageId !== null ? { askMessageId: node.gateAskMessageId } : {}),
          choice: vars.choice,
          ...(vars.note !== null ? { note: vars.note } : {}),
        });
      },
      onMutate: () => setErr(null),
      onSuccess: () => {
        clientIdRef.current = null;
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

  const showQuestion = node.gateQuestion !== null && node.gateQuestion.trim() !== "" && node.gateQuestion !== node.title;

  return (
    <div
      data-testid="peel-gate-card"
      className="overflow-hidden rounded-sm border border-select-line bg-open px-3.5 py-3 [contain:layout_style]"
    >
      {showQuestion && <p className="mb-1 text-minor font-medium wrap-anywhere text-foreground">{node.gateQuestion}</p>}
      <CardBody
        text={node.gateSummaryMd ?? ""}
        titleText={node.gateQuestion ?? ""}
        deliverables={node.artifact?.deliverables}
        className="mb-2"
        textClassName="text-minor leading-relaxed text-foreground"
      />
      {hasOptions && (
        <div className="-mx-3.5 grid grid-cols-1 divide-y divide-border border-t border-border">
          {node.gateOptions.map((opt) => {
            const isRec = node.gateRecommended !== null && opt === node.gateRecommended;
            return (
              <button
                key={opt}
                type="button"
                disabled={decideMutation.isPending}
                onClick={() => submit(opt, getDecisionDraft(draftKey))}
                className="flex min-h-9 pointer-coarse:min-h-11 w-full cursor-pointer items-baseline justify-between gap-2 rounded-none px-3.5 py-2 text-left text-minor font-medium transition-colors duration-150 outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] disabled:pointer-events-none disabled:opacity-60 motion-reduce:transition-none"
              >
                <span className="min-w-0 flex-1 wrap-anywhere">{opt}</span>
                {isRec && <span className="tool-badge shrink-0 px-1.5 text-xs leading-5 font-medium">Recommended</span>}
              </button>
            );
          })}
        </div>
      )}
      {err !== null && (
        <p role="alert" title={errorTitle(err)} className="my-2 text-xs text-danger">
          {errorLine(err)}
        </p>
      )}
      <CardNoteForm
        key={draftKey}
        variant="row"
        value={draft}
        onChange={(next) => setDecisionDraft(draftKey, next)}
        disabled={decideMutation.isPending}
        pending={decideMutation.isPending}
        onSubmitNote={(raw) => submit(null, raw)}
        className={cn("-mx-3.5 -mb-3 pl-3.5", !hasOptions && err === null && "mt-2")}
        buttonSize="sm"
      />
    </div>
  );
});

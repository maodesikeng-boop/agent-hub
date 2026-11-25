import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type ReactElement } from "react";
import type { SandboxApprovalDecision, SandboxApprovalId } from "../../shared/index.ts";
import { useClient } from "../device-scope.tsx";
import { errorLine, errorText, newClientId } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import { Button } from "../ui/button.tsx";

export interface SandboxApprovalCardProps {
  approvalId: SandboxApprovalId;
  text: string;
  answered?: boolean;
  chosenOption?: string;
  closed?: boolean;
  disabled?: boolean;
  deviceName?: string;
  className?: string;
}

export function SandboxApprovalCard({
  approvalId, text, answered = false, chosenOption, closed = false, disabled = false, deviceName, className,
}: SandboxApprovalCardProps): ReactElement {
  const client = useClient();
  const qc = useHubQueryClient();
  const inFlight = useRef(false);
  const [sent, setSent] = useState<SandboxApprovalDecision | null>(null);
  const [id] = useState(newClientId);
  const decision = useMutation({
    mutationFn: (value: SandboxApprovalDecision) => client.postDecideSandboxApproval(approvalId, { decision: value, clientId: id }),
    onSuccess: (_result, value) => setSent(value),
    onSettled: () => { inFlight.current = false; },
  }, qc);
  const submit = (value: SandboxApprovalDecision) => {
    if (inFlight.current || sent !== null || answered || closed || disabled) return;
    inFlight.current = true;
    decision.mutate(value);
  };
  const settled = closed || answered || sent !== null;
  const status = closed ? "Closed" : chosenOption ?? (sent === "approve" ? "Approved" : sent === "reject" ? "Rejected" : null);
  return (
    <article aria-label="Worker sandbox approval" className={cn("border-2 px-3.5 py-3", settled ? "border-border-strong bg-background" : "border-open-line bg-open", className)}>
      <h3 className="text-body font-semibold">Run without Bellwood’s outer sandbox{deviceName === undefined ? "" : ` · ${deviceName}`}</h3>
      <div className="mt-2 space-y-2 whitespace-pre-wrap break-words text-minor leading-relaxed">
        {text.split("\n\n").map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      </div>
      {settled ? (
        <p className="mt-2 text-minor font-medium" role="status">{status}</p>
      ) : (
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={disabled || decision.isPending} onClick={() => submit("reject")}>Reject</Button>
          <Button size="sm" disabled={disabled || decision.isPending} onClick={() => submit("approve")}>Approve this run</Button>
        </div>
      )}
      {decision.isError && !settled && <p role="alert" className="mt-2 text-xs text-danger">{errorLine(errorText(decision.error))}</p>}
    </article>
  );
}

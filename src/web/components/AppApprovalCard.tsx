import type { ReactElement } from "react";
import type { AppApprovalDecision, AppApprovalId, AppApprovalRiskLevel, AppApprovalStatus } from "../../shared/index.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Clock } from "../ui/icons.ts";

export interface AppApprovalCardViewProps {
  workerId: number;
  workerTitle: string;
  appId: string;
  appName: string;
  riskLevel: AppApprovalRiskLevel | null;
  warning: string | null;
  status: AppApprovalStatus;
  remainingMs: number | null;
  busy?: boolean;
  error?: string | null;
  deviceName?: string;
  onDecide?: (decision: AppApprovalDecision) => void;
  className?: string;
}

const SETTLED_LABEL: Record<Exclude<AppApprovalStatus, "pending">, string> = {
  allowed: "Allowed for this run",
  denied: "Denied",
  expired: "Expired",
  revoked: "Ended with the Worker",
};

const RISK_LABEL: Record<AppApprovalRiskLevel, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function AppApprovalCardView({
  workerId, workerTitle, appId, appName, riskLevel, warning, status, remainingMs, busy = false, error = null, deviceName, onDecide, className,
}: AppApprovalCardViewProps): ReactElement {
  const pending = status === "pending";
  return (
    <article aria-label="Computer Use app approval" className={cn("rounded-sm border px-3.5 py-3", pending ? "border-select-line bg-open" : "border-border bg-background", className)}>
      <h3 className="text-body font-semibold">Let Computer Use control {appName}{deviceName === undefined ? "" : ` · ${deviceName}`}</h3>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-minor">
        <span className="wrap-anywhere">{appId}</span>
        {riskLevel !== null && (
          <span className={cn("rounded-xs bg-panel px-1.5 text-xs font-medium", riskLevel === "high" && "text-danger")}>{RISK_LABEL[riskLevel]}</span>
        )}
      </div>
      <p className="mt-2 text-minor">Worker #{workerId} · {workerTitle}</p>
      {warning !== null && <p className="mt-1 text-minor">{warning}</p>}
      {pending ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {remainingMs !== null && (
            <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground tabular-nums" aria-label="Time left">
              <Clock className="size-3.5" aria-hidden />{formatRemaining(remainingMs)}
            </span>
          )}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide?.("deny")}>Deny</Button>
          <Button size="sm" disabled={busy} onClick={() => onDecide?.("allow")}>Allow for this run</Button>
        </div>
      ) : (
        <p className="mt-2 text-minor font-medium" role="status">{SETTLED_LABEL[status]}</p>
      )}
      {error !== null && pending && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </article>
  );
}

export interface AppApprovalCardProps {
  approvalId: AppApprovalId;
  workerId: number;
  appId: string;
  appName: string;
  riskLevel: AppApprovalRiskLevel | null;
  text: string;
  answered?: boolean;
  chosenOption?: string;
  closed?: boolean;
  className?: string;
}

/**
 * Postcondition: renders AppApprovalCardView from the message ref plus the live snapshot row (title, warning, expiry);
 * posts one decision per card with a stable clientId, ignores repeat clicks while in flight, and shows the settled
 * label from the message once the ledger settles the card.
 */
export function AppApprovalCard(_props: AppApprovalCardProps): ReactElement {
  throw new Error("Not implemented");
}

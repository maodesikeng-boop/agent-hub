import { useRef, useState, type ReactElement } from "react";
import { APP_APPROVAL_SETTLED_LABELS, type AppApprovalDecision, type AppApprovalId, type AppApprovalRiskLevel, type AppApprovalStatus } from "../../shared/index.ts";
import { useClient } from "../device-scope.tsx";
import { errorLine, errorText, newClientId } from "../format.ts";
import { SECOND_TICK_MS } from "../limits.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Clock } from "../ui/icons.ts";
import { useNow } from "../useNow.ts";

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
  disabled?: boolean;
  error?: string | null;
  deviceName?: string;
  onDecide?: (decision: AppApprovalDecision) => void;
  className?: string;
}

const RISK_LABEL: Record<AppApprovalRiskLevel, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function AppApprovalCardView({
  workerId, workerTitle, appId, appName, riskLevel, warning, status, remainingMs, busy = false, disabled = false, error = null, deviceName, onDecide, className,
}: AppApprovalCardViewProps): ReactElement {
  const pending = status === "pending";
  return (
    <article aria-label="Computer Use app approval" className={cn("rounded-sm border px-3.5 py-3", pending ? "border-select-line bg-open" : "border-border bg-background", className)}>
      <h3 className="wrap-anywhere text-body font-semibold">Let Computer Use control {appName}{deviceName === undefined ? "" : ` · ${deviceName}`}</h3>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-minor">
        <span className="wrap-anywhere">{appId}</span>
        {riskLevel !== null && (
          <span className={cn("rounded-xs bg-panel px-1.5 text-xs font-medium", riskLevel === "high" && "text-danger")}>{RISK_LABEL[riskLevel]}</span>
        )}
      </div>
      <p className="mt-2 wrap-anywhere text-minor">Worker #{workerId}{workerTitle === "" ? "" : ` · ${workerTitle}`}</p>
      {warning !== null && <p className="mt-1 wrap-anywhere text-minor">{warning}</p>}
      {pending ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {remainingMs !== null && (
            <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground tabular-nums" aria-label="Time left">
              <Clock className="size-3.5" aria-hidden />{formatRemaining(remainingMs)}
            </span>
          )}
          <Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => onDecide?.("deny")}>Deny</Button>
          <Button size="sm" disabled={busy || disabled} onClick={() => onDecide?.("allow")}>Allow for this run</Button>
        </div>
      ) : (
        <p className="mt-2 text-minor font-medium" role="status">{APP_APPROVAL_SETTLED_LABELS[status]}</p>
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
  workerTitle?: string;
  warning?: string | null;
  expiresAt?: number;
  disabled?: boolean;
  deviceName?: string;
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
export function AppApprovalCard(props: AppApprovalCardProps): ReactElement {
  const { approvalId, workerId, workerTitle = "", appId, appName, riskLevel, warning = null, expiresAt, disabled, deviceName, className } = props;
  const client = useClient();
  const request = useRef<{ id: string; busy: boolean } | null>(null);
  const [decision, setDecision] = useState<AppApprovalStatus>("pending");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settled = props.chosenOption === APP_APPROVAL_SETTLED_LABELS.revoked ? "revoked"
    : props.closed ? "expired"
    : props.answered ? props.chosenOption === APP_APPROVAL_SETTLED_LABELS.allowed ? "allowed" : "denied"
    : decision;
  const now = useNow(SECOND_TICK_MS, settled === "pending" ? (expiresAt ?? null) : null);
  const remaining = expiresAt === undefined ? null : Math.max(0, expiresAt - now);
  const status = settled === "pending" && remaining === 0 ? "expired" : settled;

  const submit = async (choice: AppApprovalDecision) => {
    if (disabled || status !== "pending" || request.current?.busy) return;
    const attempt = request.current ?? { id: newClientId(), busy: false };
    request.current = attempt;
    attempt.busy = true;
    setBusy(true);
    setError(null);
    try {
      const { approval } = await client.postDecideAppApproval(approvalId, { decision: choice, clientId: attempt.id });
      setDecision(approval.status);
    } catch (err) {
      setError(errorLine(errorText(err)));
    } finally {
      attempt.busy = false;
      setBusy(false);
    }
  };

  return <AppApprovalCardView {...{
    workerId, workerTitle, appId, appName, riskLevel, warning, status, busy, disabled, error, deviceName, className,
    remainingMs: remaining, onDecide: (choice: AppApprovalDecision) => { void submit(choice); },
  }} />;
}

import type { ReactElement } from "react";
import type { SandboxApprovalId, SandboxApprovalSummary } from "../../shared/index.ts";

export interface SandboxApprovalCardProps {
  approvalId: SandboxApprovalId;
  summary?: SandboxApprovalSummary | null;
  text: string;
  answered?: boolean;
  chosenOption?: string;
  closed?: boolean;
  showStatus?: boolean;
  className?: string;
}

/**
 * Precondition: rendered inside an authenticated Bellwood Web UI device scope for a message with AskMeta.sandboxApprovalRef or a Router pending item.
 * Postcondition: displays Worker identity, task summary, dropped outer-sandbox protection warning, single-run expiry scope, and Approve/Reject actions posting to API_PATHS.decideSandboxApproval.
 */
export function SandboxApprovalCard(_props: SandboxApprovalCardProps): ReactElement {
  throw new Error("Not implemented");
}

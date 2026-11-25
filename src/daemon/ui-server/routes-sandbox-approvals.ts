import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eligibleComputerUseCapabilities, LedgerRequestError, SANDBOX_APPROVAL_DECISIONS } from "../../shared/index.ts";
import type { UiCtx } from "./context.ts";
import { idParam, MAX_CLIENT_ID_LENGTH, parseWithSchema } from "./http.ts";

export const decideSandboxApprovalBodySchema = z
  .object({
    decision: z.enum(SANDBOX_APPROVAL_DECISIONS),
    clientId: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
  })
  .strict();

/**
 * Precondition: routes is a Fastify plugin behind ui-server authentication (browser cookie or mTLS mesh peer); never mounted on agent-api.
 * Postcondition: registers POST /api/sandbox-approvals/:id/decide to forward validated human decisions to ledger.decideSandboxApproval.
 */
export function registerSandboxApprovalRoutes(routes: FastifyInstance, c: UiCtx): void {
  routes.post("/api/sandbox-approvals/:id/decide", async (req, reply) => {
    const decide = c.ledger.decideSandboxApproval;
    if (decide === undefined) throw new LedgerRequestError("not_found", "Sandbox approval is unavailable");
    const id = idParam(req.params, "sandbox approval id");
    const body = parseWithSchema(decideSandboxApprovalBodySchema, req.body);
    const approval = c.ledger.getSandboxApproval?.(id);
    if (body.decision === "approve" && approval?.status === "pending" && c.opts.capabilityInventory !== undefined) {
      const projectDir = c.ledger.pmProjectMainFolder(approval.pmId);
      const inventory = await c.opts.capabilityInventory.get({ projectDir });
      if (reply.raw.destroyed) throw new LedgerRequestError("conflict", "The confirmation request was interrupted");
      const installed = eligibleComputerUseCapabilities(approval.vendor, inventory);
      if (!approval.capabilities.some((key) => installed.includes(key))) {
        throw new LedgerRequestError("conflict", "The Computer Use capability is no longer installed");
      }
    }
    return decide(id, body);
  });
}

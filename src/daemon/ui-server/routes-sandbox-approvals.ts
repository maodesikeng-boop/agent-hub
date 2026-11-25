import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SANDBOX_APPROVAL_DECISIONS } from "../../shared/index.ts";
import type { UiCtx } from "./context.ts";
import { MAX_CLIENT_ID_LENGTH } from "./http.ts";

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
export function registerSandboxApprovalRoutes(_routes: FastifyInstance, _c: UiCtx): void {
  throw new Error("Not implemented");
}

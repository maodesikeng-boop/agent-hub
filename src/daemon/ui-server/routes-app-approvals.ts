import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { APP_APPROVAL_DECISIONS } from "../../shared/index.ts";
import type { UiCtx } from "./context.ts";
import { MAX_CLIENT_ID_LENGTH } from "./http.ts";

export const decideAppApprovalBodySchema = z
  .object({
    decision: z.enum(APP_APPROVAL_DECISIONS),
    clientId: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
  })
  .strict();

/**
 * Precondition: routes is a Fastify plugin behind ui-server authentication (browser cookie or mTLS mesh peer); never mounted on agent-api.
 * Postcondition: registers POST /api/app-approvals/:id/decide, which forwards a validated human decision to ledger.decideAppApproval.
 */
export function registerAppApprovalRoutes(_routes: FastifyInstance, _c: UiCtx): void {
  throw new Error("Not implemented");
}

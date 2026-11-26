import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { APP_APPROVAL_DECISIONS, LedgerRequestError } from "../../shared/index.ts";
import type { UiCtx } from "./context.ts";
import { idParam, MAX_CLIENT_ID_LENGTH, parseWithSchema } from "./http.ts";

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
export function registerAppApprovalRoutes(routes: FastifyInstance, c: UiCtx): void {
  routes.post("/api/app-approvals/:id/decide", (req) => {
    const decide = c.ledger.decideAppApproval;
    if (decide === undefined) throw new LedgerRequestError("not_found", "App approval is unavailable");
    return decide(idParam(req.params, "app approval id"), parseWithSchema(decideAppApprovalBodySchema, req.body));
  });
}

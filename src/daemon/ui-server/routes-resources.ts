// Invariant: resource inspection routes run within device scope (proxied across mesh computers) and validate all request bodies with zod before mutating state.
import type { FastifyInstance } from "fastify";
import type { UiCtx } from "./context.ts";

/**
 * Precondition: c.opts.resources is provided when the daemon mounts resource inspection.
 * Postcondition: registers GET /api/resources, POST /api/resources/decision, and POST /api/resources/cleanup with preClose shutdown cleanup.
 */
export function registerResourceRoutes(routes: FastifyInstance, c: UiCtx): void {
  throw new Error("Not implemented");
}

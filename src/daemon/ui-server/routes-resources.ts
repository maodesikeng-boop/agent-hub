// Invariant: resource inspection routes run within device scope (proxied across mesh computers) and validate all request bodies with zod before mutating state.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  API_PATHS,
  type ResourceCleanupResponse,
  type ResourceDecisionRequest,
  type ResourceDecisionResponse,
  type ResourcesSnapshot,
} from "../../shared/index.ts";
import type { UiCtx } from "./context.ts";
import { HttpError, parseWithSchema } from "./http.ts";

const resourceDecisionBodySchema = z
  .object({
    kind: z.enum(["worktree", "git_branch", "temp_dir", "process"]),
    targetKey: z
      .string()
      .refine((s) => s.trim() !== "" && !s.includes("\u0000"), "targetKey must not be empty")
      .refine((s) => s.length <= 512, "targetKey is too long"),
    action: z.enum(["keep", "unkeep", "discard"]),
    deleteBranch: z.boolean().optional(),
  })
  .strict();

const wantsRefresh = (query: unknown): boolean => (query as { refresh?: unknown }).refresh === "1";

/**
 * Precondition: c.opts.resources is provided when the daemon mounts resource inspection.
 * Postcondition: registers GET /api/resources, POST /api/resources/decision, and POST /api/resources/cleanup with preClose shutdown cleanup.
 */
export function registerResourceRoutes(routes: FastifyInstance, c: UiCtx): void {
  const resources = c.opts.resources;
  if (resources !== undefined) {
    routes.addHook("preClose", async () => {
      resources.close();
    });
  }

  const requireResources = () => {
    if (resources === undefined) throw new HttpError(501, "resource inspection is unavailable");
    return resources;
  };

  routes.get(API_PATHS.resources, (req): Promise<ResourcesSnapshot> => {
    return requireResources().inspect({ refresh: wantsRefresh(req.query) });
  });

  routes.post(API_PATHS.resourceDecision, (req): Promise<ResourceDecisionResponse> => {
    const body = parseWithSchema(resourceDecisionBodySchema, req.body);
    const request: ResourceDecisionRequest = {
      kind: body.kind,
      targetKey: body.targetKey.trim(),
      action: body.action,
      ...(body.deleteBranch !== undefined ? { deleteBranch: body.deleteBranch } : {}),
    };
    return requireResources().decide(request);
  });

  routes.post(API_PATHS.resourceCleanup, (): Promise<ResourceCleanupResponse> => {
    return requireResources().runCleanup();
  });
}

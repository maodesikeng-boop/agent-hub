import type { FastifyInstance } from "fastify";
import { API_PATHS, type UpdateStatus } from "../../shared/index.ts";
import { createUpdateChecker, updateCheckerOptionsFor } from "../update-checker.ts";
import { ROOT_DIR, type UiCtx } from "./context.ts";

export function registerUpdateRoutes(routes: FastifyInstance, c: UiCtx): void {
  const checker = c.opts.update ?? createUpdateChecker(updateCheckerOptionsFor({ packageRoot: ROOT_DIR, env: process.env }));
  // preClose runs before Fastify waits for in-flight requests, so a pending GitHub call cannot hold up shutdown.
  routes.addHook("preClose", async () => checker.close());
  routes.get(API_PATHS.update, (): Promise<UpdateStatus> => checker.get());
  routes.post(API_PATHS.updateCheck, (): Promise<UpdateStatus> => checker.check());
}

import { describe, it } from "vitest";

describe("registerResourceRoutes", () => {
  it.todo("returns ResourcesSnapshot on GET /api/resources and passes refresh=1 through");
  it.todo("validates POST /api/resources/decision payloads with zod and rejects invalid actions or empty target keys with 400");
  it.todo("dispatches keep, unkeep, and discard actions and returns the updated snapshot");
  it.todo("triggers safe automatic cleanup on POST /api/resources/cleanup");
  it.todo("proxies /api/resources routes across mesh computers inside device scope");
  it.todo("calls inspector.close() in the Fastify preClose hook");
});

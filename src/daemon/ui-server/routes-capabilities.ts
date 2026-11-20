import type { FastifyInstance } from "fastify";
import {
  API_PATHS,
  type CapabilitiesView,
  type CapabilityScope,
  type CustomizedCapabilitiesResponse,
  type PutProjectSetupCommandRequest,
  type PutProjectSetupCommandResponse,
  type ScopeCapabilities,
} from "../../shared/index.ts";
import type { UiCtx } from "./context.ts";
import { idParam, parseWithSchema } from "./http.ts";
import { parseCapabilitiesPatchBody, putProjectSetupCommandBodySchema } from "./schemas.ts";

const wantsRefresh = (query: unknown): boolean => (query as { refresh?: unknown }).refresh === "1";

const DEFAULT_SCOPE: CapabilityScope = { kind: "default" };
const ROUTER_SCOPE: CapabilityScope = { kind: "router" };

export function registerCapabilityRoutes(routes: FastifyInstance, c: UiCtx): void {
  const { opts, ledger } = c;
  // Project defaults and the Router see the global inventory; a project also sees its main folder's skills.
  const projectDirOf = (scope: CapabilityScope): string | null => (scope.kind === "pm" ? ledger.pmProjectMainFolder(scope.pmId) : null);
  const view = async (scope: CapabilityScope, capabilities: ScopeCapabilities, refresh = false): Promise<CapabilitiesView> => {
    if (refresh) opts.capabilityInventory?.invalidate();
    const inventory = opts.capabilityInventory
      ? await opts.capabilityInventory.get({ projectDir: projectDirOf(scope) })
      : { scannedAt: (opts.now ?? Date.now)(), items: [], groups: [], truncated: false };
    return { scope, inventory, ...capabilities };
  };
  const pmScope = (params: unknown): CapabilityScope & { kind: "pm" } => ({ kind: "pm", pmId: idParam(params, "pm id") });

  for (const [path, scopeOf] of [
    [API_PATHS.defaultCapabilities, () => DEFAULT_SCOPE],
    [API_PATHS.routerCapabilities, () => ROUTER_SCOPE],
    ["/api/pms/:id/capabilities", pmScope],
  ] as const) {
    routes.get(path, async (req): Promise<CapabilitiesView> => {
      const scope = scopeOf(req.params);
      return view(scope, ledger.getCapabilities(scope), wantsRefresh(req.query));
    });
    routes.patch(path, async (req): Promise<CapabilitiesView> => {
      const scope = scopeOf(req.params);
      return view(scope, ledger.patchCapabilities(scope, parseCapabilitiesPatchBody(req.body)));
    });
  }

  routes.delete("/api/pms/:id/capabilities", async (req): Promise<CapabilitiesView> => {
    const scope = pmScope(req.params);
    return view(scope, ledger.resetPmCapabilities(scope.pmId));
  });

  routes.get(API_PATHS.customizedCapabilities, async (): Promise<CustomizedCapabilitiesResponse> => ({ pmIds: ledger.customizedCapabilityPms() }));

  routes.put("/api/projects/:id/setup-command", async (req): Promise<PutProjectSetupCommandResponse> => {
    const projectId = idParam(req.params, "project id");
    const raw: PutProjectSetupCommandRequest = parseWithSchema(putProjectSetupCommandBodySchema, req.body);
    return { project: ledger.setProjectSetupCommand(projectId, raw.command) };
  });
}

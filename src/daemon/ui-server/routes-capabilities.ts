import type { FastifyInstance } from "fastify";
import {
  AGENT_VENDORS,
  API_PATHS,
  vendorSpec,
  type AgentVendor,
  type CapabilitiesView,
  type CapabilityIsolationMap,
  type CapabilityPolicy,
  type CapabilityScope,
  type PutProjectSetupCommandRequest,
  type PutProjectSetupCommandResponse,
} from "../../shared/index.ts";
import type { UiCtx } from "./context.ts";
import { idParam, parseWithSchema } from "./http.ts";
import { parseCapabilitiesPatchBody, putProjectSetupCommandBodySchema } from "./schemas.ts";

function vendorIsolationMap(): Readonly<Partial<Record<AgentVendor, CapabilityIsolationMap>>> {
  return Object.fromEntries(AGENT_VENDORS.map((v) => [v, vendorSpec(v).capabilities.isolation]));
}

function vendorPluginIsolationMap(): Readonly<Partial<Record<AgentVendor, Partial<CapabilityIsolationMap>>>> {
  return Object.fromEntries(
    AGENT_VENDORS.flatMap((v) => {
      const plugin = vendorSpec(v).capabilities.pluginIsolation;
      return plugin === undefined ? [] : [[v, plugin]];
    }),
  );
}

const wantsRefresh = (query: unknown): boolean => (query as { refresh?: unknown }).refresh === "1";

export function registerCapabilityRoutes(routes: FastifyInstance, c: UiCtx): void {
  const { opts, ledger } = c;
  const view = async (scope: CapabilityScope, policy: CapabilityPolicy, projectDir: string | null, refresh = false): Promise<CapabilitiesView> => {
    if (refresh) opts.capabilityInventory?.invalidate();
    const inventory = opts.capabilityInventory
      ? await opts.capabilityInventory.get({ projectDir })
      : { scannedAt: (opts.now ?? Date.now)(), items: [], groups: [], truncated: false };
    return { scope, inventory, policy, isolation: vendorIsolationMap(), pluginIsolation: vendorPluginIsolationMap() };
  };

  routes.get("/api/pms/:id/capabilities", async (req): Promise<CapabilitiesView> => {
    const pmId = idParam(req.params, "pm id");
    const policy = ledger.getPmCapabilityPolicy(pmId);
    return view({ kind: "pm", pmId }, policy, ledger.pmProjectMainFolder(pmId), wantsRefresh(req.query));
  });

  routes.patch("/api/pms/:id/capabilities", async (req): Promise<CapabilitiesView> => {
    const pmId = idParam(req.params, "pm id");
    const policy = ledger.patchPmCapabilities(pmId, parseCapabilitiesPatchBody(req.body));
    return view({ kind: "pm", pmId }, policy, ledger.pmProjectMainFolder(pmId));
  });

  routes.get(API_PATHS.routerCapabilities, async (req): Promise<CapabilitiesView> => {
    return view({ kind: "router" }, ledger.getRouterCapabilityPolicy(), null, wantsRefresh(req.query));
  });

  routes.patch(API_PATHS.routerCapabilities, async (req): Promise<CapabilitiesView> => {
    return view({ kind: "router" }, ledger.patchRouterCapabilities(parseCapabilitiesPatchBody(req.body)), null);
  });

  routes.put("/api/projects/:id/setup-command", async (req): Promise<PutProjectSetupCommandResponse> => {
    const projectId = idParam(req.params, "project id");
    const raw: PutProjectSetupCommandRequest = parseWithSchema(putProjectSetupCommandBodySchema, req.body);
    return { project: ledger.setProjectSetupCommand(projectId, raw.command) };
  });
}

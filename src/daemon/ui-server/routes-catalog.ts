import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  AGENT_VENDORS,
  API_PATHS,
  REFRESH_UNUSABLE,
  bundledModelCatalog,
  type AgentVendor,
  type ModelsResponse,
  type ProviderStatusItem,
  type ProvidersStatusResponse,
  type QuotaResponse,
  type VendorSyncApplyRequest,
  type VendorSyncApplyResponse,
  type VendorSyncPreviewResponse,
} from "../../shared/index.ts";
import type { ProviderManager } from "../provider-manager/index.ts";
import { clientOwnerKeyOf, type UiCtx } from "./context.ts";
import { HttpError, parseVendorParam, parseWithSchema } from "./http.ts";
import {
  emptyObjectBodySchema,
  providerCancelAuthBodySchema,
  providerCancelJobBodySchema,
  providerLogoutBodySchema,
  providerSaveApiKeyBodySchema,
  providerStartAuthBodySchema,
  providerSubmitAuthBodySchema,
  vendorSyncApplyBodySchema,
} from "./schemas.ts";

function registerVendorSyncRoutes(routes: FastifyInstance, c: UiCtx): void {
  const { opts } = c;
  routes.get(API_PATHS.vendorSyncPreview, async (): Promise<VendorSyncPreviewResponse> => {
    if (!opts.vendorSync) {
      return {
        scannedAt: (opts.now ?? Date.now)(),
        mcpServers: [],
        skills: [],
        nonSyncable: [],
        truncated: false,
      };
    }
    return opts.vendorSync.preview();
  });

  routes.post(API_PATHS.vendorSyncApply, async (req): Promise<VendorSyncApplyResponse> => {
    if (!opts.vendorSync) throw new HttpError(501, "vendor sync unavailable");
    const raw = parseWithSchema(vendorSyncApplyBodySchema, req.body);
    const request: VendorSyncApplyRequest = {
      selectedMcpKeys: raw.selectedMcpKeys,
      removeMcpKeys: raw.removeMcpKeys,
      selectedSkillKeys: raw.selectedSkillKeys,
      removeSkillKeys: raw.removeSkillKeys,
      ...(raw.confirmedHostBoundMcpKeys !== undefined ? { confirmedHostBoundMcpKeys: raw.confirmedHostBoundMcpKeys } : {}),
    };
    const applied = opts.vendorSync.apply(request);
    opts.capabilityInventory?.invalidate();
    return applied;
  });
}

function registerProviderActions(routes: FastifyInstance, c: UiCtx): void {
  const providerAction = <T>(path: string, schema: z.ZodType<T>, emptyBody: boolean, run: (providers: ProviderManager, vendor: AgentVendor, body: T, ownerKey: string) => Promise<ProviderStatusItem>) => {
    routes.post(path, async (req: FastifyRequest): Promise<ProviderStatusItem> => {
      if (!c.opts.providers) throw new HttpError(501, "provider manager unavailable");
      const vendor = parseVendorParam((req.params as { vendor?: unknown }).vendor);
      const body = parseWithSchema(schema, emptyBody ? (req.body ?? {}) : req.body);
      return run(c.opts.providers, vendor, body, clientOwnerKeyOf(c, req));
    });
  };
  providerAction("/api/providers/:vendor/install", emptyObjectBodySchema, true, (p, vendor, _body, owner) => p.install(vendor, owner));
  providerAction("/api/providers/:vendor/update", emptyObjectBodySchema, true, (p, vendor, _body, owner) => p.update(vendor, owner));
  providerAction("/api/providers/:vendor/job/cancel", providerCancelJobBodySchema, false, (p, vendor, body, owner) => p.cancelJob(vendor, body, owner));
  providerAction("/api/providers/:vendor/auth/start", providerStartAuthBodySchema, false, (p, vendor, body, owner) => p.startAuth(vendor, body, owner));
  providerAction("/api/providers/:vendor/auth/submit", providerSubmitAuthBodySchema, false, (p, vendor, body, owner) => p.submitAuth(vendor, body, owner));
  providerAction("/api/providers/:vendor/auth/cancel", providerCancelAuthBodySchema, false, (p, vendor, body, owner) => p.cancelAuth(vendor, body, owner));
  providerAction("/api/providers/:vendor/auth/api-key", providerSaveApiKeyBodySchema, false, (p, vendor, body, owner) => p.saveApiKey(vendor, body, owner));
  providerAction("/api/providers/:vendor/auth/logout", providerLogoutBodySchema, true, (p, vendor, body, owner) => p.logout(vendor, body, owner));
}

export function registerCatalogRoutes(routes: FastifyInstance, c: UiCtx): void {
  const { opts, serverInfo } = c;
  routes.get(API_PATHS.models, async (req): Promise<ModelsResponse> => {
    const query = (req.query as { refresh?: unknown }).refresh;
    const refresh = query === "1" ? true : query === REFRESH_UNUSABLE ? REFRESH_UNUSABLE : false;
    return { catalogs: opts.models ? await opts.models.list({ refresh }) : AGENT_VENDORS.map((v) => bundledModelCatalog(v)) };
  });

  routes.get(API_PATHS.quota, async (): Promise<QuotaResponse> => (opts.quota ? await opts.quota.get() : { groups: [] }));

  registerVendorSyncRoutes(routes, c);

  routes.get(API_PATHS.providers, async (req): Promise<ProvidersStatusResponse> => {
    if (!opts.providers) {
      return {
        platform: serverInfo.platform,
        gitInstalled: true,
        canInstallGit: false,
        gitJob: null,
        providers: [],
      };
    }
    const refresh = (req.query as { refresh?: unknown }).refresh === "1";
    return opts.providers.getStatus({ refresh, ownerKey: clientOwnerKeyOf(c, req) });
  });

  routes.post(API_PATHS.providerGitInstall, async (req): Promise<ProvidersStatusResponse> => {
    if (!opts.providers) throw new HttpError(501, "provider manager unavailable");
    parseWithSchema(emptyObjectBodySchema, req.body ?? {});
    return opts.providers.installGit(clientOwnerKeyOf(c, req));
  });

  registerProviderActions(routes, c);
}

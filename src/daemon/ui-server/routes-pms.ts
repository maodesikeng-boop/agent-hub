import type { FastifyInstance, FastifyReply } from "fastify";
import {
  API_PATHS,
  type ArchivePmResponse,
  type CreatePmResponse,
  type EditPersonaResponse,
  type PersonaResponse,
  type PickFolderResponse,
  type PmCapabilitiesView,
  type PmId,
  type PmLookResponse,
  type PmMemoryFileResponse,
  type PmMemoryFilesResponse,
  type PutPmMemoryFileResponse,
  type RenewSessionResponse,
  type RetryMessageResponse,
  type TurnReplyView,
} from "../../shared/index.ts";
import type { UiCtx } from "./context.ts";
import { fail, idParam, parseId, parseWithSchema } from "./http.ts";
import {
  addScheduleBodySchema,
  parseCreatePmBody,
  parseEditPersonaBody,
  parsePatchPmCapabilitiesBody,
  parsePmLookBody,
  pickFolderBodySchema,
  putPmMemoryFileBodySchema,
  setScheduleEnabledBodySchema,
  vendorIsolationMap,
  vendorPluginIsolationMap,
} from "./schemas.ts";

type MemoryFileParams = { id?: unknown; "*"?: unknown };
const memoryFileName = (params: MemoryFileParams) => (typeof params["*"] === "string" ? params["*"] : "");

function registerPersonaRoutes(routes: FastifyInstance, c: UiCtx): void {
  const { opts, ledger } = c;
  const capabilitiesView = async (pmId: PmId, policy: PmCapabilitiesView["policy"], projectDir: string | null): Promise<PmCapabilitiesView> => {
    const inventory = opts.capabilityInventory
      ? await opts.capabilityInventory.get({ projectDir })
      : { scannedAt: (opts.now ?? Date.now)(), items: [], groups: [], truncated: false };
    return { pmId, inventory, policy, isolation: vendorIsolationMap(), pluginIsolation: vendorPluginIsolationMap() };
  };

  routes.post(API_PATHS.pms, async (req, reply) => {
    const result = ledger.createPm(parseCreatePmBody(req.body));
    return reply.code(201).send({ pmId: result.pm.id, conversationId: result.conversation.id } satisfies CreatePmResponse);
  });

  routes.get("/api/pms/:id/persona", async (req): Promise<PersonaResponse> => {
    return ledger.getPersona(idParam(req.params, "pm id"));
  });

  routes.put("/api/pms/:id/persona", async (req): Promise<EditPersonaResponse> => {
    const pmId = idParam(req.params, "pm id");
    const result = ledger.editPersona(pmId, parseEditPersonaBody(req.body), { kind: "user" });
    return { changed: result.change !== null, persona: result.persona };
  });

  routes.put("/api/pms/:id/look", async (req): Promise<PmLookResponse> => {
    const pmId = idParam(req.params, "pm id");
    return { pm: ledger.setPmLook(pmId, parsePmLookBody(req.body)) };
  });

  routes.get("/api/pms/:id/capabilities", async (req): Promise<PmCapabilitiesView> => {
    const pmId = idParam(req.params, "pm id");
    const policy = ledger.getPmCapabilityPolicy(pmId);
    const projectDir = ledger.pmProjectMainFolder(pmId);
    if ((req.query as { refresh?: unknown }).refresh === "1") {
      opts.capabilityInventory?.invalidate();
    }
    return capabilitiesView(pmId, policy, projectDir);
  });

  routes.patch("/api/pms/:id/capabilities", async (req): Promise<PmCapabilitiesView> => {
    const pmId = idParam(req.params, "pm id");
    const patch = parsePatchPmCapabilitiesBody(req.body);
    const policy = ledger.patchPmCapabilities(pmId, patch);
    return capabilitiesView(pmId, policy, ledger.pmProjectMainFolder(pmId));
  });

  routes.post("/api/persona-changes/:id/revert", async (req): Promise<EditPersonaResponse> => {
    const result = ledger.revertPersonaChange(idParam(req.params, "persona change id"));
    return { changed: result.change !== null, persona: result.persona };
  });
}

function registerMemoryAndScheduleRoutes(routes: FastifyInstance, c: UiCtx): void {
  const { ledger } = c;
  routes.get("/api/pms/:id/memory-files", async (req): Promise<PmMemoryFilesResponse> => {
    return ledger.listPmMemoryFiles(idParam(req.params, "pm id"));
  });

  routes.get("/api/pms/:id/memory-files/*", async (req): Promise<PmMemoryFileResponse> => {
    const params = req.params as MemoryFileParams;
    return ledger.getPmMemoryFile(parseId(params.id, "pm id"), memoryFileName(params));
  });

  routes.put("/api/pms/:id/memory-files/*", async (req): Promise<PutPmMemoryFileResponse> => {
    const params = req.params as MemoryFileParams;
    const raw = parseWithSchema(putPmMemoryFileBodySchema, req.body);
    return ledger.putPmMemoryFile(parseId(params.id, "pm id"), memoryFileName(params), raw.content);
  });

  routes.delete("/api/pms/:id/memory-files/*", async (req, reply) => {
    const params = req.params as MemoryFileParams;
    ledger.deletePmMemoryFile(parseId(params.id, "pm id"), memoryFileName(params));
    return reply.code(204).send();
  });

  routes.post("/api/pms/:id/schedules", async (req, reply) => {
    const pmId = idParam(req.params, "pm id");
    const raw = parseWithSchema(addScheduleBodySchema, req.body);
    const schedule = ledger.addSchedule(pmId, {
      name: raw.name as string,
      prompt: raw.prompt as string,
      ...(raw.daily !== undefined ? { daily: raw.daily as string } : {}),
      ...(raw.everyMinutes !== undefined ? { everyMinutes: raw.everyMinutes as number } : {}),
    });
    return reply.code(201).send(schedule);
  });

  routes.put("/api/schedules/:id", async (req) => {
    const raw = parseWithSchema(setScheduleEnabledBodySchema, req.body);
    return ledger.setScheduleEnabled(idParam(req.params, "schedule id"), raw.enabled);
  });

  routes.delete("/api/schedules/:id", async (req, reply) => {
    ledger.removeSchedule(idParam(req.params, "schedule id"));
    return reply.code(204).send();
  });
}

export function registerPmRoutes(routes: FastifyInstance, c: UiCtx): void {
  const { ledger } = c;
  registerPersonaRoutes(routes, c);
  registerMemoryAndScheduleRoutes(routes, c);

  routes.post(API_PATHS.pickFolder, async (req): Promise<PickFolderResponse> => {
    const raw = parseWithSchema(pickFolderBodySchema, req.body ?? {});
    return { path: await c.folderPicker.pick(raw.startDir) };
  });

  routes.post("/api/pms/:id/renew-session", async (req, reply) => {
    const result = ledger.renewSession(idParam(req.params, "pm id"));
    return reply.code(202).send({ handoverId: result.handoverId } satisfies RenewSessionResponse);
  });

  routes.post("/api/pms/:id/archive", async (req): Promise<ArchivePmResponse> => {
    const pmId = idParam(req.params, "pm id");
    return { pm: ledger.archivePm(pmId) };
  });

  routes.post("/api/pms/:id/unarchive", async (req): Promise<ArchivePmResponse> => {
    const pmId = idParam(req.params, "pm id");
    return { pm: ledger.unarchivePm(pmId) };
  });

  routes.get("/api/messages/:id/turn-reply", async (req, reply): Promise<TurnReplyView | FastifyReply> => {
    const view = ledger.turnReplyOf(idParam(req.params, "message id"));
    return view === null ? fail(reply, "not_found") : view;
  });

  routes.post("/api/messages/:id/retry", async (req, reply) => {
    const result = ledger.retryMessage(idParam(req.params, "message id"));
    return reply.code(202).send({ messageId: result.messageId } satisfies RetryMessageResponse);
  });
}

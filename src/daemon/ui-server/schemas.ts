import { z } from "zod";
import {
  AGENT_VENDORS,
  ATTACHMENTS_TOO_MANY_MESSAGE,
  LedgerRequestError,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DECISION_CHOICE_CHARS,
  MAX_DECISION_NOTE_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_MODEL_CHARS,
  MAX_PATH_BYTES,
  MAX_PERSONA_BYTES,
  MAX_REASON_CHARS,
  MAX_VENDOR_SYNC_KEY_CHARS,
  MAX_VENDOR_SYNC_MCP_ITEMS,
  MAX_VENDOR_SYNC_SKILL_ITEMS,
  PM_CAPABILITY_PATCH_MAX_KEYS,
  PM_MODES,
  PROVIDER_API_KEY_MAX_CHARS,
  PROVIDER_AUTH_INPUT_MAX_CHARS,
  ROUTER_COMMAND_MAX_CHARS,
  isJellyColorId,
  isPmFruit,
  isValidCapabilityKey,
  normalizeName,
  type AgentVendor,
  type CapabilityBase,
  type CapabilityKind,
  type CreatePmRequest,
  type EditPersonaRequest,
  type JellyColorId,
  type CapabilitiesPatch,
  type PmFruit,
  type PmLookRequest,
  type WorkerPick,
} from "../../shared/index.ts";
import { workerPickSchema } from "../../shared/worker-pick-schema.ts";
import { HttpError, MAX_CLIENT_ID_LENGTH, boundedBytesSchema, boundedCharsSchema, parseWithSchema } from "./http.ts";

const nameSchema = z.string().refine((s) => normalizeName(s) !== null, "invalid name");
const modeSchema = z.enum(PM_MODES);
const vendorSchema = z.enum(AGENT_VENDORS);
const optionalSettingSchema = (what: string) => boundedCharsSchema(MAX_MODEL_CHARS, what).nullable();

const pmCapabilitiesStartSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("all") }).strict(),
  z.object({ from: z.literal("pm"), pmId: z.number().int().positive() }).strict(),
]);

const pmFruitSchema = z.string().refine(isPmFruit, "unknown fruit").transform((s) => s as PmFruit);
const jellyColorSchema = z.string().refine(isJellyColorId, "unknown color").transform((s) => s as JellyColorId);

const pmLookBodySchema = z.object({ fruit: pmFruitSchema.nullable(), color: jellyColorSchema.nullable() }).strict();

export function parsePmLookBody(body: unknown): PmLookRequest {
  return parseWithSchema(pmLookBodySchema, body);
}

const createPmBodySchema = z
  .object({
    name: nameSchema,
    mode: modeSchema,
    persona: boundedBytesSchema(MAX_PERSONA_BYTES, "persona"),
    vendor: vendorSchema.optional(),
    defaultModel: optionalSettingSchema("defaultModel").optional(),
    effort: optionalSettingSchema("effort").optional(),
    folder: boundedBytesSchema(MAX_PATH_BYTES, "folder")
      .refine((s) => s.trim() !== "" && !s.includes("\u0000"), "folder must be a non-empty path")
      .optional(),
    capabilities: pmCapabilitiesStartSchema.optional(),
    look: z.object({ fruit: pmFruitSchema, color: jellyColorSchema }).strict().optional(),
  })
  .strict();

export function parseCreatePmBody(body: unknown): CreatePmRequest {
  const raw = parseWithSchema(createPmBodySchema, body);
  return {
    name: raw.name,
    mode: raw.mode,
    persona: raw.persona,
    ...(raw.vendor !== undefined ? { vendor: raw.vendor } : {}),
    ...(raw.defaultModel !== undefined ? { defaultModel: raw.defaultModel } : {}),
    ...(raw.effort !== undefined ? { effort: raw.effort } : {}),
    ...(raw.folder !== undefined ? { folder: raw.folder } : {}),
    ...(raw.capabilities !== undefined ? { capabilities: raw.capabilities } : {}),
    ...(raw.look !== undefined ? { look: raw.look } : {}),
  };
}

const capabilityBaseSchema = z.enum(["all", "none"]);

const capabilitiesPatchBodySchema = z
  .object({
    base: z
      .object({
        skill: capabilityBaseSchema.optional(),
        mcp: capabilityBaseSchema.optional(),
        connector: capabilityBaseSchema.optional(),
      })
      .strict()
      .optional(),
    set: z
      .record(
        z.string().refine((k) => isValidCapabilityKey(k), "invalid capability key"),
        z.boolean().nullable(),
      )
      .refine(
        (rec) => Object.keys(rec).length <= PM_CAPABILITY_PATCH_MAX_KEYS,
        `at most ${PM_CAPABILITY_PATCH_MAX_KEYS} capability keys`,
      )
      .optional(),
  })
  .strict()
  .refine(
    (obj) =>
      (obj.base !== undefined && Object.keys(obj.base).length > 0) ||
      (obj.set !== undefined && Object.keys(obj.set).length > 0),
    "at least one of base or set must be non-empty",
  );

export function parseCapabilitiesPatchBody(body: unknown): CapabilitiesPatch {
  const raw = parseWithSchema(capabilitiesPatchBodySchema, body);
  let base: Partial<Record<CapabilityKind, CapabilityBase>> | undefined;
  if (raw.base !== undefined) {
    base = {
      ...(raw.base.skill !== undefined ? { skill: raw.base.skill } : {}),
      ...(raw.base.mcp !== undefined ? { mcp: raw.base.mcp } : {}),
      ...(raw.base.connector !== undefined ? { connector: raw.base.connector } : {}),
    };
  }
  return {
    ...(base !== undefined && Object.keys(base).length > 0 ? { base } : {}),
    ...(raw.set !== undefined ? { set: raw.set } : {}),
  };
}

export const putProjectSetupCommandBodySchema = z.object({ command: z.string().nullable() }).strict();

const editPersonaBodySchema = z
  .object({
    text: boundedBytesSchema(MAX_PERSONA_BYTES, "text").optional(),
    mode: modeSchema.optional(),
    vendor: vendorSchema.optional(),
    model: optionalSettingSchema("model").optional(),
    effort: optionalSettingSchema("effort").optional(),
    reason: boundedCharsSchema(MAX_REASON_CHARS, "reason").optional(),
  })
  .strict()
  .refine(
    (v) => v.text !== undefined || v.mode !== undefined || v.vendor !== undefined || v.model !== undefined || v.effort !== undefined,
    "one of text, mode, vendor, model, effort is required",
  );

export function parseEditPersonaBody(body: unknown): EditPersonaRequest {
  const raw = parseWithSchema(editPersonaBodySchema, body);
  return {
    ...(raw.text !== undefined ? { text: raw.text } : {}),
    ...(raw.mode !== undefined ? { mode: raw.mode } : {}),
    ...(raw.vendor !== undefined ? { vendor: raw.vendor } : {}),
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    ...(raw.effort !== undefined ? { effort: raw.effort } : {}),
    ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
  };
}

const postMessageBodySchema = z.object({
  clientId: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
  text: z.string(),
  attachmentIds: z.array(z.string()).optional(),
  workerPick: workerPickSchema.optional(),
});

export function parsePostBody(body: unknown): { clientId: string; text: string; attachmentIds: string[]; workerPick?: WorkerPick } {
  const { clientId, text, attachmentIds: rawIds, workerPick } = parseWithSchema(postMessageBodySchema, body);
  const ids = [...new Set(rawIds ?? [])];
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new LedgerRequestError("invalid", ATTACHMENTS_TOO_MANY_MESSAGE);
  if (text.trim().length === 0 && ids.length === 0) throw new HttpError(400, "text must not be empty");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
    throw new HttpError(400, `text must be at most ${MAX_MESSAGE_BYTES} bytes`);
  }
  return { clientId, text, attachmentIds: ids, ...(workerPick !== undefined ? { workerPick } : {}) };
}

export const emptyObjectBodySchema = z.object({}).strict();
export const addScheduleBodySchema = z
  .object({
    name: z.unknown().optional(),
    prompt: z.unknown().optional(),
    daily: z.unknown().optional(),
    everyMinutes: z.unknown().optional(),
  })
  .strict();
export const setScheduleEnabledBodySchema = z.object({ enabled: z.boolean() }).strict();
export const putPmMemoryFileBodySchema = z.object({ content: z.string() }).strict();
export const pickFolderBodySchema = z.object({ startDir: boundedBytesSchema(MAX_PATH_BYTES, "startDir").optional() }).strict();
export const pushUnsubscribeBodySchema = z.object({ endpoint: z.string() });

export const resolveRouterItemBodySchema = z.union([
  z.object({ action: z.literal("archive") }).strict(),
  z
    .object({
      clientId: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
      optionIndex: z.number().int().nonnegative().nullable().optional(),
      choice: boundedCharsSchema(MAX_DECISION_CHOICE_CHARS, "choice").nullable().optional(),
      note: boundedCharsSchema(MAX_DECISION_NOTE_CHARS, "note").optional(),
    })
    .strict(),
]);

export const decideRouterItemBodySchema = z
  .object({
    clientId: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
    optionIndex: z.number().int().nonnegative().nullable().optional(),
    choice: boundedCharsSchema(MAX_DECISION_CHOICE_CHARS, "choice").nullable().optional(),
    note: boundedCharsSchema(MAX_DECISION_NOTE_CHARS, "note").optional(),
  })
  .strict();

export const postRouterCommandBodySchema = z
  .object({
    clientId: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
    text: boundedCharsSchema(ROUTER_COMMAND_MAX_CHARS, "text"),
    attachmentIds: z.array(z.string().min(1).max(100)).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    target: z
      .object({
        deviceId: z.string().max(200).optional(),
        pmId: z.number().int().positive().optional(),
        projectId: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const updateRouterSettingsBodySchema = z
  .object({
    vendor: vendorSchema.nullable(),
    model: optionalSettingSchema("model"),
    effort: optionalSettingSchema("effort"),
  })
  .strict();

export const decideTaskNodeBodySchema = z
  .object({
    clientId: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
    choice: boundedCharsSchema(MAX_DECISION_CHOICE_CHARS, "choice").nullable().optional(),
    note: boundedCharsSchema(MAX_DECISION_NOTE_CHARS, "note").nullable().optional(),
  })
  .strict();

export const skipTaskNodeBodySchema = z
  .object({
    reason: boundedCharsSchema(MAX_DECISION_NOTE_CHARS, "reason").optional(),
  })
  .strict();

export const cancelTaskGraphBodySchema = z
  .object({
    reason: boundedCharsSchema(MAX_DECISION_NOTE_CHARS, "reason").optional(),
  })
  .strict();

const syncItemKeySchema = boundedCharsSchema(MAX_VENDOR_SYNC_KEY_CHARS, "key").refine(
  (s) => s.trim() !== "" && !s.includes("\u0000"),
  "key must not be empty",
);

export const vendorSyncApplyBodySchema = z
  .object({
    selectedMcpKeys: z.array(syncItemKeySchema).max(MAX_VENDOR_SYNC_MCP_ITEMS),
    removeMcpKeys: z.array(syncItemKeySchema).max(MAX_VENDOR_SYNC_MCP_ITEMS),
    selectedSkillKeys: z.array(syncItemKeySchema).max(MAX_VENDOR_SYNC_SKILL_ITEMS),
    removeSkillKeys: z.array(syncItemKeySchema).max(MAX_VENDOR_SYNC_SKILL_ITEMS),
    confirmedHostBoundMcpKeys: z.array(syncItemKeySchema).max(MAX_VENDOR_SYNC_MCP_ITEMS).optional(),
  })
  .strict();

export const providerCancelJobBodySchema = z
  .object({
    jobId: z.string().min(1).max(128),
  })
  .strict();

export const providerStartAuthBodySchema = z
  .object({
    methodId: z.string().min(1).max(64),
    variantId: z.string().min(1).max(64).optional(),
    targetId: z.string().min(1).max(64).optional(),
    remoteHint: z.boolean().optional(),
  })
  .strict();

export const providerSubmitAuthBodySchema = z
  .object({
    flowId: z.string().min(1).max(128),
    input: boundedCharsSchema(PROVIDER_AUTH_INPUT_MAX_CHARS, "input").refine(
      (s) => s.trim() !== "",
      "input must not be empty",
    ),
  })
  .strict();

export const providerCancelAuthBodySchema = z
  .object({
    flowId: z.string().min(1).max(128),
  })
  .strict();

export const providerSaveApiKeyBodySchema = z
  .object({
    targetId: z.string().min(1).max(64).optional(),
    apiKey: boundedCharsSchema(PROVIDER_API_KEY_MAX_CHARS, "apiKey").refine(
      (s) => s.trim() !== "",
      "apiKey must not be empty",
    ),
  })
  .strict();

export const providerLogoutBodySchema = z
  .object({
    targetId: z.string().min(1).max(64).optional(),
  })
  .strict();

export const selfReloadBodySchema = z.object({ build: z.boolean().optional() }).strict();

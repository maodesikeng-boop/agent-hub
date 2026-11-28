// Invariant: every untrusted remote DeviceRouterDigest is parsed and normalized into the domain type before caching or dispatch, rejecting malformed structures while stripping unknown future keys and defaulting omitted legacy optional fields.
import { z } from "zod";
import { PM_MODES, SESSION_ACTIVITIES } from "./domain.ts";
import type { DeviceRouterDigest, PmDigestActiveWorker, PmDigestEntry } from "./router.ts";
import { AGENT_VENDORS, DEFAULT_AGENT_VENDOR } from "./vendors.ts";

export type DeviceRouterDigestParseResult =
  | { readonly ok: true; readonly digest: DeviceRouterDigest }
  | { readonly ok: false; readonly reason: string };

const finiteNumber = z.number().finite();
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

const projectCatalogCardSchema = z.object({
  oneLiner: z.string(),
  aliases: z.array(z.string()),
  focus: z.string(),
  refreshedAt: finiteNumber,
});

const pmDigestProjectSchema = z.object({
  id: positiveInt,
  name: z.string(),
  description: z.string().nullable().optional(),
  mainFolder: z.string(),
  otherFolders: z.array(z.string()).optional(),
  catalog: projectCatalogCardSchema.nullable().optional(),
});

const pmDigestActiveWorkerSchema = z.object({
  id: positiveInt,
  title: z.string(),
  activity: z.enum(SESSION_ACTIVITIES),
  lastSummary: z.string().nullable().optional(),
  readonly: z.boolean().optional(),
});

const pmDigestEntrySchema = z.object({
  pmId: positiveInt,
  name: z.string(),
  mode: z.enum(PM_MODES),
  vendor: z.enum(AGENT_VENDORS).optional(),
  model: z.string().nullable().optional(),
  conversationId: positiveInt.optional(),
  activity: z.enum(SESSION_ACTIVITIES),
  project: pmDigestProjectSchema.nullable().optional(),
  activeWorkers: z.array(pmDigestActiveWorkerSchema).optional(),
  activeWorkerTotal: nonNegativeInt.optional(),
  pendingDecisionCount: nonNegativeInt,
  recentBrief: z.string().nullable().optional(),
  lastActiveAt: finiteNumber.nullable().optional(),
});

const deviceRouterDigestSchema = z.object({
  generatedAt: finiteNumber,
  pms: z.array(pmDigestEntrySchema),
  omittedPms: nonNegativeInt.optional(),
});

/**
 * Precondition: raw is the result of JSON.parse on a remote /api/router/digest response body.
 * Postcondition: returns { ok: true, digest } with guaranteed arrays and domain types when raw satisfies the DeviceRouterDigest contract (allowing unknown extra keys and legacy omitted optional fields), or { ok: false, reason } when required fields are missing or any present field has an invalid type or shape.
 */
export function parseDeviceRouterDigest(raw: unknown): DeviceRouterDigestParseResult {
  const parsed = deviceRouterDigestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue !== undefined && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return { ok: false, reason: `${path}${issue?.message ?? "invalid digest"}` };
  }

  const pms: PmDigestEntry[] = parsed.data.pms.map((pm) => {
    const activeWorkers: PmDigestActiveWorker[] = (pm.activeWorkers ?? []).map((worker) => ({
      id: worker.id,
      title: worker.title,
      activity: worker.activity,
      lastSummary: worker.lastSummary ?? null,
      ...(worker.readonly !== undefined ? { readonly: worker.readonly } : {}),
    }));
    const project = pm.project
      ? {
          id: pm.project.id,
          name: pm.project.name,
          description: pm.project.description ?? null,
          mainFolder: pm.project.mainFolder,
          otherFolders: pm.project.otherFolders ?? [],
          ...(pm.project.catalog !== undefined ? { catalog: pm.project.catalog } : {}),
        }
      : null;
    return {
      pmId: pm.pmId,
      name: pm.name,
      mode: pm.mode,
      vendor: pm.vendor ?? DEFAULT_AGENT_VENDOR,
      model: pm.model ?? null,
      ...(pm.conversationId !== undefined ? { conversationId: pm.conversationId } : {}),
      activity: pm.activity,
      project,
      activeWorkers,
      activeWorkerTotal: pm.activeWorkerTotal ?? activeWorkers.length,
      pendingDecisionCount: pm.pendingDecisionCount,
      recentBrief: pm.recentBrief ?? null,
      lastActiveAt: pm.lastActiveAt ?? null,
    };
  });

  const digest: DeviceRouterDigest = {
    generatedAt: parsed.data.generatedAt,
    pms,
    ...(parsed.data.omittedPms !== undefined ? { omittedPms: parsed.data.omittedPms } : {}),
  };
  return { ok: true, digest };
}

// Helpers every runner shares: the bench PMs, bounded evidence files, waiting, and turning errors into observations.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_PATHS, type AgentVendor, type CreatePmRequest, type CreatePmResponse, type StateSnapshot } from "../../../src/shared/index.ts";
import type { InstanceClient } from "../bench.ts";
import { FeishuApiError, type FeishuMessage, isRecalled } from "../feishu-driver.ts";
import { ApiError } from "../instance-client.ts";
import { scenarioMarker, type BenchScenario } from "../fake-script.ts";
import { TESTER_EVIDENCE_MAX_BYTES_PER_FLOW, TESTER_POLL_MS } from "../limits.ts";
import type { CheckResult, ExternalError, FlowContext, FlowObservation, InstanceRole } from "../types.ts";
import { ExternalServiceError } from "../verdict.ts";
import { VENDOR_BENCH } from "../vendors.ts";

export const BENCH_PM_PREFIX = "bench-";

export interface BenchPmSpec {
  name: string;
  request: CreatePmRequest;
}

export function scenarioPm(scenario: BenchScenario): BenchPmSpec {
  return { name: `${BENCH_PM_PREFIX}${scenario}`, request: { name: `${BENCH_PM_PREFIX}${scenario}`, mode: "manage_only", vendor: "claude", persona: `Bench PM for scripted runs. ${scenarioMarker(scenario)}` } };
}

export function vendorPm(vendor: AgentVendor, instance: InstanceRole): BenchPmSpec {
  const recipe = VENDOR_BENCH[vendor][instance];
  const model = recipe.coverage === "turn" ? recipe.model : null;
  return {
    name: `${BENCH_PM_PREFIX}${vendor}`,
    request: { name: `${BENCH_PM_PREFIX}${vendor}`, mode: "manage_only", vendor, ...(model ? { defaultModel: model } : {}), persona: "Bench PM. Answer every message with one short line and do not start Workers." },
  };
}

export function workerPm(sandboxProject: string): BenchPmSpec {
  return {
    name: `${BENCH_PM_PREFIX}worker`,
    request: { name: `${BENCH_PM_PREFIX}worker`, mode: "manage_only", vendor: "claude", defaultModel: "haiku", folder: sandboxProject, persona: "Bench PM. Delegate every change to one Worker on the cheapest model and report back in one line." },
  };
}

/** Postcondition: the PM named spec.name on the instance, created when missing, with its PM conversation id. */
export async function ensureBenchPm(client: InstanceClient, spec: BenchPmSpec): Promise<{ pmId: number; conversationId: number }> {
  const find = (state: StateSnapshot) => {
    const pm = state.pms.find((p) => p.name === spec.name && !p.archivedAt);
    const conversation = pm && state.conversations.find((c) => c.conversation.kind === "pm" && c.conversation.pmId === pm.id);
    return pm && conversation ? { pmId: pm.id, conversationId: conversation.conversation.id } : null;
  };
  const existing = find(await client.state());
  if (existing !== null) return existing;
  const created = await client.api.json<CreatePmResponse>("POST", API_PATHS.pms, spec.request);
  return { pmId: created.pmId, conversationId: created.conversationId };
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason as Error)), { once: true });
  });

/** Postcondition: the first non-undefined value of `probe` within `timeoutMs`, or null at the deadline. Errors of `probe` count as not yet. */
export async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number, signal: AbortSignal, everyMs = TESTER_POLL_MS): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(everyMs, Math.max(0, deadline - Date.now())), signal);
  }
}

/** Collects one flow's checks, metrics, and evidence. Evidence is capped at TESTER_EVIDENCE_MAX_BYTES_PER_FLOW per flow. */
export class Observation {
  readonly checks: CheckResult[] = [];
  readonly externalErrors: ExternalError[] = [];
  readonly metrics: Record<string, number> = {};
  readonly evidence: string[] = [];
  vendorTrouble?: FlowObservation["vendorTrouble"];
  #bytes = 0;
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  check(check: string, ok: boolean, detail: string): void {
    this.checks.push({ check, ok, detail });
  }

  save(name: string, content: string): void {
    const room = TESTER_EVIDENCE_MAX_BYTES_PER_FLOW - this.#bytes;
    const bytes = Buffer.byteLength(content);
    const body = bytes <= room ? content : `${Buffer.from(content).subarray(0, Math.max(0, room - 200)).toString("utf8")}\n[truncated: evidence cap of ${TESTER_EVIDENCE_MAX_BYTES_PER_FLOW} bytes per flow reached]\n`;
    const file = join(this.#dir, name);
    if (existsSync(file)) appendFileSync(file, body);
    else writeFileSync(file, body);
    this.#bytes += Buffer.byteLength(body);
    if (!this.evidence.includes(name)) this.evidence.push(name);
  }

  json(name: string, value: unknown): void {
    this.save(name, `${JSON.stringify(value, null, 2)}\n`);
  }

  external(service: ExternalError["service"], detail: string): void {
    this.externalErrors.push({ service, detail });
  }

  result(): FlowObservation {
    return { checks: this.checks, externalErrors: this.externalErrors, metrics: this.metrics, evidence: this.evidence, ...(this.vendorTrouble ? { vendorTrouble: this.vendorTrouble } : {}) };
  }
}

/** Maps a failure at a boundary to the service that failed; anything else stays a product error. */
export function externalOf(error: unknown): ExternalServiceError | null {
  if (error instanceof ExternalServiceError) return error;
  if (error instanceof FeishuApiError && (error.status >= 500 || error.status === 429 || error.code === -1)) return new ExternalServiceError("feishu", error.message);
  if (error instanceof ApiError && error.status === 502 && /device_offline/.test(error.message)) return new ExternalServiceError("relay", error.message);
  if (error instanceof TypeError && /fetch failed/.test(error.message)) return new ExternalServiceError("bench", error.message);
  return null;
}

/** Runs a runner body; a boundary failure becomes an external error, anything else propagates to the verdict as a product error. */
export function runner(body: (ctx: FlowContext, obs: Observation) => Promise<void>) {
  return async (ctx: FlowContext): Promise<FlowObservation> => {
    const obs = new Observation(ctx.evidenceDir);
    try {
      await body(ctx, obs);
    } catch (error) {
      const external = externalOf(error);
      if (external === null) throw error;
      obs.external(external.service, external.message);
    }
    return obs.result();
  };
}

/** A short tag that makes each run's messages unique, so a flow never matches a reply from an earlier run. */
export const runTag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function recallCheck(obs: Observation, messages: readonly FeishuMessage[], botAppId: string): void {
  const recalled = messages.filter((m) => m.senderType === "app" && m.senderId === botAppId && isRecalled(m));
  obs.check("no-recall", recalled.length === 0, recalled.length === 0 ? "no test bot message was recalled" : `recalled: ${recalled.map((m) => m.messageId).join(", ")}`);
}

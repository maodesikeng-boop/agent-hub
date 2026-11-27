// Invariant: telemetry pre- and post-call filesystem I/O runs outside SQLite transactions and checks AbortSignal before touching state files.
import {
  DAILY_TELEMETRY_FORMATS,
  DAILY_TELEMETRY_SCOPES,
  DAILY_TELEMETRY_SECTIONS,
  resolveTelemetryWindow,
  type DailyTelemetrySection,
} from "../../shared/daily-telemetry.ts";
import type { FeatureMiningState } from "../../shared/feature-mining.ts";
import type { HubCallContext } from "../../shared/ledger.ts";
import { readBoundedOperationalLogs } from "../ledger/daily-telemetry.ts";
import { readMiningInputs, writeMiningStateAtomic } from "../ledger/feature-mining.ts";

export interface AgentApiTelemetryOptions {
  readonly logsDir?: string;
  readonly setupLogsDir?: string;
  readonly deniedPaths?: readonly string[];
  readonly now?: () => number;
}

const pathField = { type: "string", minLength: 1 };

export const TELEMETRY_BODY_SCHEMAS = {
  "telemetry.export": {
    type: "object",
    additionalProperties: false,
    properties: {
      windowMs: { type: "integer", minimum: 1 },
      sinceMs: { type: "integer", minimum: 0 },
      untilMs: { type: "integer", minimum: 0 },
      scope: { type: "string", enum: [...DAILY_TELEMETRY_SCOPES] },
      sections: { type: "array", minItems: 1, items: { type: "string", enum: [...DAILY_TELEMETRY_SECTIONS] } },
      format: { type: "string", enum: [...DAILY_TELEMETRY_FORMATS] },
    },
  },
  "telemetry.mine": {
    type: "object",
    additionalProperties: false,
    properties: {
      windowMs: { type: "integer", minimum: 1 },
      sinceMs: { type: "integer", minimum: 0 },
      untilMs: { type: "integer", minimum: 0 },
      scope: { type: "string", enum: [...DAILY_TELEMETRY_SCOPES] },
      backlogPaths: { type: "array", items: pathField },
      statePath: pathField,
      dryRun: { type: "boolean" },
    },
  },
} as const;

export async function prepareTelemetryCall(
  telemetry: AgentApiTelemetryOptions | undefined,
  command: "telemetry.export" | "telemetry.mine",
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<HubCallContext> {
  const context: HubCallContext = {};
  const sections = body.sections as DailyTelemetrySection[] | undefined;
  const wantsLogs = command === "telemetry.mine" || sections === undefined || sections.includes("logs");
  if (wantsLogs && telemetry !== undefined && (telemetry.logsDir !== undefined || telemetry.setupLogsDir !== undefined)) {
    const window = resolveTelemetryWindow({
      sinceMs: body.sinceMs as number | undefined,
      untilMs: body.untilMs as number | undefined,
      windowMs: body.windowMs as number | undefined,
      nowMs: (telemetry.now ?? Date.now)(),
    });
    context.telemetryLogs = await readBoundedOperationalLogs({
      logsDir: telemetry.logsDir,
      setupLogsDir: telemetry.setupLogsDir,
      sinceMs: window.sinceMs,
      untilMs: window.untilMs,
      signal,
    });
  }
  if (signal.aborted || command !== "telemetry.mine") return context;
  const backlogPaths = body.backlogPaths as string[] | undefined;
  const statePath = body.statePath as string | undefined;
  if ((backlogPaths !== undefined && backlogPaths.length > 0) || statePath !== undefined) {
    const loaded = await readMiningInputs({
      backlogPaths,
      statePath,
      deniedPaths: telemetry?.deniedPaths,
      signal,
    });
    context.miningBacklog = loaded.backlog;
    context.miningPriorState = loaded.priorState;
    context.miningStateRecovered = loaded.stateRecoveredFromCorrupt;
  }
  return context;
}

export async function persistMiningStateAfterCall(
  telemetry: AgentApiTelemetryOptions | undefined,
  body: Record<string, unknown>,
  data: unknown,
  signal: AbortSignal,
): Promise<void> {
  if (body.dryRun === true || typeof body.statePath !== "string" || signal.aborted) return;
  const mined = data as { result?: { nextState?: FeatureMiningState } } | undefined;
  if (mined?.result?.nextState === undefined) return;
  await writeMiningStateAtomic({
    statePath: body.statePath,
    state: mined.result.nextState,
    nowMs: (telemetry?.now ?? Date.now)(),
    deniedPaths: telemetry?.deniedPaths,
    signal,
  });
}

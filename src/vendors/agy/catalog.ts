import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  ALL_EFFORTS,
  MAX_CATALOG_DESCRIPTION_CHARS,
  MAX_CATALOG_LABEL_CHARS,
  MAX_CATALOG_MODELS,
  MODEL_CATALOG_TIMEOUT_MS,
  bundledModelCatalog,
  checkModel,
  mergeCatalogEfforts,
  splitEffortSuffix,
  truncateChars,
  type CatalogModel,
  type ModelCatalog,
} from "../../shared/index.ts";
import spec from "./spec.ts";
import { spawnOwnedProcess } from "../../daemon/platform/index.ts";
import {
  STDERR_TAIL_CHARS,
  defaultAvailabilityOfError,
  nonEmptyString,
  parseJsonOutput,
  type VendorCatalogSource,
} from "../../daemon/driver/model-catalog.ts";
import { closeAndWaitChild, killChildAndWait, termGroupAfterExit } from "../../daemon/driver/process.ts";
import { buildChildEnv } from "../../daemon/driver/protocol.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import type { VendorCatalogProbe, VendorCatalogSourceOptions } from "../../daemon/vendors/types.ts";

const AGY_MODELS_QUERY_ARGS: readonly string[] = ["--output-format", "json", "models"];
const AGY_SKILLS_QUERY_ARGS: readonly string[] = ["-p", "/skills", "--output-format", "json"];

function extractAgyModels(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as {
    models?: unknown;
    data?: { models?: unknown };
    command?: { data?: { models?: unknown } };
  };
  if (Array.isArray(r.command?.data?.models)) return r.command.data.models;
  if (Array.isArray(r.data?.models)) return r.data.models;
  if (Array.isArray(r.models)) return r.models;
  return null;
}

function splitLabelTier(label: string): { base: string; tier: string } | null {
  const m = /^(.*\S)\s*\(([^()]+)\)$/.exec(label);
  return m === null ? null : { base: m[1]!, tier: m[2]!.trim().toLowerCase() };
}

// agy encodes effort in the model ID (gemini-4-argon-high); split it the way the Antigravity app does.
export function parseAgyModels(raw: unknown): ModelCatalog | null {
  const list = extractAgyModels(raw);
  if (list === null) return null;
  const tiers = [...spec.models.efforts, ...ALL_EFFORTS.filter((e) => !spec.models.efforts.includes(e))];
  const found = new Map<string, { label: string; description: string | null; efforts: Set<string> }>();
  const seen = new Set<string>();
  let defaultModel: string | null = null;
  let defaultBaseId: string | null = null;
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : typeof entry.value === "string" ? entry.value : null;
    if (id === null || checkModel("agy", id) !== null || seen.has(id)) continue;
    seen.add(id);
    const fullLabel = nonEmptyString(entry.label) ?? nonEmptyString(entry.displayName) ?? id;
    const idSplit = splitEffortSuffix(id, tiers);
    const labelSplit = splitLabelTier(fullLabel);
    const tiered = idSplit !== null && labelSplit !== null && labelSplit.tier === idSplit.effort;
    const baseId = tiered ? idSplit.base : id;
    const label = truncateChars(tiered ? labelSplit.base : fullLabel, MAX_CATALOG_LABEL_CHARS);
    if ((entry.currently_selected === true || entry.isDefault === true) && defaultModel === null) {
      defaultModel = label;
      defaultBaseId = baseId;
    }
    const rawDesc = nonEmptyString(entry.description);
    const description = rawDesc === null ? null : truncateChars(rawDesc, MAX_CATALOG_DESCRIPTION_CHARS);
    let model = found.get(baseId);
    if (model === undefined) {
      if (found.size === MAX_CATALOG_MODELS) continue;
      model = { label, description, efforts: new Set() };
      found.set(baseId, model);
    } else if (model.description === null && description !== null) {
      model.description = description;
    }
    if (tiered) model.efforts.add(idSplit.effort);
  }
  if (found.size === 0) return null;
  const models: CatalogModel[] = [...found].map(([id, m]) => ({
    id,
    label: m.label,
    description: m.description,
    efforts: tiers.filter((t) => m.efforts.has(t)),
  }));
  const defaultEfforts = defaultBaseId === null ? null : (models.find((m) => m.id === defaultBaseId)?.efforts ?? null);
  const efforts = mergeCatalogEfforts(spec.models.efforts, models, defaultEfforts);
  return { ...bundledModelCatalog("agy"), source: "vendor", efforts, models, defaultEfforts, defaultModel };
}

export interface AgyModelQueryOptions {
  agyPath: string;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

function runAgyJsonCommand(options: AgyModelQueryOptions, args: readonly string[], label: string): Promise<unknown> {
  const { agyPath, cwd, timeoutMs = MODEL_CATALOG_TIMEOUT_MS, signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    let spawned: { child: ChildProcessWithoutNullStreams; detached: boolean };
    try {
      spawned = spawnOwnedProcess(agyPath, [...args], {
        cwd,
        env: buildChildEnv(options.env ?? process.env, undefined),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      return reject(err);
    }
    const { child, detached } = spawned;
    trackChild(child, "probe:agy", { detached });
    child.once("exit", () => termGroupAfterExit(child));
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        void killChildAndWait(child).finally(() => reject(error));
        return;
      }
      if (child.exitCode === null && child.signalCode === null) {
        void closeAndWaitChild(child, { signal }).finally(() => resolve(result));
        return;
      }
      resolve(result);
    };
    const onAbort = () => finish(new Error("cancelled"));
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => finish(new Error(`agy 超时（${timeoutMs} ms 没回 ${label}）`)), timeoutMs);

    child.once("error", (error) => finish(new Error(`${agyPath}: ${error.message}`)));
    child.stdin.on("error", () => {});
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.once("close", (code, sig) => {
      if (code === 0) {
        const parsed = parseJsonOutput(stdout);
        if (parsed.ok) {
          finish(null, parsed.value);
          return;
        }
        const said = `${stdout.trim().slice(-STDERR_TAIL_CHARS)} ${stderr.trim()}`.trim();
        finish(new Error(`agy 没回有效 JSON（${label}）${said ? `：${said}` : ""}`));
        return;
      }
      finish(new Error(`agy 没回 ${label} 就退出了（${sig ?? `退出码 ${code}`}）${stderr.trim() ? `：${stderr.trim()}` : ""}`));
    });
  });
}

export function queryAgyModels(options: AgyModelQueryOptions): Promise<unknown> {
  return runAgyJsonCommand(options, AGY_MODELS_QUERY_ARGS, "models");
}

export function queryAgySkills(options: AgyModelQueryOptions): Promise<unknown> {
  return runAgyJsonCommand(options, AGY_SKILLS_QUERY_ARGS, "skills");
}

// Signed out, agy still exits 0 and prints prose instead of JSON.
const AGY_SIGNED_OUT_PATTERN = /sign in/i;

export const agyCatalogProbe: VendorCatalogProbe = {
  parse: parseAgyModels,
  availabilityOf: () => "available",
  availabilityOfError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return AGY_SIGNED_OUT_PATTERN.test(message) ? "signed_out" : defaultAvailabilityOfError("agy", error);
  },
};

export function createAgyCatalogSource(options: VendorCatalogSourceOptions): VendorCatalogSource {
  return {
    ...agyCatalogProbe,
    query: (signal) => {
      const agyPath = typeof options.path === "function" ? options.path() : options.path;
      const env = typeof options.env === "function" ? options.env() : options.env;
      return queryAgyModels({ agyPath, cwd: options.cwd, ...(env ? { env } : {}), signal });
    },
    installed: options.installed,
    ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
  };
}

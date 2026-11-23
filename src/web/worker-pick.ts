import {
  effortLabel,
  effortsFor,
  isAgentVendor,
  isSelectable,
  modelLabel,
  normalizeEffortInput,
  pickableVendorCatalogs,
  vendorLabel,
  WORKER_PICK_CACHE_MAX,
  type ModelCatalog,
  type WorkerPick,
} from "../shared/index.ts";
import type { MenuItem } from "./composer-suggest.ts";
import { rankMatches, WORKER_ARG_LEVELS } from "./composer-trigger.ts";
import { DEFAULT_CHOICE, defaultModelText } from "./format.ts";

export const WORKER_PICK_DEFAULT = "default";

export type WorkerPickLevel = "vendor" | "model" | "effort";
const LEVELS: readonly WorkerPickLevel[] = ["vendor", "model", "effort"];

export interface WorkerPickRows {
  level: WorkerPickLevel;
  items: MenuItem[];
}

interface Candidate {
  value: string;
  label: string;
  detail: string;
  disabled?: true;
}

const DEFAULT_NAMES = [WORKER_PICK_DEFAULT, DEFAULT_CHOICE];

function rank(level: WorkerPickLevel, candidates: readonly Candidate[], query: string): WorkerPickRows {
  const ranked = rankMatches(candidates, query, (c) => (c.value === WORKER_PICK_DEFAULT ? DEFAULT_NAMES : [c.value, c.label]), (c) => c.detail);
  return {
    level,
    items: ranked.map((c) => ({
      id: `worker:${level}:${c.value}`,
      label: c.label,
      detail: c.detail,
      insert: c.value,
      ...(c.disabled && { disabled: true }),
    })),
  };
}

function compute(catalogs: readonly ModelCatalog[], args: readonly string[], query: string): WorkerPickRows | null {
  if (args.length >= WORKER_ARG_LEVELS) return null;
  const level = LEVELS[args.length]!;
  if (level === "vendor") {
    const vendors = pickableVendorCatalogs(catalogs);
    return rank(
      level,
      vendors.map((c) => ({ value: c.vendor, label: c.label, detail: "" })),
      query,
    );
  }
  const catalog = catalogs.find((c) => c.vendor === args[0]);
  if (!catalog || !isSelectable(catalog.availability)) return null;
  if (level === "model") {
    return rank(
      level,
      [
        { value: WORKER_PICK_DEFAULT, label: DEFAULT_CHOICE, detail: catalog.defaultModel === null ? "" : defaultModelText(catalog) },
        ...catalog.models.map((m) => ({ value: m.id, label: m.label, detail: m.description ?? "" })),
      ],
      query,
    );
  }
  const model = args[1] === WORKER_PICK_DEFAULT ? null : args[1]!;
  if (model !== null && !catalog.models.some((m) => m.id === model)) return null;
  const efforts = effortsFor(catalog, model);
  if (efforts.length <= 1) return null;
  return rank(
    level,
    [
      { value: WORKER_PICK_DEFAULT, label: DEFAULT_CHOICE, detail: "" },
      ...efforts.map((e) => ({ value: e, label: effortLabel(e, catalog.vendor, catalog), detail: "" })),
    ],
    query,
  );
}

const cache = new WeakMap<readonly ModelCatalog[], Map<string, WorkerPickRows | null>>();

export function workerPickRows(catalogs: readonly ModelCatalog[], args: readonly string[], query: string): WorkerPickRows | null {
  let byInput = cache.get(catalogs);
  if (!byInput) {
    byInput = new Map();
    cache.set(catalogs, byInput);
  }
  const key = `${args.join(" ")}\n${query}`;
  if (byInput.has(key)) return byInput.get(key)!;
  if (byInput.size >= WORKER_PICK_CACHE_MAX) byInput.clear();
  const rows = compute(catalogs, args, query);
  byInput.set(key, rows);
  return rows;
}

export function workerPickFromArgs(args: readonly string[], catalogs?: readonly ModelCatalog[]): WorkerPick | null {
  const [vendor, model, rawEffort] = args;
  if (!isAgentVendor(vendor)) return null;
  const pick = (value: string | undefined) => (value === undefined || value === WORKER_PICK_DEFAULT ? null : value);
  const effortVal = pick(rawEffort);
  const catalog = catalogs?.find((c) => c.vendor === vendor) ?? null;
  return {
    vendor,
    model: pick(model),
    effort: effortVal === null ? null : (normalizeEffortInput(vendor, effortVal, catalog) ?? effortVal),
  };
}

export function workerPickLabels(pick: WorkerPick, catalogs: readonly ModelCatalog[]): string[] {
  const catalog = catalogs.find((c) => c.vendor === pick.vendor);
  return [
    catalog?.label ?? vendorLabel(pick.vendor),
    ...(pick.model === null ? [] : [catalog ? modelLabel(pick.vendor, pick.model, catalog) : pick.model]),
    ...(pick.effort === null ? [] : [effortLabel(pick.effort, pick.vendor, catalog)]),
  ];
}

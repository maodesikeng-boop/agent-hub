// /hub:worker 的多级参数列表（厂商 → 模型 → 思考程度），全是纯函数：输入模型名单（GET /api/models，models.tsx）、
// 已选的几级和正在打的词，算出列表的行。不读 VENDOR_SPECS、不写任何厂商名或模型名：名单里有什么就列什么。
// 规则：没装的厂商不列，没登录的列出来但不能选（和资料页一样）；模型只列名单里的，第一行 Default；
// 思考程度只列这个模型支持的（effortsFor），第一行 Default，只有一档或没有档位就没有这一级。
import {
  AVAILABILITY_LABELS,
  effortsFor,
  isAgentVendor,
  isListed,
  isSelectable,
  modelLabel,
  vendorLabel,
  WORKER_PICK_CACHE_MAX,
  type ModelCatalog,
  type WorkerPick,
} from "../shared/index.ts";
import type { MenuItem } from "./composer-suggest.ts";
import { rankMatches, WORKER_ARG_LEVELS } from "./composer-trigger.ts";
import { DEFAULT_CHOICE, defaultModelText } from "./format.ts";

/** 模型、思考程度选 Default 时插进文字里的词（不传这个参数，项目经理自己定）。 */
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
    const vendors = catalogs.filter((c) => isListed(c.availability));
    return rank(
      level,
      vendors.map((c) => ({ value: c.vendor, label: c.label, detail: AVAILABILITY_LABELS[c.availability] ?? "", ...(!isSelectable(c.availability) && { disabled: true as const }) })),
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
  return rank(level, [{ value: WORKER_PICK_DEFAULT, label: DEFAULT_CHOICE, detail: "" }, ...efforts.map((e) => ({ value: e, label: e, detail: "" }))], query);
}

const cache = new WeakMap<readonly ModelCatalog[], Map<string, WorkerPickRows | null>>();

/**
 * 正在选第 args.length 级（0 厂商、1 模型、2 思考程度）时列表的行；这一级不存在（厂商不认识或不能用、模型不在名单里、
 * 思考程度只有一档、三级都选完了）返回 null。按 catalogs 数组缓存：同一份名单、同样的参数和查询词返回同一个对象。
 */
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

/** 选好的几级参数（文字里的 id，Default 是 "default"）换成发消息用的 WorkerPick；第一级不是认识的厂商返回 null。 */
export function workerPickFromArgs(args: readonly string[]): WorkerPick | null {
  const [vendor, model, effort] = args;
  if (!isAgentVendor(vendor)) return null;
  const pick = (value: string | undefined) => (value === undefined || value === WORKER_PICK_DEFAULT ? null : value);
  return { vendor, model: pick(model), effort: pick(effort) };
}

/**
 * 标签上显示的几项：厂商名、模型名（名单里的显示名，不在名单里的原样）、思考程度（原样，和列表一样）；Default（null）的项不显示。
 * 名字取 catalogs（和列表同一份名单），这家不在名单里用打包的名字。
 */
export function workerPickLabels(pick: WorkerPick, catalogs: readonly ModelCatalog[]): string[] {
  const catalog = catalogs.find((c) => c.vendor === pick.vendor);
  return [
    catalog?.label ?? vendorLabel(pick.vendor),
    ...(pick.model === null ? [] : [catalog ? modelLabel(pick.vendor, pick.model, catalog) : pick.model]),
    ...(pick.effort === null ? [] : [pick.effort]),
  ];
}

import { z } from "zod";
import { validateAskOptions } from "../../../shared/domain.ts";
import type { TaskEdge, TaskNodeKey } from "../../../shared/domain.ts";
import type { CreateTaskGraphNodeInput } from "../../../shared/hub.ts";
import { workerCapabilitiesOf, type WorkerCapabilities } from "../../../shared/pm-capabilities.ts";
import { checkWorkerMaxTimeMs, parseWorkerMaxTime } from "../../../shared/schedule.ts";
import {
  AGENT_VENDORS,
  checkEffort,
  checkModel,
  checkModelEffort,
  isAgentVendor,
  normalizeEffortInput,
  splitModelEffort,
  type AgentVendor,
  type ModelCatalog,
} from "../../../shared/vendors.ts";
import { STEP_SLOT_NAME_MAX_CHARS } from "../../../shared/limits.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { assertHubLimit, fail } from "../context.ts";
import { formatGraphSpecIssues, type GraphSpecKind } from "./spec-errors.ts";
import { resolveImplicitReviewTarget, type LineageMaps, type LineageNode } from "./workspace.ts";

const NODE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SLOT_NAME_RE = /^[a-z0-9-]+$/;
/** Mirrors `git check-ref-format`. */
const BRANCH_NAME_RE = /^(?![-./])(?!.*(?:\.\.|\/\/|@\{|\/\.))(?!.*(?:[/.]|\.lock)$)[^\s\p{Cc}~^:?*[\\]+$/u;

export const charLen = (s: string): number => [...s].length;

export const edgeSig = (fromKey: TaskNodeKey, toKey: TaskNodeKey): string => `${fromKey}\0${toKey}`;

export function validateNodeKey(raw: string): TaskNodeKey {
  const key = raw.trim();
  assertHubLimit("step.key", key);
  if (!NODE_KEY_RE.test(key)) {
    throw fail("invalid", `节点标识「${raw}」不合法：需由字母、数字、_、-、. 组成，以字母或数字开头`);
  }
  return key;
}

function validateSingleLine(raw: string, id: "step.title" | "graph.title", message: string): string {
  const title = raw.trim();
  if (title === "" || /[\r\n]/.test(title)) throw fail("invalid", message);
  assertHubLimit(id, title);
  return title;
}

export const validateNodeTitle = (raw: string): string =>
  validateSingleLine(raw, "step.title", "节点标题不能为空或换行");

export const validateGraphTitle = (raw: string): string =>
  validateSingleLine(raw, "graph.title", "任务图标题不能为空或换行");

function validateOptionalText(raw: string | null | undefined, id: "graph.goal" | "step.brief", target?: string): string | null {
  const text = raw?.trim() ?? "";
  if (text === "") return null;
  assertHubLimit(id, text, target);
  return text;
}

export const validateGraphGoal = (raw: string | null | undefined): string | null =>
  validateOptionalText(raw, "graph.goal");

export const validateStepBrief = (raw: string | null | undefined, key: TaskNodeKey): string | null =>
  validateOptionalText(raw, "step.brief", key);

export function validateStepBase(raw: string | null | undefined, review: boolean): string | null {
  const base = raw?.trim() ?? "";
  if (base === "") return null;
  if (!review) {
    if (base !== "main") throw fail("invalid", '普通步骤的 base 只能是 "main"（审查步骤的 base 才写被审分支）');
    return "main";
  }
  assertHubLimit("step.base", base);
  if (base === "main" || !BRANCH_NAME_RE.test(base)) {
    throw fail("invalid", `审查步骤的 base 写被审分支的名字（不能是 main），现在是 ${JSON.stringify(base)}`);
  }
  return base;
}

export function validateStepSlot(raw: string | null | undefined, key: TaskNodeKey): string | null {
  if (raw === undefined || raw === null) return null;
  const slot = raw.trim();
  if (slot === "") return null;
  if (slot.length > STEP_SLOT_NAME_MAX_CHARS || !SLOT_NAME_RE.test(slot)) {
    throw fail("invalid", `步骤「${key}」的名额「${raw}」不合法：只能用 1～${STEP_SLOT_NAME_MAX_CHARS} 个小写字母、数字或 -`);
  }
  return slot;
}

/**
 * Precondition: nodes contains every step in the graph and edges contains all directed dependencies.
 * Postcondition: throws an invalid error naming the reviewed branch when any pending or waiting review step
 * without an explicit base cannot resolve a unique upstream code step or (when no code step exists upstream) a unanimous reviewed base.
 */
export function assertReviewStepsHaveTarget(
  nodes: Iterable<{ key: TaskNodeKey; review: number; base: string | null; status: string; skipped?: number }>,
  edges: readonly TaskEdge[],
): void {
  const nodeList = [...nodes];
  const byKey = new Map<TaskNodeKey, LineageNode>();
  const incoming = new Map<TaskNodeKey, TaskNodeKey[]>();
  const outgoing = new Map<TaskNodeKey, TaskNodeKey[]>();
  for (const n of nodeList) {
    byKey.set(n.key, { node_key: n.key, review: n.review, skipped: n.skipped ?? 0, base: n.base });
    incoming.set(n.key, []);
    outgoing.set(n.key, []);
  }
  for (const e of edges) {
    incoming.get(e.toKey)?.push(e.fromKey);
    outgoing.get(e.fromKey)?.push(e.toKey);
  }
  const maps: LineageMaps = { byKey, incoming, outgoing };
  for (const n of nodeList) {
    if (n.review !== 1 || n.base !== null || n.skipped === 1 || (n.status !== "pending" && n.status !== "waiting")) continue;
    const target = resolveImplicitReviewTarget(n.key, maps);
    if (target.kind === "none" || target.kind === "conflict") {
      throw fail(
        "invalid",
        `审查步骤「${n.key}」${target.kind === "none" ? "没有可审的上游步骤" : "有多个上游分支"}，定不下被审分支：给它写 "base": "<被审分支>"`,
      );
    }
  }
}

export function validateStepMaxTime(raw: string | number | null | undefined): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string") {
    const parsed = parseWorkerMaxTime(raw.trim());
    if (!parsed.ok) throw fail("invalid", `步骤 maxTime 不合法：${parsed.error}`);
    return parsed.maxTimeMs;
  }
  const err = checkWorkerMaxTimeMs(raw);
  if (err !== null) throw fail("invalid", `步骤 maxTime 不合法：${err}`);
  return raw;
}

export interface GateFields {
  question: string | null;
  options: string[];
  summaryMd: string | null;
  recommended: string | null;
}

function validateGateOptions(raw: string[] | undefined): string[] {
  if (raw === undefined || raw.length === 0) return [];
  const checked = validateAskOptions(raw, "ask.stepOptions");
  if (!checked.ok) throw fail("invalid", checked.error);
  return checked.options;
}

function resolveRecommended(raw: string | undefined, options: readonly string[]): string | null {
  const recommended = raw !== undefined && raw.trim() !== "" ? raw.trim() : null;
  if (recommended === null || options.length === 0 || options.includes(recommended)) return recommended;
  let resolved = recommended;
  if (/^[1-9][0-9]*$/.test(resolved)) {
    const idx = Number(resolved) - 1;
    if (idx >= 0 && idx < options.length) resolved = options[idx]!;
  }
  if (!options.includes(resolved)) throw fail("invalid", `推荐项「${recommended}」必须是拍板卡的选项之一`);
  return resolved;
}

export function validateGateFields(input: {
  question?: string;
  options?: string[];
  summaryMd?: string;
  recommended?: string;
}): GateFields {
  const question = input.question !== undefined ? input.question.trim() : "";
  assertHubLimit("ask.stepQuestion", question);
  const options = validateGateOptions(input.options);
  const summaryMd = input.summaryMd !== undefined && input.summaryMd.trim() !== "" ? input.summaryMd.trim() : null;
  if (summaryMd !== null) assertHubLimit("ask.stepBody", summaryMd);
  return {
    question: question === "" ? null : question,
    options,
    summaryMd,
    recommended: resolveRecommended(input.recommended, options),
  };
}

export const gateOptionsJsonOf = (gate: Pick<GateFields, "options">): string | null =>
  gate.options.length > 0 ? JSON.stringify(gate.options) : null;

function checkGraphSize(nodeKeys: readonly TaskNodeKey[], edges: readonly TaskEdge[]): void {
  if (nodeKeys.length === 0) throw fail("invalid", "任务图至少需要 1 个节点");
  assertHubLimit("graph.steps", nodeKeys);
  assertHubLimit("graph.edges", edges);
}

function buildAdjacency(nodeKeys: readonly TaskNodeKey[], edges: readonly TaskEdge[]) {
  const keySet = new Set<TaskNodeKey>();
  for (const k of nodeKeys) {
    if (keySet.has(k)) throw fail("invalid", `重复的节点标识「${k}」`);
    keySet.add(k);
  }
  const adj = new Map<TaskNodeKey, TaskNodeKey[]>(nodeKeys.map((k) => [k, []]));
  const inDeg = new Map<TaskNodeKey, number>(nodeKeys.map((k) => [k, 0]));
  const edgeSeen = new Set<string>();
  for (const e of edges) {
    if (!keySet.has(e.fromKey)) throw fail("invalid", `依赖边引用了不存在的前置节点「${e.fromKey}」`);
    if (!keySet.has(e.toKey)) throw fail("invalid", `依赖边引用了不存在的目标节点「${e.toKey}」`);
    if (e.fromKey === e.toKey) throw fail("invalid", `节点「${e.fromKey}」不能依赖自己（${e.fromKey} -> ${e.toKey}）`);
    const sig = edgeSig(e.fromKey, e.toKey);
    if (edgeSeen.has(sig)) continue;
    edgeSeen.add(sig);
    adj.get(e.fromKey)!.push(e.toKey);
    inDeg.set(e.toKey, (inDeg.get(e.toKey) ?? 0) + 1);
  }
  return { adj, inDeg };
}

function cyclePath(nodeKeys: readonly TaskNodeKey[], edges: readonly TaskEdge[], inDeg: ReadonlyMap<TaskNodeKey, number>): TaskNodeKey[] {
  // Every leftover node keeps a predecessor inside the leftover set, so walking predecessors must revisit a node.
  const remaining = new Set(nodeKeys.filter((k) => (inDeg.get(k) ?? 0) > 0));
  const predInRem = new Map<TaskNodeKey, TaskNodeKey>();
  for (const e of edges) {
    if (remaining.has(e.fromKey) && remaining.has(e.toKey) && !predInRem.has(e.toKey)) predInRem.set(e.toKey, e.fromKey);
  }
  let cur = [...remaining][0]!;
  const visitedIdx = new Map<TaskNodeKey, number>();
  const backChain: TaskNodeKey[] = [];
  while (!visitedIdx.has(cur)) {
    visitedIdx.set(cur, backChain.length);
    backChain.push(cur);
    cur = predInRem.get(cur)!;
  }
  const cycle = backChain.slice(visitedIdx.get(cur)!).reverse();
  cycle.push(cur);
  return cycle;
}

export function validateDagAndOrder(nodeKeys: readonly TaskNodeKey[], edges: readonly TaskEdge[]): TaskNodeKey[] {
  checkGraphSize(nodeKeys, edges);
  const { adj, inDeg } = buildAdjacency(nodeKeys, edges);
  const queue = nodeKeys.filter((k) => (inDeg.get(k) ?? 0) === 0);
  const order: TaskNodeKey[] = [];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++]!;
    order.push(u);
    for (const v of adj.get(u)!) {
      const next = (inDeg.get(v) ?? 0) - 1;
      inDeg.set(v, next);
      if (next === 0) queue.push(v);
    }
  }
  if (order.length < nodeKeys.length) {
    throw fail("invalid", `任务图存在循环依赖：${cyclePath(nodeKeys, edges, inDeg).join(" -> ")}`);
  }
  return order;
}

export function validateStepAgentSetting(
  input: { vendor?: string | null; model?: string | null; effort?: string | null },
  fallbackVendor: AgentVendor,
  catalogOf: (vendor: AgentVendor) => ModelCatalog | null,
): { vendor: AgentVendor | null; model: string | null; effort: string | null } {
  let resolvedVendor: AgentVendor | null = null;
  if (input.vendor !== undefined && input.vendor !== null && input.vendor.trim() !== "") {
    const rawV = input.vendor.trim();
    if (!isAgentVendor(rawV)) throw fail("invalid", `厂商只能是 ${AGENT_VENDORS.join("、")}`);
    resolvedVendor = rawV;
  }
  const targetVendor = resolvedVendor ?? fallbackVendor;
  const givenModel = typeof input.model === "string" ? input.model.trim() || null : null;
  if (givenModel !== null) assertHubLimit("worker.model", givenModel);
  const catalog = catalogOf(targetVendor);
  const givenEffort = normalizeEffortInput(targetVendor, typeof input.effort === "string" ? input.effort.trim() || null : null, catalog);
  const bad =
    checkModel(targetVendor, givenModel) ??
    checkEffort(targetVendor, givenEffort, catalog) ??
    checkModelEffort(targetVendor, givenModel, givenEffort, catalog);
  if (bad !== null) throw fail("invalid", bad);
  const { model, effort } = splitModelEffort(targetVendor, givenModel, givenEffort, catalog);
  return { vendor: resolvedVendor, model, effort };
}

export function validateStepCapabilities(caps: unknown, allow: unknown): WorkerCapabilities {
  const result = workerCapabilitiesOf(caps, allow);
  if ("error" in result) throw fail("invalid", `步骤的外接能力配置不对：${result.error}`);
  return result;
}

export interface NewStep {
  key: TaskNodeKey;
  title: string;
  brief: string | null;
  vendor: AgentVendor | null;
  model: string | null;
  effort: string | null;
  readonly: number;
  capabilities: WorkerCapabilities;
  noOuterSandbox?: boolean;
  maxTimeMs: number | null;
  confirm: number;
  review: number;
  base: string | null;
  slot: string | null;
  deps: TaskNodeKey[];
}

export function normalizeNewStep(
  n: CreateTaskGraphNodeInput,
  index: number,
  list: readonly CreateTaskGraphNodeInput[],
  sequentialDefault: boolean,
  fallbackVendor: AgentVendor,
  catalogOf: (vendor: AgentVendor) => ModelCatalog | null,
): NewStep {
  const key = validateNodeKey(n.key);
  const title = validateNodeTitle(n.title);
  const brief = validateStepBrief(n.brief, key);
  const agent = validateStepAgentSetting(n, fallbackVendor, catalogOf);
  const maxTimeMs = validateStepMaxTime(n.maxTime);
  const base = validateStepBase(n.base, n.review === true);
  const rawDeps = n.deps !== undefined ? n.deps : sequentialDefault && index >= 1 ? [list[index - 1]!.key] : [];
  return {
    key,
    title,
    brief,
    vendor: agent.vendor,
    model: agent.model,
    effort: agent.effort,
    readonly: n.readonly === true ? 1 : 0,
    capabilities: validateStepCapabilities(n.caps, n.allow),
    noOuterSandbox: n.noOuterSandbox === true,
    maxTimeMs,
    confirm: n.confirm === true ? 1 : 0,
    review: n.review === true ? 1 : 0,
    base,
    slot: validateStepSlot(n.slot, key),
    deps: rawDeps.map(validateNodeKey),
  };
}

export function parseSpecJson<T>(
  raw: unknown,
  schema: z.ZodType,
  kind: GraphSpecKind,
  messages: { empty: string; badJson: string },
): T {
  if (typeof raw !== "string" || raw.trim() === "") throw fail("invalid", messages.empty);
  assertHubLimit("graph.spec", raw);
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw fail("invalid", messages.badJson);
  }
  const parsed = schema.safeParse(obj);
  if (!parsed.success) throw fail("invalid", formatGraphSpecIssues(kind, parsed.error.issues));
  return parsed.data as T;
}

function withoutAuthoredDecision(raw: unknown): unknown {
  if (typeof raw === "object" && raw !== null && ["question", "options", "summaryMd", "recommended"].some((key) => Object.hasOwn(raw, key))) {
    throw fail("invalid", `步骤不能预先写拍板问题。要请用户拍板，用 ${HUB_COMMAND} ask --node <步骤>`);
  }
  return raw;
}

const createStepItemSchema = z.preprocess(withoutAuthoredDecision, z.object({
  key: z.string(),
  title: z.string(),
  brief: z.string().optional(),
  vendor: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  maxTime: z.union([z.string(), z.number()]).optional(),
  readonly: z.boolean().optional(),
  caps: z.string().optional(),
  noOuterSandbox: z.boolean().optional(),
  allow: z.array(z.string()).optional(),
  confirm: z.boolean().optional(),
  review: z.boolean().optional(),
  base: z.string().optional(),
  slot: z.string().optional(),
  draft: z.boolean().optional(),
  deps: z.array(z.string()).optional(),
}).strict());

const edgeSchema = z.object({ from: z.string(), to: z.string() }).strict();

export const createSpecSchema = z.object({
  title: z.string().optional(),
  goal: z.string().optional(),
  originMsgId: z.number().int().positive().optional(),
  steps: z.array(createStepItemSchema).optional(),
  nodes: z.array(createStepItemSchema).optional(),
  edges: z.array(edgeSchema).optional(),
}).strict();

const patchUpdateItemSchema = z.preprocess(withoutAuthoredDecision, z.object({
  key: z.string(),
  title: z.string().optional(),
  brief: z.string().nullable().optional(),
  vendor: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  maxTime: z.union([z.string(), z.number()]).nullable().optional(),
  readonly: z.boolean().optional(),
  caps: z.string().nullable().optional(),
  noOuterSandbox: z.boolean().optional(),
  allow: z.array(z.string()).optional(),
  confirm: z.boolean().optional(),
  review: z.boolean().optional(),
  base: z.string().nullable().optional(),
  slot: z.string().nullable().optional(),
  deps: z.array(z.string()).optional(),
}).strict());

export const patchSpecSchema = z.object({
  title: z.string().optional(),
  goal: z.string().nullable().optional(),
  addSteps: z.array(createStepItemSchema).optional(),
  updateSteps: z.array(patchUpdateItemSchema).optional(),
  removeSteps: z.array(z.string()).optional(),
  skipSteps: z.array(z.string()).optional(),
  doneSteps: z.array(z.string()).optional(),
  addNodes: z.array(createStepItemSchema).optional(),
  updateNodes: z.array(patchUpdateItemSchema).optional(),
  removeNodes: z.array(z.string()).optional(),
  skipNodes: z.array(z.string()).optional(),
  addEdges: z.array(edgeSchema).optional(),
  removeEdges: z.array(edgeSchema).optional(),
}).strict();

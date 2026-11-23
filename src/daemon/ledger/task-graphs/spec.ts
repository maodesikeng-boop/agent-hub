import { z } from "zod";
import { truncateChars, validateAskOptions } from "../../../shared/domain.ts";
import type { TaskEdge, TaskNodeKey } from "../../../shared/domain.ts";
import type { CreateTaskGraphNodeInput } from "../../../shared/hub.ts";
import {
  MAX_GATE_OPTIONS,
  MAX_GATE_QUESTION_CHARS,
  MAX_GATE_SUMMARY_CHARS,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_GOAL_CHARS,
  MAX_GRAPH_NODES,
  MAX_GRAPH_SPEC_BYTES,
  MAX_GRAPH_TITLE_CHARS,
  MAX_NODE_KEY_CHARS,
  MAX_NODE_TITLE_CHARS,
  MAX_STEP_BASE_CHARS,
  MAX_STEP_BRIEF_CHARS,
} from "../../../shared/limits.ts";
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
import { fail } from "../context.ts";

const NODE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** Mirrors `git check-ref-format`. */
const BRANCH_NAME_RE = /^(?![-./])(?!.*(?:\.\.|\/\/|@\{|\/\.))(?!.*(?:[/.]|\.lock)$)[^\s\p{Cc}~^:?*[\\]+$/u;

export const charLen = (s: string): number => [...s].length;

export const edgeSig = (fromKey: TaskNodeKey, toKey: TaskNodeKey): string => `${fromKey}\0${toKey}`;

export function validateNodeKey(raw: string): TaskNodeKey {
  const key = raw.trim();
  if (key === "" || charLen(key) > MAX_NODE_KEY_CHARS || !NODE_KEY_RE.test(key)) {
    throw fail(
      "invalid",
      `节点标识「${raw}」不合法：需由字母、数字、_、-、. 组成，以字母或数字开头，最多 ${MAX_NODE_KEY_CHARS} 个字符`,
    );
  }
  return key;
}

function validateSingleLine(raw: string, max: number, message: string): string {
  const title = raw.trim();
  if (title === "" || /[\r\n]/.test(title) || charLen(title) > max) throw fail("invalid", message);
  return title;
}

export const validateNodeTitle = (raw: string): string =>
  validateSingleLine(raw, MAX_NODE_TITLE_CHARS, `节点标题不能为空或换行，且最多 ${MAX_NODE_TITLE_CHARS} 字`);

export const validateGraphTitle = (raw: string): string =>
  validateSingleLine(raw, MAX_GRAPH_TITLE_CHARS, `任务图标题不能为空或换行，且最多 ${MAX_GRAPH_TITLE_CHARS} 字`);

function validateOptionalText(raw: string | null | undefined, max: number, message: string): string | null {
  if (raw === undefined || raw === null) return null;
  const text = raw.trim();
  if (text === "") return null;
  if (charLen(text) > max) throw fail("invalid", message);
  return text;
}

export const validateGraphGoal = (raw: string | null | undefined): string | null =>
  validateOptionalText(raw, MAX_GRAPH_GOAL_CHARS, `任务图目标最多 ${MAX_GRAPH_GOAL_CHARS} 字`);

export const validateStepBrief = (raw: string | null | undefined): string | null =>
  validateOptionalText(raw, MAX_STEP_BRIEF_CHARS, `步骤职责最多 ${MAX_STEP_BRIEF_CHARS} 字`);

export function validateStepBase(raw: string | null | undefined, review: boolean): string | null {
  const base = raw?.trim() ?? "";
  if (base === "") return null;
  if (!review) {
    if (base !== "main") throw fail("invalid", '普通步骤的 base 只能是 "main"（审查步骤的 base 才写被审分支）');
    return "main";
  }
  if (base === "main" || charLen(base) > MAX_STEP_BASE_CHARS || !BRANCH_NAME_RE.test(base)) {
    throw fail("invalid", `审查步骤的 base 写被审分支的名字（不能是 main，最多 ${MAX_STEP_BASE_CHARS} 字），现在是 ${JSON.stringify(base)}`);
  }
  return base;
}

export function assertReviewStepsHaveTarget(
  nodes: Iterable<{ key: TaskNodeKey; review: number; base: string | null; status: string }>,
  edges: readonly TaskEdge[],
): void {
  for (const n of nodes) {
    if (n.review !== 1 || n.base !== null || (n.status !== "pending" && n.status !== "waiting")) continue;
    const ups = edges.filter((e) => e.toKey === n.key).length;
    if (ups !== 1) {
      throw fail(
        "invalid",
        `审查步骤「${n.key}」${ups === 0 ? "没有上一步" : `有 ${ups} 个上一步`}，定不下被审分支：给它写 "base": "<被审分支>"`,
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
  if (raw.length < 2 || raw.length > MAX_GATE_OPTIONS) {
    throw fail("invalid", `拍板卡的选项数量需在 2 到 ${MAX_GATE_OPTIONS} 个之间`);
  }
  const checked = validateAskOptions(raw);
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
  if (question !== "" && charLen(question) > MAX_GATE_QUESTION_CHARS) {
    throw fail("invalid", `拍板卡的问题最多 ${MAX_GATE_QUESTION_CHARS} 字`);
  }
  const options = validateGateOptions(input.options);
  const summaryMd = input.summaryMd !== undefined && input.summaryMd.trim() !== "" ? input.summaryMd.trim() : null;
  if (summaryMd !== null && charLen(summaryMd) > MAX_GATE_SUMMARY_CHARS) {
    throw fail("invalid", `拍板卡的背景摘要最多 ${MAX_GATE_SUMMARY_CHARS} 字`);
  }
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
  if (nodeKeys.length > MAX_GRAPH_NODES) {
    throw fail("invalid", `单张任务图最多 ${MAX_GRAPH_NODES} 个节点（当前 ${nodeKeys.length} 个）`);
  }
  if (edges.length > MAX_GRAPH_EDGES) {
    throw fail("invalid", `单张任务图最多 ${MAX_GRAPH_EDGES} 条依赖边（当前 ${edges.length} 条）`);
  }
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
  maxTimeMs: number | null;
  confirm: number;
  review: number;
  base: string | null;
  deps: TaskNodeKey[];
  gate: GateFields;
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
  const brief = validateStepBrief(n.brief);
  const agent = validateStepAgentSetting(n, fallbackVendor, catalogOf);
  const maxTimeMs = validateStepMaxTime(n.maxTime);
  const base = validateStepBase(n.base, n.review === true);
  const gate = validateGateFields(n);
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
    maxTimeMs,
    confirm: n.confirm === true ? 1 : 0,
    review: n.review === true ? 1 : 0,
    base,
    deps: rawDeps.map(validateNodeKey),
    gate,
  };
}

export function splitAskTextForGate(rawText: string): { question: string; summaryMd: string | null } {
  const trimmed = rawText.trim();
  if (trimmed === "") throw fail("invalid", "要问用户的话不能是空的");
  const splitMatch = /^([^\r\n]+?)(?:\r?\n\s*\r?\n|\r?\n)([\s\S]+)$/u.exec(trimmed);
  if (splitMatch !== null) {
    const rest = splitMatch[2]!.trim();
    return {
      question: truncateChars(splitMatch[1]!.trim(), MAX_GATE_QUESTION_CHARS),
      summaryMd: rest === "" ? null : truncateChars(rest, MAX_GATE_SUMMARY_CHARS),
    };
  }
  if (charLen(trimmed) <= MAX_GATE_QUESTION_CHARS) return { question: trimmed, summaryMd: null };
  return {
    question: truncateChars(trimmed, MAX_GATE_QUESTION_CHARS),
    summaryMd: truncateChars(trimmed, MAX_GATE_SUMMARY_CHARS),
  };
}

export function parseSpecJson<T>(
  raw: unknown,
  schema: z.ZodType,
  messages: { empty: string; badJson: string; badShape: string },
): T {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_GRAPH_SPEC_BYTES) throw fail("invalid", messages.empty);
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw fail("invalid", messages.badJson);
  }
  const parsed = schema.safeParse(obj);
  if (!parsed.success) throw fail("invalid", messages.badShape);
  return parsed.data as T;
}

const createStepItemSchema = z.object({
  key: z.string(),
  title: z.string(),
  brief: z.string().optional(),
  vendor: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  maxTime: z.union([z.string(), z.number()]).optional(),
  readonly: z.boolean().optional(),
  caps: z.string().optional(),
  allow: z.array(z.string()).optional(),
  confirm: z.boolean().optional(),
  review: z.boolean().optional(),
  base: z.string().optional(),
  draft: z.boolean().optional(),
  deps: z.array(z.string()).optional(),
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
  summaryMd: z.string().optional(),
  recommended: z.string().optional(),
});

const edgeSchema = z.object({ from: z.string(), to: z.string() });

export const createSpecSchema = z.object({
  title: z.string().optional(),
  goal: z.string().optional(),
  originMsgId: z.number().int().positive().optional(),
  steps: z.array(createStepItemSchema).optional(),
  nodes: z.array(createStepItemSchema).optional(),
  edges: z.array(edgeSchema).optional(),
});

const patchUpdateItemSchema = z.object({
  key: z.string(),
  title: z.string().optional(),
  brief: z.string().nullable().optional(),
  vendor: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  maxTime: z.union([z.string(), z.number()]).nullable().optional(),
  readonly: z.boolean().optional(),
  caps: z.string().nullable().optional(),
  allow: z.array(z.string()).optional(),
  confirm: z.boolean().optional(),
  review: z.boolean().optional(),
  base: z.string().nullable().optional(),
  deps: z.array(z.string()).optional(),
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
  summaryMd: z.string().optional(),
  recommended: z.string().optional(),
});

export const patchSpecSchema = z.object({
  title: z.string().optional(),
  goal: z.string().nullable().optional(),
  addSteps: z.array(createStepItemSchema).optional(),
  updateSteps: z.array(patchUpdateItemSchema).optional(),
  removeSteps: z.array(z.string()).optional(),
  skipSteps: z.array(z.string()).optional(),
  addNodes: z.array(createStepItemSchema).optional(),
  updateNodes: z.array(patchUpdateItemSchema).optional(),
  removeNodes: z.array(z.string()).optional(),
  skipNodes: z.array(z.string()).optional(),
  addEdges: z.array(edgeSchema).optional(),
  removeEdges: z.array(edgeSchema).optional(),
});

// Invariant: every Zod schema rejection on graph create or patch JSON names the exact field path,
// expected type or unrecognized key, and closest allowed key suggestion when applicable.

import type { z } from "zod";
import { HUB_ERROR_SUGGESTIONS_MAX } from "../../../shared/limits.ts";

export type GraphSpecKind = "create" | "patch";

const CREATE_ROOT_KEYS = ["title", "goal", "originMsgId", "steps", "nodes", "edges"] as const;
const PATCH_ROOT_KEYS = [
  "title",
  "goal",
  "addSteps",
  "updateSteps",
  "removeSteps",
  "skipSteps",
  "doneSteps",
  "addNodes",
  "updateNodes",
  "removeNodes",
  "skipNodes",
  "addEdges",
  "removeEdges",
] as const;
const CREATE_STEP_KEYS = [
  "key",
  "title",
  "brief",
  "vendor",
  "model",
  "effort",
  "maxTime",
  "readonly",
  "caps",
  "noOuterSandbox",
  "allow",
  "confirm",
  "review",
  "base",
  "slot",
  "draft",
  "deps",
] as const;
const PATCH_UPDATE_STEP_KEYS = [
  "key",
  "title",
  "brief",
  "vendor",
  "model",
  "effort",
  "maxTime",
  "readonly",
  "caps",
  "noOuterSandbox",
  "allow",
  "confirm",
  "review",
  "base",
  "slot",
  "deps",
] as const;
const EDGE_KEYS = ["from", "to"] as const;

const COMMON_KEY_ALIASES: Readonly<Record<string, string>> = {
  dependencies: "deps",
  depends: "deps",
  dependson: "deps",
  requires: "deps",
  after: "deps",
  capabilities: "caps",
  capability: "caps",
  readOnly: "readonly",
  timeout: "maxTime",
  maxtimems: "maxTime",
  timelimit: "maxTime",
  description: "brief",
  prompt: "brief",
  task: "brief",
  name: "title",
  id: "key",
  stepkey: "key",
  nodekey: "key",
  originmessageid: "originMsgId",
};

const TYPE_LABELS: Readonly<Record<string, string>> = {
  string: "文字",
  number: "数字",
  boolean: "true 或 false",
  array: "列表",
  object: "对象",
  null: "null",
  int: "整数",
};

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      const part = String(segment);
      out += out === "" ? part : `.${part}`;
    }
  }
  return out;
}

function allowedKeysAt(kind: GraphSpecKind, path: readonly PropertyKey[]): readonly string[] {
  if (path.length === 0) return kind === "create" ? CREATE_ROOT_KEYS : PATCH_ROOT_KEYS;
  const first = String(path[0]);
  if (path.length === 2 && typeof path[1] === "number") {
    if (first === "steps" || first === "nodes" || first === "addSteps" || first === "addNodes") return CREATE_STEP_KEYS;
    if (first === "updateSteps" || first === "updateNodes") return PATCH_UPDATE_STEP_KEYS;
    if (first === "edges" || first === "addEdges" || first === "removeEdges") return EDGE_KEYS;
  }
  return [];
}

function normalizeKey(raw: string): string {
  return raw.toLowerCase().replace(/[_-]/gu, "");
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

function suggestKeys(unknownKey: string, allowed: readonly string[]): string[] {
  if (allowed.length === 0) return [];
  const norm = normalizeKey(unknownKey);
  const alias = COMMON_KEY_ALIASES[unknownKey] ?? COMMON_KEY_ALIASES[norm];
  const picks: Array<{ key: string; score: number }> = [];
  for (const key of allowed) {
    if (alias === key) {
      picks.push({ key, score: 0 });
      continue;
    }
    const cand = normalizeKey(key);
    const dist = editDistance(norm, cand);
    const maxDist = norm.length <= 4 ? 2 : Math.max(2, Math.floor(Math.max(norm.length, cand.length) * 0.45));
    const prefix = cand.startsWith(norm) || norm.startsWith(cand);
    if (dist <= maxDist || (prefix && Math.min(norm.length, cand.length) >= 3)) {
      picks.push({ key, score: dist * 10 - (prefix ? 3 : 0) });
    }
  }
  picks.sort((a, b) => a.score - b.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return picks.slice(0, HUB_ERROR_SUGGESTIONS_MAX).map((p) => p.key);
}

function formatIssue(kind: GraphSpecKind, issue: z.core.$ZodIssue): string {
  const loc = formatPath(issue.path);
  const where = loc === "" ? "根节点" : loc;
  if (issue.code === "unrecognized_keys") {
    const allowed = allowedKeysAt(kind, issue.path);
    const parts = issue.keys.map((key) => {
      const suggestions = suggestKeys(key, allowed);
      const hint = suggestions.length > 0 ? `（你是不是想写 ${suggestions.map((s) => `"${s}"`).join(" 或 ")}？）` : "";
      return `"${key}"${hint}`;
    });
    return `${where} 包含不认识的字段 ${parts.join("、")}`;
  }
  if (issue.code === "invalid_type") {
    const expected = TYPE_LABELS[issue.expected] ?? issue.expected;
    const rawInput = (issue as { input?: unknown }).input;
    if (rawInput === undefined) return `${where} 缺少必填字段（应为${expected}）`;
    return `${where} 类型不对（应为${expected}）`;
  }
  if (issue.code === "invalid_union") {
    return `${where} 类型不对（请检查允许的字段格式）`;
  }
  return `${where}：${issue.message}`;
}

export function formatGraphSpecIssues(kind: GraphSpecKind, issues: readonly z.core.$ZodIssue[]): string {
  const header = kind === "create" ? "任务图规格 JSON 有误：" : "任务图改图 JSON 有误：";
  const lines = [header, ...issues.map((issue) => `- ${formatIssue(kind, issue)}`)];
  if (kind === "patch") lines.push("这次改图没有生效");
  return lines.join("\n");
}

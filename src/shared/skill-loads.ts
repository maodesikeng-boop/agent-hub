import { commandNameOf } from "../vendors/types.ts";
import type { AgentStepInput } from "./domain.ts";
import { SKILL_LOAD_SCAN_MAX_CHARS } from "./limits.ts";
import { skillNameOf } from "./skill-names.ts";
import { filePathOf, STEP_INPUT_KEYS } from "./step-labels.ts";
import { isAgentVendor, vendorSpec } from "./vendors.ts";
export interface KnownSkill {
  readonly name: string;
  readonly path: string;
  readonly key: string;
  // dev:inode identity so symlinks and hard links match (agy hard-links the task graph manual).
  readonly fileId: string;
  readonly heads: readonly string[];
  readonly description?: string | null;
}

export interface SkillCatalog {
  readonly skills: readonly KnownSkill[];
  named(name: string): KnownSkill | null;
  byKey(key: string): KnownSkill | null;
  atPath(path: string): KnownSkill | null;
  byHead(head: string): KnownSkill | null;
}

export interface ToolCall {
  name: string;
  input: unknown;
}

const contentLines = (text: string, prefix?: RegExp): string[] =>
  text
    .split(/\r?\n/u)
    .map((line) => (prefix === undefined ? line : line.replace(prefix, "")).replace(/^\uFEFF/u, "").trimEnd())
    .filter((line) => line.trim() !== "");

export function skillHeads(text: string): string[] {
  const lines = contentLines(text);
  const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  const body = close === -1 ? lines : lines.slice(close + 1);
  const heads: string[] = [];
  if (close !== -1) heads.push(lines.slice(0, 2).join("\n"));
  if (body.length >= 2) heads.push(body.slice(0, 2).join("\n"));
  return heads;
}

export function createSkillCatalog(skills: readonly KnownSkill[], fileIdOf: (path: string) => string | null): SkillCatalog {
  const byName = new Map<string, KnownSkill>();
  const byKey = new Map<string, KnownSkill>();
  const byFile = new Map<string, KnownSkill>();
  const byHead = new Map<string, KnownSkill>();
  for (const skill of skills) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
    if (!byKey.has(skill.key)) byKey.set(skill.key, skill);
    if (!byFile.has(skill.fileId)) byFile.set(skill.fileId, skill);
    for (const head of skill.heads) if (!byHead.has(head)) byHead.set(head, skill);
  }
  return {
    skills,
    named: (name) => byName.get(name) ?? null,
    byKey: (key) => byKey.get(key) ?? null,
    byHead: (head) => byHead.get(head) ?? null,
    atPath: (path) => {
      if (path === "") return null;
      const id = fileIdOf(path);
      return id === null ? null : (byFile.get(id) ?? null);
    },
  };
}

const actionOf = (vendor: string, toolName: string) => {
  if (!isAgentVendor(vendor)) return undefined;
  const actions = vendorSpec(vendor).tools?.actions ?? {};
  return Object.hasOwn(actions, toolName) ? actions[toolName] : undefined;
};

const stringArg = (input: unknown, key: string): string | undefined => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

const stepArgs = (input: unknown): AgentStepInput =>
  Object.fromEntries(
    STEP_INPUT_KEYS.flatMap((key) => {
      const value = stringArg(input, key);
      return value === undefined ? [] : [[key, value]];
    }),
  );

function readsFromStart(input: unknown, fromStart: Readonly<Record<string, number>> | undefined): boolean {
  if (fromStart === undefined) return true;
  const args = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return Object.entries(fromStart).every(([key, max]) => {
    const value = args[key];
    if (value === undefined || value === null) return true;
    const n = Number(value);
    return Number.isFinite(n) && n <= max;
  });
}

export function awaitsToolResult(vendor: string, toolName: string): boolean {
  const action = actionOf(vendor, toolName);
  return action === "read" || action === "command";
}

export function skillNameOfToolCall(vendor: string, call: ToolCall): string | null {
  if (actionOf(vendor, call.name) !== "skill" || !isAgentVendor(vendor)) return null;
  const raw = (vendorSpec(vendor).skillSignals.toolNameKeys ?? []).map((key) => stringArg(call.input, key)).find((v) => v !== undefined);
  return skillNameOf(raw);
}

export function skillsOfToolResult(vendor: string, call: ToolCall, output: string | undefined, catalog: SkillCatalog): KnownSkill[] {
  if (output === undefined || !awaitsToolResult(vendor, call.name) || !isAgentVendor(vendor)) return [];
  const signals = vendorSpec(vendor).skillSignals;
  const byPath = signals.readByPath !== undefined && Object.hasOwn(signals.readByPath, call.name) ? signals.readByPath[call.name] : undefined;
  if (byPath !== undefined) {
    if (!byPath.ok.test(output.trim()) || !readsFromStart(call.input, byPath.fromStart)) return [];
    const path = filePathOf(stepArgs(call.input));
    const skill = path === undefined ? null : catalog.atPath(path);
    return skill === null ? [] : [skill];
  }
  const lines = contentLines(output.slice(0, SKILL_LOAD_SCAN_MAX_CHARS), signals.outputLinePrefix);
  const found = new Map<string, KnownSkill>();
  for (let i = 0; i + 1 < lines.length; i++) {
    const skill = catalog.byHead(`${lines[i]}\n${lines[i + 1]}`);
    if (skill !== null && !found.has(skill.key)) found.set(skill.key, skill);
  }
  return [...found.values()];
}

export function userSkillCommandOf(vendor: string, text: string): string | null {
  if (!isAgentVendor(vendor)) return null;
  const spec = vendorSpec(vendor);
  for (const prefix of spec.skillSignals.userTriggers ?? [spec.composer.commandPrefix]) {
    const name = skillNameOf(commandNameOf(text, prefix) ?? undefined);
    if (name !== null) return name;
  }
  return null;
}

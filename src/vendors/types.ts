import type { CapabilityIsolationMap } from "../shared/pm-capabilities.ts";
import type { QuotaWindowKey } from "../shared/vendors.ts";

export interface FetchedQuotaSpec {
  args: readonly string[];
  groups: readonly { key: string; name: string; match: string }[];
  windows: Readonly<Record<string, QuotaWindowKey>>;
}

interface ComposerSpec {
  commandPrefix: string;
  compactCommand: string;
  blockedCommands: Readonly<Record<string, string>>;
}

export type FailureKind = "busy" | "quota" | "network" | "missing" | "start" | "auth" | "context";

export type ToolAction =
  | "command"
  | "read"
  | "edit"
  | "write"
  | "search"
  | "web_search"
  | "web_fetch"
  | "skill"
  | "subagent"
  | "todo"
  | "tool_search"
  | "connector"
  | "connector_resource";

export interface RouterModelPreset {
  readonly model: string;
  readonly effort: string;
}

export interface VendorModelsSpec {
  bundled: readonly { id: string; label: string; efforts?: readonly string[] }[];
  customModel: boolean;
  customModelExample: string;
  efforts: readonly string[];
  effortLabels?: Readonly<Record<string, string>>;
  readonly routerDefault: RouterModelPreset;
  // agy errors when model and effort flags disagree, so effort is appended to the model ID instead.
  effortInModelId?: boolean;
  flags?: { model: string; effort: string };
  shortName?: (model: string) => string | null;
}

interface VendorCapabilities {
  backgroundWake: boolean;
  readonly: "settings" | "driver" | "os_sandbox";
  // resident: survives vendor compaction; first_message: prepended to the first user message.
  systemPrompt: "resident" | "first_message";
  skills: "native" | "read_file";
  isolation: CapabilityIsolationMap;
  pluginIsolation?: Partial<CapabilityIsolationMap>;
  explicitDefaultModel?: boolean;
  // macOS sandboxes cannot nest, so the vendor's own sandbox is disabled inside the OS sandbox.
  ownSandboxOffArgs?: readonly string[];
}

export type ChecklistSource = "todo_tool" | "plan_update" | "extension";

export interface VendorChecklistSpec {
  // An empty list means the vendor reports no checklist and the chat shows only the action line.
  sources: readonly ChecklistSource[];
  // Switches that turn on a checklist tool the CLI hides by default; the vendor's launch builder applies them.
  // An appendToList value joins a comma-separated variable the user may already set.
  enable?: { args?: readonly string[]; env?: Readonly<Record<string, string | { appendToList: string }>> };
}

export interface VendorSpec<Id extends string = string> {
  // Stored in agent_sessions.vendor and pms.vendor; never change after release.
  id: Id;
  label: string;
  cli: {
    command: string;
    envVar: string;
    loginCommand: string;
  };
  home: {
    dirs: readonly string[];
    readonlySecrets: readonly string[];
    catalogWatchPaths: readonly string[];
    configHome?: { rel: string; env: string };
  };
  models: VendorModelsSpec;
  quota?: { name: string; windows: readonly QuotaWindowKey[]; warningStatus?: string; fetched?: FetchedQuotaSpec };
  composer: ComposerSpec;
  prompt: {
    subagentTools: readonly string[];
    backgroundCommandTool: string;
    instructionFile?: string;
    vendorOnlyTools?: string;
    skillNamePrefix?: string;
  };
  failure: {
    serviceName: string;
    rawHint?: RegExp;
    rawHintPriority?: number;
  };
  handover?: {
    tokenThreshold?: number;
    transcriptPortable?: boolean;
  };
  // Names are merged across vendors, so one name must map to one action everywhere.
  tools?: { actions: Readonly<Record<string, ToolAction>> };
  checklist: VendorChecklistSpec;
  skillSignals: SkillSignals;
  capabilities: VendorCapabilities;
}

export interface SkillSignals {
  outputField: string;
  outputLinePrefix?: RegExp;
  readByPath?: Readonly<Record<string, { ok: RegExp; fromStart?: Readonly<Record<string, number>> }>>;
  userTriggers?: readonly string[];
  toolNameKeys?: readonly string[];
}

export function defineVendor<const Id extends string>(
  spec: VendorSpec<Id> & { models: { flags: { model: string; effort: string } } },
): VendorSpec<Id> & { models: { flags: { model: string; effort: string } } };
export function defineVendor<const Id extends string>(spec: VendorSpec<Id>): VendorSpec<Id>;
export function defineVendor<const Id extends string>(spec: VendorSpec<Id>): VendorSpec<Id> {
  return spec;
}

export function commandNameOf(text: string, prefix: string): string | null {
  if (!text.startsWith(prefix)) return null;
  const name = text.slice(prefix.length).split(/\s/u, 1)[0] ?? "";
  return name === "" || name.includes("/") ? null : name;
}

export function blockedCommands(reason: string, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, reason]));
}

export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

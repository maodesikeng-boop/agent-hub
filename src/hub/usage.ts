import type { HubCommand } from "../shared/hub.ts";
import {
  HUB_CLI_REGISTRY,
  isHubCommandId,
  renderFullHelp,
  renderHelpIndex,
  renderScopedHelp,
  type HubCliEntry,
} from "./registry.ts";

export interface HubCommandSpec {
  command: HubCommand;
  group: string;
  action?: string;
  cli: string;
  usage: string;
}

export const HUB_COMMAND_SPECS: readonly HubCommandSpec[] = HUB_CLI_REGISTRY
  .filter((entry): entry is HubCliEntry & { id: HubCommand } => isHubCommandId(entry.id))
  .map((entry) => ({
    command: entry.id,
    group: entry.group,
    ...(entry.action !== undefined ? { action: entry.action } : {}),
    cli: entry.cli,
    usage: entry.usage,
  }));

export const HUB_USAGE = renderFullHelp();

export function commandUsageFor(argv: readonly string[]): string {
  const group = argv[0];
  if (group === undefined) return renderHelpIndex();
  const groupEntries = HUB_CLI_REGISTRY.filter((e) => e.group === group);
  if (groupEntries.length === 0) return renderHelpIndex();
  const rawSecond = argv[1];
  const action = rawSecond !== undefined && !rawSecond.startsWith("-") ? rawSecond : undefined;
  if (action !== undefined) {
    const actionEntries = groupEntries.filter((e) => e.action === action);
    if (actionEntries.length > 0) return renderScopedHelp(actionEntries);
    return renderScopedHelp(groupEntries);
  }
  const bare = groupEntries.find((e) => e.action === undefined);
  if (bare !== undefined) return renderScopedHelp([bare]);
  return renderScopedHelp(groupEntries);
}

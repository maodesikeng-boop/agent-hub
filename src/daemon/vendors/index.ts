// 各家厂商的输入框实现登记在这里（接口见 types.ts）。加厂商：平级加 <厂商>.ts，在下面两处各加一行。
import { isAgentVendor, type AgentVendor } from "../../shared/index.ts";
import { claudeComposerBase, createClaudeComposer, type ClaudeComposerOptions } from "./claude.ts";
import type { VendorComposer } from "./types.ts";

export type { CommandsTarget, VendorComposer } from "./types.ts";
export { claudeComposerBase, createClaudeComposer, parseClaudeCommands } from "./claude.ts";

/** 不用起进程的那部分，按厂商（会话那一行的 vendor）找；不认识的厂商是 null。 */
const BASES: Readonly<Record<AgentVendor, Omit<VendorComposer, "queryCommands">>> = {
  claude: claudeComposerBase,
};

export function composerBaseOf(vendor: string): Omit<VendorComposer, "queryCommands"> | null {
  return isAgentVendor(vendor) ? BASES[vendor] : null;
}

export interface VendorComposersOptions {
  claude: ClaudeComposerOptions;
}

/** 每家厂商一个完整的实现（含另起进程问命令列表）。 */
export function createVendorComposers(options: VendorComposersOptions): Readonly<Record<AgentVendor, VendorComposer>> {
  return { claude: createClaudeComposer(options.claude) };
}

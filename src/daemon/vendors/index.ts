// 各家厂商的输入框实现在这里登记（接口见 types.ts）。加一家厂商要动的地方：
// 1. shared/vendors.ts：AGENT_VENDORS 加编号、VENDOR_SPECS 加它的清单（含 composer：命令开头、隐藏名单和原因）；
// 2. vendors/<厂商>.ts：平级加一个，导出不起进程的 VendorComposerBase（纯数据和拼写，别引入起进程的代码）和 create<厂商>Composer；
// 3. 下面的 VENDORS 加一行（base 和 create 一起登记，别的地方都从这里取，其余代码不认识具体哪家）；
// 4. daemon/daemon.ts：给 createVendorComposers 传这家的选项（可执行文件路径、起进程的函数）。
// 驱动层（daemon/driver/<厂商>-driver.ts）按各家协议另写，不在这里。
import { AGENT_VENDORS, isAgentVendor, type AgentVendor } from "../../shared/index.ts";
import { claudeComposerBase, createClaudeComposer } from "./claude.ts";
import type { VendorComposer, VendorComposerBase } from "./types.ts";

export type { CommandsTarget, VendorComposer, VendorComposerBase } from "./types.ts";
export { claudeComposerBase, parseClaudeCommands, type ClaudeComposerOptions } from "./claude.ts";

const VENDORS = {
  claude: { base: claudeComposerBase, create: createClaudeComposer },
} satisfies Record<AgentVendor, { base: VendorComposerBase; create: (options: never) => VendorComposer }>;

/** 不用起进程的那部分，按厂商（会话那一行的 vendor）找；不认识的厂商是 null。 */
export function composerBaseOf(vendor: string): VendorComposerBase | null {
  return isAgentVendor(vendor) ? VENDORS[vendor].base : null;
}

/** 每家厂商的选项（传给各自的 create）。 */
export type VendorComposersOptions = { [V in AgentVendor]: Parameters<(typeof VENDORS)[V]["create"]>[0] };

/** 每家厂商一个完整的实现（含另起进程问命令列表）。 */
export function createVendorComposers(options: VendorComposersOptions): Readonly<Record<AgentVendor, VendorComposer>> {
  const create = (vendor: AgentVendor): VendorComposer => (VENDORS[vendor].create as (o: unknown) => VendorComposer)(options[vendor]);
  return Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, create(vendor)])) as Record<AgentVendor, VendorComposer>;
}

// 各家厂商的输入框、模型名单与驱动在守护进程侧的统一登记表（接口见 types.ts，设计见 docs/vendor-registry-design.md）。
// 加一家厂商要动的地方：
// 1. shared/vendors.ts：AGENT_VENDORS 加编号、VENDOR_SPECS 加它的清单（含 composer：命令开头、隐藏名单和原因）；
// 2. vendors/<厂商>.ts：平级加一个，导出不起进程的 VendorComposerBase、create<厂商>Composer、probe 与 catalog；
// 3. driver/<厂商>-driver.ts：实现 Driver 接口；
// 4. 下面的 DAEMON_VENDORS 加一行（base、createComposer、probe、catalog、createDriver 一起登记，daemon.ts 循环装配）。
import { AGENT_VENDORS, isAgentVendor, type AgentVendor, type Driver, type DriverOptions } from "../../shared/index.ts";
import { createAgyDriver } from "../driver/agy-driver.ts";
import { createClaudeDriver } from "../driver/claude-driver.ts";
import { createCodexDriver } from "../driver/codex-driver.ts";
import { queryClaudeInitialize, type VendorCatalogSource } from "../driver/model-catalog.ts";
import { agyCatalogProbe, agyComposerBase, createAgyCatalogSource, createAgyComposer, type AgyComposerOptions } from "./agy.ts";
import { claudeCatalogProbe, createClaudeCatalogSource } from "./claude-catalog.ts";
import {
  claudeComposerBase,
  createClaudeComposer,
  type ClaudeComposerOptions,
} from "./claude.ts";
import {
  codexCatalogProbe,
  codexComposerBase,
  createCodexCatalogSource,
  createCodexComposer,
  type CodexComposerOptions,
} from "./codex.ts";
import type { VendorCatalogProbe, VendorCatalogSourceOptions, VendorComposer, VendorComposerBase } from "./types.ts";

export type { VendorCatalogProbe, VendorCatalogSourceOptions, VendorComposer, VendorComposerBase } from "./types.ts";
export { claudeComposerBase } from "./claude.ts";

export interface VendorDriverDeps extends Omit<DriverOptions, "claudePath"> {
  claudePath?: string;
  executablePath: string;
  defaultModel?: () => Promise<string | null>;
}

interface VendorComposerDeps {
  executablePath: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface DaemonVendorModule {
  base: VendorComposerBase;
  createComposer: (options: VendorComposerDeps) => VendorComposer;
  probe: VendorCatalogProbe;
  catalog: (options: VendorCatalogSourceOptions) => VendorCatalogSource;
  createDriver: (deps: VendorDriverDeps) => Driver;
}

export const DAEMON_VENDORS: Readonly<Record<AgentVendor, DaemonVendorModule>> = {
  claude: {
    base: claudeComposerBase,
    createComposer: ({ executablePath, ...rest }) =>
      createClaudeComposer({ claudePath: executablePath, queryInitialize: queryClaudeInitialize, ...rest }),
    probe: claudeCatalogProbe,
    catalog: createClaudeCatalogSource,
    createDriver: ({ executablePath, ...deps }) => createClaudeDriver({ claudePath: executablePath, ...deps }),
  },
  agy: {
    base: agyComposerBase,
    createComposer: ({ executablePath, ...rest }) => createAgyComposer({ agyPath: executablePath, ...rest }),
    probe: agyCatalogProbe,
    catalog: createAgyCatalogSource,
    createDriver: ({ executablePath, ...deps }) => createAgyDriver({ agyPath: executablePath, ...deps }),
  },
  codex: {
    base: codexComposerBase,
    createComposer: ({ executablePath, ...rest }) => createCodexComposer({ codexPath: executablePath, ...rest }),
    probe: codexCatalogProbe,
    catalog: createCodexCatalogSource,
    createDriver: ({ executablePath, ...deps }) => createCodexDriver({ codexPath: executablePath, ...deps }),
  },
};

/** 各家怎么从模型名单那次查询里看登录状态（纯函数）。 */
export const VENDOR_CATALOG_PROBES: Readonly<Record<AgentVendor, VendorCatalogProbe>> = Object.fromEntries(
  AGENT_VENDORS.map((vendor) => [vendor, DAEMON_VENDORS[vendor].probe]),
) as Record<AgentVendor, VendorCatalogProbe>;

/** 每家厂商的模型名单来源（含登录状态的判断），交给 createModelCatalogs。 */
export function createVendorCatalogSources(options: Readonly<Record<AgentVendor, VendorCatalogSourceOptions>>): Record<AgentVendor, VendorCatalogSource> {
  return Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, DAEMON_VENDORS[vendor].catalog(options[vendor])])) as Record<AgentVendor, VendorCatalogSource>;
}

/** 每家厂商的驱动实例，交给 createMultiVendorDriver。 */
export function createVendorDrivers(deps: Readonly<Record<AgentVendor, VendorDriverDeps>>): Record<AgentVendor, Driver> {
  return Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, DAEMON_VENDORS[vendor].createDriver(deps[vendor])])) as Record<AgentVendor, Driver>;
}

/** 不用起进程的那部分，按厂商（会话那一行的 vendor）找；不认识的厂商是 null。 */
export function composerBaseOf(vendor: string): VendorComposerBase | null {
  return isAgentVendor(vendor) ? DAEMON_VENDORS[vendor].base : null;
}

/** 每家厂商的选项（传给各自的 create，支持统一传 executablePath 或按家传特定选项）。 */
export type VendorComposersOptions =
  | Readonly<Record<AgentVendor, VendorComposerDeps>>
  | {
      claude: ClaudeComposerOptions | VendorComposerDeps;
      agy?: AgyComposerOptions | VendorComposerDeps;
      codex?: CodexComposerOptions | VendorComposerDeps;
    };

const LEGACY_COMPOSER_CREATORS = {
  claude: (opt: unknown) => createClaudeComposer(opt as ClaudeComposerOptions),
  agy: (opt: unknown) => createAgyComposer(opt as AgyComposerOptions | undefined),
  codex: (opt: unknown) => createCodexComposer(opt as CodexComposerOptions | undefined),
} satisfies Record<AgentVendor, (opt: unknown) => VendorComposer>;

/** 每家厂商一个完整的实现（含另起进程问命令列表）。 */
export function createVendorComposers(options: VendorComposersOptions): Readonly<Record<AgentVendor, VendorComposer>> {
  const create = (vendor: AgentVendor): VendorComposer => {
    const opt = options[vendor];
    if (opt && "executablePath" in opt) {
      return DAEMON_VENDORS[vendor].createComposer(opt);
    }
    return LEGACY_COMPOSER_CREATORS[vendor](opt);
  };
  return Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, create(vendor)])) as Record<AgentVendor, VendorComposer>;
}

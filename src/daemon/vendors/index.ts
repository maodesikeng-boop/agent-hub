// 各家厂商在守护进程侧的统一登记表（接口见 types.ts 和 src/vendors/daemon-types.ts，设计见 docs/vendor-plugin-design.md 3.4 节）。
// 每家的实现在 src/vendors/<厂商>/daemon.ts，名单只在 src/vendors/registry.ts；这里只从 src/vendors/daemon-registry.ts 推出旧形状
// （导出名不变，调用方不动），daemon.ts 没写的可选项在这里补通用兜底（docs/vendor-plugin-design.md 第 4 节）：
// - composer 缺了：src/vendors/_common/composer.ts（只认 spec 的命令开头、隐藏名单，命令列表只有压缩命令）；
// - catalog 缺了：不问，模型名单用打包的、状态 unknown（createModelCatalogs 对没给来源的厂商就是这么做）。
import { AGENT_VENDORS, isAgentVendor, type AgentVendor, type Driver } from "../../shared/index.ts";
import { vendorCatalogFingerprint } from "../../shared/paths.ts";
import { createSpecComposer } from "../../vendors/_common/composer.ts";
import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import type { VendorComposerDeps, VendorDriverDeps } from "../../vendors/daemon-types.ts";
import type { VendorCatalogSource } from "../driver/model-catalog.ts";
import type { VendorCatalogProbe, VendorCatalogSourceOptions, VendorComposer, VendorComposerBase } from "./types.ts";

export type { VendorCatalogProbe, VendorCatalogSourceOptions, VendorComposer, VendorComposerBase } from "./types.ts";
export type { VendorComposerDeps, VendorDriverDeps } from "../../vendors/daemon-types.ts";

export interface DaemonVendorModule {
  base: VendorComposerBase;
  createComposer: (options: VendorComposerDeps) => VendorComposer;
  probe: VendorCatalogProbe;
  /** 没有（这家 daemon.ts 没写 catalog）就不问，用打包的名单。 */
  catalog: ((options: VendorCatalogSourceOptions) => VendorCatalogSource) | null;
  createDriver: (deps: VendorDriverDeps) => Driver;
}

/** 没写 catalog 的厂商：不起进程，看不出名单（用打包的），登录状态说不清。 */
const UNKNOWN_PROBE: VendorCatalogProbe = { parse: () => null, availabilityOf: () => "unknown" };

function daemonModule(vendor: AgentVendor): DaemonVendorModule {
  const daemon = VENDOR_DAEMONS[vendor];
  const composer = daemon.composer ?? (() => {
    const fallback = createSpecComposer(vendor);
    return { base: fallback, create: () => fallback };
  })();
  return {
    base: composer.base,
    createComposer: (options) => composer.create(options),
    probe: daemon.catalog?.probe ?? UNKNOWN_PROBE,
    catalog: daemon.catalog ? (options) => daemon.catalog!.source(options) : null,
    createDriver: (deps) => daemon.createDriver(deps),
  };
}

export const DAEMON_VENDORS: Readonly<Record<AgentVendor, DaemonVendorModule>> = Object.fromEntries(
  AGENT_VENDORS.map((vendor) => [vendor, daemonModule(vendor)]),
) as Record<AgentVendor, DaemonVendorModule>;

/** 各家怎么从模型名单那次查询里看登录状态（纯函数）。 */
export const VENDOR_CATALOG_PROBES: Readonly<Record<AgentVendor, VendorCatalogProbe>> = Object.fromEntries(
  AGENT_VENDORS.map((vendor) => [vendor, DAEMON_VENDORS[vendor].probe]),
) as Record<AgentVendor, VendorCatalogProbe>;

/**
 * 每家厂商的模型名单来源（含登录状态的判断），交给 createModelCatalogs；没写 catalog 的厂商不给（用打包的）。
 * 没给指纹的按通用规则算（shared/paths.ts 的 vendorCatalogFingerprint：可执行文件 + spec 的 catalogWatchPaths 的 stat）。
 */
export function createVendorCatalogSources(
  options: Readonly<Record<AgentVendor, VendorCatalogSourceOptions>>,
): Partial<Record<AgentVendor, VendorCatalogSource>> {
  const out: Partial<Record<AgentVendor, VendorCatalogSource>> = {};
  for (const vendor of AGENT_VENDORS) {
    const create = DAEMON_VENDORS[vendor].catalog;
    const opt = options[vendor];
    if (create === null) continue;
    out[vendor] = create({
      ...opt,
      fingerprint:
        opt.fingerprint ??
        (() => {
          const p = typeof opt.path === "function" ? opt.path() : opt.path;
          const e = typeof opt.env === "function" ? opt.env() : (opt.env ?? process.env);
          return vendorCatalogFingerprint(vendor, p, e, opt.cwd);
        }),
    });
  }
  return out;
}

/** 每家厂商的驱动实例，交给 createMultiVendorDriver；输入框不起进程的那部分按名单传进去（基类不认识任何一家，A11）。 */
export function createVendorDrivers(deps: Readonly<Record<AgentVendor, VendorDriverDeps>>): Record<AgentVendor, Driver> {
  return Object.fromEntries(
    AGENT_VENDORS.map((vendor) => [vendor, DAEMON_VENDORS[vendor].createDriver({ composer: DAEMON_VENDORS[vendor].base, ...deps[vendor] })]),
  ) as Record<AgentVendor, Driver>;
}

/** 不用起进程的那部分，按厂商（会话那一行的 vendor）找；不认识的厂商是 null。 */
export function composerBaseOf(vendor: string): VendorComposerBase | null {
  return isAgentVendor(vendor) ? DAEMON_VENDORS[vendor].base : null;
}

/** 每家厂商一个完整的实现（含另起进程问命令列表）。 */
export function createVendorComposers(options: Readonly<Record<AgentVendor, VendorComposerDeps>>): Readonly<Record<AgentVendor, VendorComposer>> {
  return Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, DAEMON_VENDORS[vendor].createComposer(options[vendor])])) as Record<
    AgentVendor,
    VendorComposer
  >;
}

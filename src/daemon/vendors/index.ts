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
  catalog: ((options: VendorCatalogSourceOptions) => VendorCatalogSource) | null;
  createDriver: (deps: VendorDriverDeps) => Driver;
}

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

export const VENDOR_CATALOG_PROBES: Readonly<Record<AgentVendor, VendorCatalogProbe>> = Object.fromEntries(
  AGENT_VENDORS.map((vendor) => [vendor, DAEMON_VENDORS[vendor].probe]),
) as Record<AgentVendor, VendorCatalogProbe>;

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

export function createVendorDrivers(deps: Readonly<Record<AgentVendor, VendorDriverDeps>>): Record<AgentVendor, Driver> {
  return Object.fromEntries(
    AGENT_VENDORS.map((vendor) => [vendor, DAEMON_VENDORS[vendor].createDriver({ composer: DAEMON_VENDORS[vendor].base, ...deps[vendor] })]),
  ) as Record<AgentVendor, Driver>;
}

export function composerBaseOf(vendor: string): VendorComposerBase | null {
  return isAgentVendor(vendor) ? DAEMON_VENDORS[vendor].base : null;
}

export function createVendorComposers(options: Readonly<Record<AgentVendor, VendorComposerDeps>>): Readonly<Record<AgentVendor, VendorComposer>> {
  return Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, DAEMON_VENDORS[vendor].createComposer(options[vendor])])) as Record<
    AgentVendor,
    VendorComposer
  >;
}

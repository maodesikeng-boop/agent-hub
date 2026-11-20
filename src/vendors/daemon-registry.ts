// Vendor daemon code may only import type from this module: top-level await import cycles deadlock.
import type { VendorDaemon } from "./daemon-types.ts";
import { importVendorFile } from "./load.ts";
import { VENDOR_LIST, type AgentVendor } from "./registry.ts";

export const VENDOR_DAEMONS: Readonly<Record<AgentVendor, VendorDaemon>> = Object.fromEntries(
  await Promise.all(VENDOR_LIST.map(async (spec) => [spec.id, ((await importVendorFile(spec.id, "daemon.ts")) as { default: VendorDaemon }).default])),
) as Record<AgentVendor, VendorDaemon>;

// Must not import node:fs: test setupFiles load this before tests mock fs.
import type { VendorPathsModule } from "./daemon-types.ts";
import { importVendorFile } from "./load.ts";
import { VENDOR_LIST, type AgentVendor } from "./registry.ts";

export const VENDOR_PATHS: Readonly<Record<AgentVendor, VendorPathsModule>> = Object.fromEntries(
  await Promise.all(VENDOR_LIST.map(async ({ id }) => [id, (await importVendorFile(id, "paths.ts")) as VendorPathsModule])),
) as Record<AgentVendor, VendorPathsModule>;

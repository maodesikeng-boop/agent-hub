import type { AgentVendor, ModelCatalog } from "../../shared/index.ts";

/**
 * Provider the New PM dialog shows before the user touches the Provider row.
 * Postcondition: defaultPmVendor over the given device catalogs, so it follows catalog refreshes on that device.
 */
export function newPmDefaultVendor(catalogs: readonly ModelCatalog[]): AgentVendor {
  void catalogs;
  throw new Error("Not implemented");
}

/**
 * Line shown above Create when the picked provider cannot run on this device.
 * Postcondition: null when `picked` is selectable. Otherwise "No provider is ready on this computer." when no
 * catalog is selectable, else "<label> is not installed on this computer." or "<label> is not signed in on this computer."
 */
export function newPmProviderNotice(picked: ModelCatalog, catalogs: readonly ModelCatalog[]): string | null {
  void [picked, catalogs];
  throw new Error("Not implemented");
}

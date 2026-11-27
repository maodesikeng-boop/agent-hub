import { availabilityOfCatalogs, defaultPmVendor, isSelectable, vendorLabel, type AgentVendor, type ModelCatalog } from "../../shared/index.ts";

/**
 * Provider the New PM dialog shows before the user touches the Provider row.
 * Postcondition: defaultPmVendor over the given device catalogs, so it follows catalog refreshes on that device.
 */
export function newPmDefaultVendor(catalogs: readonly ModelCatalog[]): AgentVendor {
  return defaultPmVendor(availabilityOfCatalogs(catalogs));
}

/**
 * Line shown above Create when the picked provider cannot run on this device.
 * Postcondition: null when `picked` is selectable. Otherwise "No provider is ready on this computer." when no
 * catalog is selectable, else "<label> is not installed on this computer." or "<label> is not signed in on this computer."
 */
export function newPmProviderNotice(picked: ModelCatalog, catalogs: readonly ModelCatalog[]): string | null {
  if (isSelectable(picked.availability)) return null;
  if (!catalogs.some((c) => isSelectable(c.availability))) return "No provider is ready on this computer.";
  const label = vendorLabel(picked.vendor);
  return picked.availability === "signed_out" ? `${label} is not signed in on this computer.` : `${label} is not installed on this computer.`;
}

import { AGENT_VENDORS } from "../../shared/vendors.ts";
import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import type { ForkerRegistry } from "./forker.ts";

export const FORKERS: ForkerRegistry = Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, VENDOR_DAEMONS[vendor].forkers ?? []])) as ForkerRegistry;

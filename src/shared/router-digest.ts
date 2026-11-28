// Invariant: every untrusted remote DeviceRouterDigest is parsed and normalized into the domain type before caching or dispatch, rejecting malformed structures while stripping unknown future keys and defaulting omitted legacy optional fields.
import type { DeviceRouterDigest } from "./router.ts";

export type DeviceRouterDigestParseResult =
  | { readonly ok: true; readonly digest: DeviceRouterDigest }
  | { readonly ok: false; readonly reason: string };

/**
 * Precondition: raw is the result of JSON.parse on a remote /api/router/digest response body.
 * Postcondition: returns { ok: true, digest } with guaranteed arrays and domain types when raw satisfies the DeviceRouterDigest contract (allowing unknown extra keys and legacy omitted optional fields), or { ok: false, reason } when required fields are missing or any present field has an invalid type or shape.
 */
export function parseDeviceRouterDigest(_raw: unknown): DeviceRouterDigestParseResult {
  throw new Error("Not implemented");
}

// Invariant: BlindVendorMatrix exhaustively covers every AgentVendor registered in src/shared/vendors.ts.
import type { AgentVendor } from "../../src/shared/vendors.ts";
import type { BlindAgentAdapter, BlindAgentTurnResponse, BlindVendorMatrix } from "./types.ts";

export interface ResolveVendorAdapterOptions {
  readonly vendor: AgentVendor;
  readonly systemPrompt: string;
  readonly blindCwd: string;
  readonly blindHomeDir: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

export type ParsedBlindResponse =
  | { readonly ok: true; readonly response: BlindAgentTurnResponse }
  | { readonly ok: false; readonly noiseReason: string };

/**
 * Postcondition: returns a complete support entry for every AgentVendor in VENDOR_LIST without silent omissions.
 */
export function listBlindVendorSupport(): BlindVendorMatrix {
  throw new Error("Not implemented");
}

/**
 * Precondition: options.vendor is a registered AgentVendor and options.blindCwd is an isolated empty directory.
 * Postcondition: returns a headless BlindAgentAdapter with an immutable system prompt, or throws when the vendor is unsupported.
 */
export function resolveBlindVendorAdapter(_options: ResolveVendorAdapterOptions): BlindAgentAdapter {
  throw new Error("Not implemented");
}

/**
 * Precondition: rawOutput is raw stdout returned by a blind-agent vendor CLI.
 * Postcondition: parses a valid BlindAgentTurnResponse or returns ok=false with a structured harness_noise reason without throwing.
 */
export function parseBlindActionResponse(_rawOutput: string): ParsedBlindResponse {
  throw new Error("Not implemented");
}

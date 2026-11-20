import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import { isAgentVendor } from "../../shared/vendors.ts";
import type { TranscriptRef, TranscriptRoots } from "./transcript-files.ts";

export type { TranscriptRef, TranscriptRoots } from "./transcript-files.ts";

export function vendorSessionFiles(ref: TranscriptRef, roots: TranscriptRoots = {}): string[] {
  if (!isAgentVendor(ref.vendor)) return [];
  return VENDOR_DAEMONS[ref.vendor].sessionFiles?.(ref, roots) ?? [];
}

export function vendorTranscriptPath(ref: TranscriptRef, roots: TranscriptRoots = {}): string | null {
  if (!isAgentVendor(ref.vendor)) return null;
  return VENDOR_DAEMONS[ref.vendor].transcriptPath?.(ref, roots) ?? null;
}

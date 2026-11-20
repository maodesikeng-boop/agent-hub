import { createHash } from "node:crypto";
import type { ReadonlyPolicy } from "./readonly-policy.ts";

export interface LaunchContents {
  prompt: string;
  settings: string | null;
  readonly?: ReadonlyPolicy;
  skills?: string;
  capabilityLaunch?: unknown;
}

export function launchFingerprint(contents: LaunchContents): string {
  const parts: unknown[] = [contents.prompt, contents.settings];
  if (contents.readonly !== undefined) parts.push(contents.readonly);
  if (contents.skills !== undefined) parts.push({ skills: contents.skills });
  if (contents.capabilityLaunch !== undefined) parts.push({ capabilityLaunch: contents.capabilityLaunch });
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

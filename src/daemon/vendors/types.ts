import type { AgentVendor, ComposerCommand, ModelCatalog, VendorAvailability } from "../../shared/index.ts";
import type { CatalogFingerprint } from "../../shared/paths.ts";

export interface CommandsTarget {
  cwd: string;
  addDirs: readonly string[];
}

export interface VendorComposerBase {
  readonly vendor: AgentVendor;
  parseCommands(raw: unknown): ComposerCommand[] | null;
  isHiddenCommand(command: ComposerCommand): boolean;
  isCompactCommand(text: string): boolean;
  isCommand(text: string): boolean;
  blockReason(text: string, known: readonly ComposerCommand[] | null): string | null;
  mention(path: string): string;
  buildUserContent(prefixes: readonly string[], text: string): unknown[];
}

export interface VendorComposer extends VendorComposerBase {
  queryCommands(target: CommandsTarget, signal: AbortSignal): Promise<ComposerCommand[]>;
}

export interface VendorCatalogProbe {
  parse(raw: unknown): ModelCatalog | null;
  availabilityOf(raw: unknown): VendorAvailability;
  availabilityOfError?(error: unknown): VendorAvailability;
  /** Returns true when the probe returned a degraded fallback list rather than a confirmed fresh catalog. */
  isDegraded?(raw: unknown): boolean;
}

export interface VendorCatalogSourceOptions {
  path: string | (() => string);
  cwd: string;
  installed: () => boolean;
  fingerprint?: () => CatalogFingerprint;
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
}

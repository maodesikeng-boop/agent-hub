// Reads config.toml and the credential directory instead of starting kimi acp.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_CATALOG_LABEL_CHARS,
  MAX_CATALOG_MODELS,
  bundledModelCatalog,
  checkModel,
  truncateChars,
  type CatalogModel,
  type ModelCatalog,
  type VendorAvailability,
} from "../../shared/index.ts";
import { defaultAvailabilityOfError, type VendorCatalogSource } from "../../daemon/driver/model-catalog.ts";
import type { VendorCatalogProbe, VendorCatalogSourceOptions } from "../../daemon/vendors/types.ts";
import { isPlainObject } from "../_common/sync/jsonc.ts";
import { readTomlObjectFile } from "../_common/sync/toml.ts";
import { KIMI_MAX_CREDENTIAL_ENTRIES } from "./limits.ts";
import { resolveKimiHome } from "./paths.ts";

export interface KimiCatalogRaw {
  kind: "kimi";
  signedIn: boolean;
  defaultModel: string | null;
  models: readonly { id: string; label: string }[];
}

function isKimiRaw(raw: unknown): raw is KimiCatalogRaw {
  return isPlainObject(raw) && raw.kind === "kimi" && typeof raw.signedIn === "boolean" && Array.isArray(raw.models);
}

export function hasKimiOAuthCredentials(kimiHome: string): boolean {
  try {
    return readdirSync(join(kimiHome, "credentials"), { withFileTypes: true })
      .slice(0, KIMI_MAX_CREDENTIAL_ENTRIES)
      .some((entry) => entry.isFile() && entry.name.endsWith(".json"));
  } catch {
    return false;
  }
}

function providerHasInlineKey(provider: unknown): boolean {
  if (!isPlainObject(provider)) return false;
  if (typeof provider.api_key === "string" && provider.api_key.trim() !== "") return true;
  return isPlainObject(provider.env) && typeof provider.env.KIMI_API_KEY === "string" && provider.env.KIMI_API_KEY.trim() !== "";
}

export function readKimiCatalogRaw(kimiHome: string, env: Readonly<Record<string, string | undefined>>): KimiCatalogRaw {
  let data: Record<string, unknown> = {};
  try {
    data = readTomlObjectFile(join(kimiHome, "config.toml")).data;
  } catch {
  }
  const models = isPlainObject(data.models)
    ? Object.entries(data.models).map(([id, entry]) => ({
        id,
        label: isPlainObject(entry) && typeof entry.display_name === "string" ? entry.display_name : id,
      }))
    : [];
  const providers = isPlainObject(data.providers) ? Object.values(data.providers) : [];
  const signedIn =
    (env.KIMI_MODEL_API_KEY?.trim() ?? "") !== "" || hasKimiOAuthCredentials(kimiHome) || providers.some(providerHasInlineKey);
  return {
    kind: "kimi",
    signedIn,
    defaultModel: typeof data.default_model === "string" && data.default_model.trim() !== "" ? data.default_model.trim() : null,
    models,
  };
}

export function parseKimiCatalog(raw: KimiCatalogRaw): ModelCatalog {
  const base = bundledModelCatalog("kimi");
  const extra: CatalogModel[] = raw.models
    .filter((m) => checkModel("kimi", m.id) === null && !base.models.some((b) => b.id === m.id))
    .map((m) => ({ id: m.id, label: truncateChars(m.label, MAX_CATALOG_LABEL_CHARS), description: null, efforts: null }));
  if (extra.length === 0 && raw.defaultModel === null) return base;
  return {
    ...base,
    source: "vendor",
    models: [...base.models, ...extra].slice(0, MAX_CATALOG_MODELS),
    defaultModel: raw.defaultModel,
    defaultModelId: raw.defaultModel,
  };
}

export const kimiCatalogProbe: VendorCatalogProbe = {
  parse: (raw) => (isKimiRaw(raw) ? parseKimiCatalog(raw) : null),
  availabilityOf: (raw): VendorAvailability => (isKimiRaw(raw) ? (raw.signedIn ? "available" : "signed_out") : "unknown"),
  availabilityOfError: (error) => defaultAvailabilityOfError("kimi", error),
};

export function createKimiCatalogSource(options: VendorCatalogSourceOptions): VendorCatalogSource {
  return {
    ...kimiCatalogProbe,
    installed: options.installed,
    ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
    async query(signal) {
      if (signal.aborted) throw new Error("cancelled");
      const env = typeof options.env === "function" ? options.env() : (options.env ?? process.env);
      return readKimiCatalogRaw(resolveKimiHome(env.HOME?.trim() || env.USERPROFILE?.trim() || undefined, env), env);
    },
  };
}

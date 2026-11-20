import {
  MAX_CATALOG_LABEL_CHARS,
  MAX_CATALOG_MODELS,
  MODEL_CATALOG_TIMEOUT_MS,
  bundledModelCatalog,
  checkModel,
  truncateChars,
  vendorFailureOf,
  type CatalogModel,
  type ModelCatalog,
  type VendorAvailability,
} from "../../shared/index.ts";
import { defaultAvailabilityOfError, parseJsonOutput, type VendorCatalogSource } from "../../daemon/driver/model-catalog.ts";
import type { VendorCatalogProbe, VendorCatalogSourceOptions } from "../../daemon/vendors/types.ts";
import { runShortSubcommand } from "../_common/setup/file-helpers.ts";

interface OpenCodeCatalogRaw {
  modelsText: string | null;
  authJson: unknown;
  error: string | null;
}

const MODEL_LINE_RE = /^([A-Za-z0-9][\w.-]*)\/([\w.:@+-]+)$/u;
const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/gu;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isCatalogRaw(raw: unknown): raw is OpenCodeCatalogRaw {
  const obj = asRecord(raw);
  return obj !== null && "modelsText" in obj && "authJson" in obj && (typeof obj.modelsText === "string" || obj.modelsText === null);
}

// `opencode models` prints one provider/model ID per line.
export function parseOpenCodeModelsText(text: string): ModelCatalog | null {
  const found = new Map<string, CatalogModel>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const id = rawLine.replace(ANSI_ESCAPE_RE, "").trim();
    if (!MODEL_LINE_RE.test(id) || found.has(id) || checkModel("opencode", id) !== null) continue;
    found.set(id, { id, label: truncateChars(id, MAX_CATALOG_LABEL_CHARS), description: null, efforts: null });
  }
  if (found.size === 0) return null;
  const base = bundledModelCatalog("opencode");
  const ordered = [
    ...base.models.flatMap((m) => {
      const hit = found.get(m.id);
      return hit ? [{ ...hit, label: m.label }] : [];
    }),
    ...[...found.values()].filter((m) => !base.models.some((b) => b.id === m.id)),
  ];
  return { ...base, source: "vendor", models: ordered.slice(0, MAX_CATALOG_MODELS) };
}

export function countOpenCodeAccounts(authJson: unknown): number | null {
  if (Array.isArray(authJson)) return authJson.length;
  const obj = asRecord(authJson);
  if (obj === null) return null;
  for (const key of ["accounts", "integrations", "providers", "credentials"]) {
    const value = obj[key];
    if (Array.isArray(value)) return value.length;
    const nested = asRecord(value);
    if (nested !== null) return Object.keys(nested).length;
  }
  return Object.keys(obj).length;
}

export const opencodeCatalogProbe: VendorCatalogProbe = {
  parse(raw) {
    return isCatalogRaw(raw) && raw.modelsText !== null ? parseOpenCodeModelsText(raw.modelsText) : null;
  },
  availabilityOf(raw): VendorAvailability {
    if (!isCatalogRaw(raw)) return "unknown";
    const accounts = countOpenCodeAccounts(raw.authJson);
    if (accounts !== null && accounts > 0) return "available";
    if (raw.error !== null) {
      if (/\bENOENT\b/u.test(raw.error)) return "not_installed";
      if (vendorFailureOf(raw.error, "opencode")?.kind === "auth") return "signed_out";
    }
    // Zen's free models answer without an account, so a listed catalog alone means usable.
    if (raw.modelsText !== null && parseOpenCodeModelsText(raw.modelsText) !== null) return "available";
    return accounts === 0 ? "signed_out" : "unknown";
  },
  availabilityOfError(error) {
    return defaultAvailabilityOfError("opencode", error);
  },
};

async function runOpenCode(
  options: VendorCatalogSourceOptions,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const exePath = typeof options.path === "function" ? options.path() : options.path;
  const env = typeof options.env === "function" ? options.env() : (options.env ?? process.env);
  const res = await runShortSubcommand(exePath, args, {
    cwd: options.cwd,
    env: { ...env, NO_COLOR: "1" },
    timeoutMs: MODEL_CATALOG_TIMEOUT_MS,
    signal,
    purpose: "probe:opencode",
  });
  if (res.code !== 0) throw new Error(`opencode ${args.join(" ")} failed: ${res.stderr.trim() || res.stdout.trim() || `exit=${res.code}`}`);
  return res.stdout;
}

export function createOpenCodeCatalogSource(options: VendorCatalogSourceOptions): VendorCatalogSource {
  return {
    ...opencodeCatalogProbe,
    installed: options.installed,
    ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
    async query(signal): Promise<OpenCodeCatalogRaw> {
      const [models, auth] = await Promise.allSettled([
        runOpenCode(options, ["models"], signal),
        runOpenCode(options, ["auth", "list", "--format", "json"], signal),
      ]);
      if (models.status === "rejected" && auth.status === "rejected") throw models.reason;
      const parsedAuth = auth.status === "fulfilled" ? parseJsonOutput(auth.value) : { ok: false as const };
      const failure = [models, auth].find((r) => r.status === "rejected");
      return {
        modelsText: models.status === "fulfilled" ? models.value : null,
        authJson: parsedAuth.ok ? parsedAuth.value : null,
        error: failure?.status === "rejected" ? String(failure.reason instanceof Error ? failure.reason.message : failure.reason) : null,
      };
    },
  };
}

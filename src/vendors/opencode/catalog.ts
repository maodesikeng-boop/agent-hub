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

function countArrayAccounts(items: readonly unknown[]): number {
  let count = 0;
  for (const item of items) {
    const rec = asRecord(item);
    if (rec !== null && Array.isArray(rec.connections)) {
      if (rec.connections.length > 0) count += 1;
    } else {
      count += 1;
    }
  }
  return count;
}

export function countOpenCodeAccounts(authJson: unknown): number | null {
  if (Array.isArray(authJson)) return countArrayAccounts(authJson);
  const obj = asRecord(authJson);
  if (obj === null) return null;
  for (const key of ["accounts", "integrations", "providers", "credentials"]) {
    const value = obj[key];
    if (Array.isArray(value)) return countArrayAccounts(value);
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
      // Run sequentially: concurrent --standalone starts race on first-time opencode.db migration.
      const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(MODEL_CATALOG_TIMEOUT_MS)]);
      let modelsText: string | null = null;
      let modelsErr: Error | null = null;
      try {
        modelsText = await runOpenCode(options, ["models", "--standalone"], probeSignal);
      } catch (err) {
        modelsErr = err instanceof Error ? err : new Error(String(err));
      }
      let authStdout: string | null = null;
      let authErr: Error | null = null;
      if (probeSignal.aborted) {
        authErr = probeSignal.reason instanceof Error ? probeSignal.reason : new Error(String(probeSignal.reason ?? "opencode probe aborted"));
      } else {
        try {
          authStdout = await runOpenCode(options, ["auth", "list", "--standalone", "--format", "json"], probeSignal);
        } catch (err) {
          authErr = err instanceof Error ? err : new Error(String(err));
        }
      }
      if (modelsErr !== null && authErr !== null) throw modelsErr;
      const parsedAuth = authStdout !== null ? parseJsonOutput(authStdout) : { ok: false as const };
      const failure = modelsErr ?? authErr;
      return {
        modelsText,
        authJson: parsedAuth.ok ? parsedAuth.value : null,
        error: failure !== null ? failure.message : null,
      };
    },
  };
}

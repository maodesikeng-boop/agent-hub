import { MAX_VENDOR_SYNC_PREVIEW_CHARS, truncateChars } from "../../shared/index.ts";
import type { CanonicalMcpServer } from "../../vendors/daemon-types.ts";

const SENSITIVE_NAME_RE =
  /(api[_-]?key|token|secret|password|passwd|pwd|pass|auth|bearer|credential|cookie|session|private[_-]?key|access[_-]?key|key)/i;

const SENSITIVE_VALUE_RE =
  /^(?:Bearer\s+\S+|Basic\s+\S+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i;

const SENSITIVE_FLAG_NAME_RE = /(api[-_]?key|token|secret|password|passwd|auth|bearer|credential|cookie|header|key)/i;

const SCHEME_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export const MASKED_PLACEHOLDER = "••••";

export function isSensitiveKeyOrValue(key: string, value: string): boolean {
  if (SENSITIVE_NAME_RE.test(key)) return true;
  return SENSITIVE_VALUE_RE.test(value.trim());
}

function looksLikeTokenSegment(segment: string): boolean {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
  }
  if (SENSITIVE_VALUE_RE.test(decoded)) return true;
  if (decoded.length >= 32) return true;
  return decoded.length >= 16 && /[A-Za-z]/.test(decoded) && /\d/.test(decoded);
}

export function maskUrlSecrets(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    const head = trimmed.split(/[?#]/, 1)[0] ?? "";
    const tail = head.length < trimmed.length ? `?${MASKED_PLACEHOLDER}` : "";
    return head.replace(/\/\/[^/@]*@/, `//${MASKED_PLACEHOLDER}@`) + tail;
  }
  const userinfo = parsed.username || parsed.password ? `${MASKED_PLACEHOLDER}@` : "";
  const hostPart = parsed.host ? `//${userinfo}${parsed.host}` : "";
  const path = parsed.pathname
    .split("/")
    .map((seg) => (seg !== "" && looksLikeTokenSegment(seg) ? MASKED_PLACEHOLDER : seg))
    .join("/");
  const queryKeys = [...new Set(parsed.searchParams.keys())];
  const query = queryKeys.length > 0 ? `?${queryKeys.map((k) => `${k}=${MASKED_PLACEHOLDER}`).join("&")}` : "";
  const hash = parsed.hash ? `#${MASKED_PLACEHOLDER}` : "";
  return `${parsed.protocol}${hostPart}${path}${query}${hash}`;
}

function maskSingleCliArg(arg: string): string {
  if (SCHEME_URL_RE.test(arg.trim())) return maskUrlSecrets(arg);
  const eq = arg.indexOf("=");
  if (eq > 0) {
    const left = arg.slice(0, eq);
    const right = arg.slice(eq + 1);
    if (SCHEME_URL_RE.test(right.trim())) return `${left}=${maskUrlSecrets(right)}`;
    if (SENSITIVE_FLAG_NAME_RE.test(left) || isSensitiveKeyOrValue(left, right)) {
      return `${left}=${MASKED_PLACEHOLDER}`;
    }
  }
  if (SENSITIVE_VALUE_RE.test(arg.trim())) return MASKED_PLACEHOLDER;
  if (!/[/.@\s]/.test(arg) && arg.length >= 20 && /[A-Za-z]/.test(arg) && /\d/.test(arg)) return MASKED_PLACEHOLDER;
  return arg;
}

export function maskCliCommandSummary(command: string, args: readonly string[]): string {
  const maskedArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const cur = args[i]!;
    const flagName = /^--?([A-Za-z][\w-]*)$/.exec(cur)?.[1];
    if (flagName !== undefined && i + 1 < args.length && SENSITIVE_FLAG_NAME_RE.test(flagName)) {
      const next = args[i + 1]!;
      const colon = next.indexOf(":");
      const masked = /header/i.test(flagName) && colon > 0 ? `${next.slice(0, colon).trim()}: ${MASKED_PLACEHOLDER}` : MASKED_PLACEHOLDER;
      maskedArgs.push(cur, masked);
      i++;
      continue;
    }
    maskedArgs.push(maskSingleCliArg(cur));
  }
  const full = [command, ...maskedArgs].join(" ").trim();
  return truncateChars(full, MAX_VENDOR_SYNC_PREVIEW_CHARS);
}

export function maskKeyValuePairs(entries: Readonly<Record<string, string>>): string[] {
  return Object.keys(entries).map((k) => `${k}=${MASKED_PLACEHOLDER}`);
}

export function buildMaskedMcpSummary(server: CanonicalMcpServer): {
  maskedTarget: string;
  maskedAuth: string[];
} {
  if (server.transport === "stdio") {
    return {
      maskedTarget: maskCliCommandSummary(server.command, server.args),
      maskedAuth: maskKeyValuePairs(server.env),
    };
  }
  const maskedAuth = maskKeyValuePairs(server.headers);
  if (server.transport === "http" && server.bearerTokenEnvVar) {
    maskedAuth.push(`Bearer=$${server.bearerTokenEnvVar}`);
  }
  return {
    maskedTarget: truncateChars(maskUrlSecrets(server.url), MAX_VENDOR_SYNC_PREVIEW_CHARS),
    maskedAuth,
  };
}

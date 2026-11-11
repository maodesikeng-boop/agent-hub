// 扫描预览专用的密钥脱敏模块：任何落到网页端 `VendorSyncPreviewResponse` 的命令、参数、URL、环境变量与 Header 均在此打码。
import { MAX_VENDOR_SYNC_PREVIEW_CHARS, truncateChars } from "../../shared/index.ts";
import type { CanonicalMcpServer } from "../../vendors/daemon-types.ts";

const SENSITIVE_NAME_RE =
  /(api[_-]?key|token|secret|password|passwd|pwd|auth|bearer|credential|cookie|session[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?key)/i;

const SENSITIVE_VALUE_RE =
  /^(?:Bearer\s+\S+|Basic\s+\S+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i;

const SENSITIVE_CLI_FLAG_RE = /^--?(?:api[-_]?key|token|auth[-_]?token|secret|password|header|bearer)(?:=|$)/i;

export const MASKED_PLACEHOLDER = "••••";

export function isSensitiveKeyOrValue(key: string, value: string): boolean {
  if (SENSITIVE_NAME_RE.test(key)) return true;
  const trimmed = value.trim();
  if (SENSITIVE_VALUE_RE.test(trimmed)) return true;
  return false;
}

export function maskUrlSecrets(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.username) parsed.username = MASKED_PLACEHOLDER;
    if (parsed.password) parsed.password = MASKED_PLACEHOLDER;
    const keys = [...new Set([...parsed.searchParams.keys()])];
    for (const key of keys) {
      const values = parsed.searchParams.getAll(key);
      if (values.some((val) => isSensitiveKeyOrValue(key, val))) {
        parsed.searchParams.set(key, MASKED_PLACEHOLDER);
      }
    }
    // 保留掩码字符可读，不把 `••••` 编码成长串百分号编码
    return parsed.toString().replace(/%E2%80%A2/gi, "•");
  } catch {
    return trimmed.replace(
      /([?&](?:api[_-]?key|token|access_token|secret|password|auth|key)=)([^&#\s]+)/gi,
      `$1${MASKED_PLACEHOLDER}`,
    );
  }
}

function maskSingleCliArg(arg: string): string {
  if (/^https?:\/\//i.test(arg)) return maskUrlSecrets(arg);
  const eq = arg.indexOf("=");
  if (eq > 0) {
    const left = arg.slice(0, eq);
    const right = arg.slice(eq + 1);
    if (SENSITIVE_CLI_FLAG_RE.test(left) || isSensitiveKeyOrValue(left, right)) {
      return `${left}=${MASKED_PLACEHOLDER}`;
    }
  }
  if (SENSITIVE_VALUE_RE.test(arg.trim())) return MASKED_PLACEHOLDER;
  return arg;
}

export function maskCliCommandSummary(command: string, args: readonly string[]): string {
  const maskedArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const cur = args[i]!;
    if ((cur === "--header" || cur === "-H") && i + 1 < args.length) {
      const next = args[i + 1]!;
      const colon = next.indexOf(":");
      maskedArgs.push(cur, colon > 0 ? `${next.slice(0, colon).trim()}: ${MASKED_PLACEHOLDER}` : MASKED_PLACEHOLDER);
      i++;
      continue;
    }
    if (SENSITIVE_CLI_FLAG_RE.test(cur) && !cur.includes("=") && i + 1 < args.length) {
      maskedArgs.push(cur, MASKED_PLACEHOLDER);
      i++;
      continue;
    }
    maskedArgs.push(maskSingleCliArg(cur));
  }
  const full = [command, ...maskedArgs].join(" ").trim();
  return truncateChars(full, MAX_VENDOR_SYNC_PREVIEW_CHARS);
}

export function maskKeyValuePairs(entries: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(entries)) {
    if (isSensitiveKeyOrValue(k, v)) {
      out.push(`${k}=${MASKED_PLACEHOLDER}`);
    } else {
      out.push(`${k}=${truncateChars(v, 32)}`);
    }
  }
  return out;
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

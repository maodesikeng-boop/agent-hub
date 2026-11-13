// DeepSeek Harness（`dsh`）零子进程模型目录与本地凭据探测（docs/vendors/deepseek.md 第 4 节）：
// 绝不拉起 `dsh` 子进程、绝不在后台新建持久空会话；仅做有界本地凭据就绪检查：
// 1) 环境变量 `DEEPSEEK_API_KEY` 非空；
// 2) `$DSH_HOME/.credentials.yaml` 存在非空凭据记录；
// 3) `$DSH_HOME/.env` 存在非注释的非空 `DEEPSEEK_API_KEY=...`；
// 安全边界：绝不读取不可信工作目录 `<cwd>/.env` 来判定全局厂商登录态。
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultAvailabilityOfError,
  nonEmptyString,
  type VendorCatalogSource,
} from "../../daemon/driver/model-catalog.ts";
import type { VendorCatalogProbe, VendorCatalogSourceOptions } from "../../daemon/vendors/types.ts";
import { bundledModelCatalog, type ModelCatalog, type VendorAvailability } from "../../shared/index.ts";
import { MAX_DEEPSEEK_CREDENTIAL_FILE_BYTES } from "./limits.ts";
import { resolveDeepSeekHome } from "./paths.ts";

interface DeepSeekCatalogProbeResult {
  readonly hasCredentials: boolean;
}

function isDeepSeekProbeResult(raw: unknown): raw is DeepSeekCatalogProbeResult {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    typeof (raw as { hasCredentials?: unknown }).hasCredentials === "boolean"
  );
}

/** 在 64 KiB 体积上限内安全读取本地普通文件，异常或超限一律返回 null，绝不抛崩或挂死。 */
function readBoundedUtf8(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_DEEPSEEK_CREDENTIAL_FILE_BYTES) return null;
    const buf = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync(fd, buf, offset, st.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return buf.subarray(0, offset).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 忽略关闭异常
      }
    }
  }
}

/** 剥除引号外的 YAML 行内 `#` 注释。 */
function stripYamlInlineComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inDouble) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === "#" && (i === 0 || /\s/u.test(raw[i - 1]!))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function isNonEmptyYamlScalar(raw: string): boolean {
  const s = stripYamlInlineComment(raw).trim();
  if (s === "" || s === "{}" || s === "[]" || s === "null" || s === "~") return false;
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1).trim() !== "";
  }
  return true;
}

function hasInlineYamlCollection(raw: string): boolean {
  const s = stripYamlInlineComment(raw).trim();
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return false;
    return inner.split(",").some((part) => {
      const colon = part.indexOf(":");
      return colon > 0 && isNonEmptyYamlScalar(part.slice(colon + 1));
    });
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return false;
    return inner.split(",").some((part) => isNonEmptyYamlScalar(part));
  }
  return false;
}

function hasNonEmptyJsonEntries(val: unknown): boolean {
  if (typeof val === "string") return val.trim() !== "";
  if (Array.isArray(val)) return val.some(hasNonEmptyJsonEntries);
  if (typeof val === "object" && val !== null) {
    return Object.values(val).some(hasNonEmptyJsonEntries);
  }
  return typeof val === "number" || typeof val === "boolean";
}

/**
 * 判断 `$DSH_HOME/.credentials.yaml` 是否含有效非空凭据：
 * - 非注释的 `DEEPSEEK_API_KEY` 非空条目；
 * - 或 YAML / JSON 子集的 `refs:` / `records:` 下存在非空键值条目；
 * - 空文件、纯注释、只有 `version: 1`、空 `{}` 或空值均返回 false。
 */
function hasCredentialsInYaml(content: string): boolean {
  const trimmedAll = content.trim();
  if (trimmedAll === "" || trimmedAll === "{}" || trimmedAll === "[]") return false;

  if (trimmedAll.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmedAll);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        return (
          nonEmptyString(obj.DEEPSEEK_API_KEY) !== null ||
          hasNonEmptyJsonEntries(obj.refs) ||
          hasNonEmptyJsonEntries(obj.records)
        );
      }
    } catch {
      // 非纯 JSON，走下方 YAML 逐行扫描
    }
  }

  let sectionIndent: number | null = null;
  let blockScalarIndent: number | null = null;

  for (const rawLine of content.split(/\r?\n/u)) {
    const cleaned = stripYamlInlineComment(rawLine);
    const trimmed = cleaned.trim();
    if (trimmed === "" || trimmed === "---" || trimmed === "...") continue;

    const indent = /^ */u.exec(rawLine)![0].length;

    if (blockScalarIndent !== null) {
      if (indent > blockScalarIndent) return true;
      blockScalarIndent = null;
    }

    const apiKeyMatch = /^(?:-\s+)?(?:export\s+)?DEEPSEEK_API_KEY\s*[:=]\s*(.*)$/u.exec(trimmed);
    if (apiKeyMatch && isNonEmptyYamlScalar(apiKeyMatch[1]!)) {
      return true;
    }

    if (sectionIndent !== null && indent <= sectionIndent) {
      sectionIndent = null;
    }

    if (sectionIndent === null) {
      const secMatch = /^(?:refs|records)\s*:\s*(.*)$/u.exec(trimmed);
      if (secMatch) {
        const rest = secMatch[1]!.trim();
        if (rest === "") {
          sectionIndent = indent;
        } else if (hasInlineYamlCollection(rest)) {
          return true;
        }
      }
      continue;
    }

    const body = trimmed.replace(/^-\s+/u, "");
    const kv = /^([^:]+?)\s*:\s*(.*)$/u.exec(body);
    if (kv) {
      const val = kv[2]!.trim();
      if (/^[|>][-+\d]*$/u.test(val)) {
        blockScalarIndent = indent;
      } else if (hasInlineYamlCollection(val) || isNonEmptyYamlScalar(val)) {
        return true;
      }
    } else if (trimmed.startsWith("-") && isNonEmptyYamlScalar(body)) {
      return true;
    }
  }

  return false;
}

function unquoteDotEnvValue(rawVal: string): string {
  const s = rawVal.trim();
  if (s === "") return "";
  const first = s[0];
  if (first === '"' || first === "'" || first === "`") {
    for (let i = 1; i < s.length; i++) {
      if (first === '"' && s[i] === "\\") {
        i += 1;
        continue;
      }
      if (s[i] === first) {
        const trailing = s.slice(i + 1).trim();
        if (trailing === "" || trailing.startsWith("#")) {
          return s.slice(1, i).trim();
        }
        return "";
      }
    }
    return "";
  }
  return s.replace(/(?:^|\s+)#.*$/u, "").trim();
}

/** 判断 `$DSH_HOME/.env` 是否存在非注释的非空 `DEEPSEEK_API_KEY=...`（剥去成对引号后非空）。 */
function hasApiKeyInDotEnv(content: string): boolean {
  let latestValue: string | null = null;
  for (const rawLine of content.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.*)$/u.exec(trimmed);
    if (match) {
      latestValue = unquoteDotEnvValue(match[1]!);
    }
  }
  return latestValue !== null && latestValue !== "";
}

/**
 * 本地零子进程检查 DeepSeek 凭据是否就绪：
 * 只看进程环境变量 `DEEPSEEK_API_KEY` 与 `$DSH_HOME`（`resolveDeepSeekHome(homedir(), env)`）下的凭据文件，
 * 绝不读取不可信工作目录 `<cwd>/.env`。
 */
export function hasDeepSeekLocalCredentials(
  env: Readonly<Record<string, string | undefined>> = process.env,
  explicitUserHome?: string,
): boolean {
  if (typeof env.DEEPSEEK_API_KEY === "string" && env.DEEPSEEK_API_KEY.trim() !== "") {
    return true;
  }
  const userHome = explicitUserHome?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const dshHome = resolveDeepSeekHome(userHome, env);
  const credYaml = readBoundedUtf8(join(dshHome, ".credentials.yaml"));
  if (credYaml !== null && hasCredentialsInYaml(credYaml)) {
    return true;
  }
  const dotEnv = readBoundedUtf8(join(dshHome, ".env"));
  if (dotEnv !== null && hasApiKeyInDotEnv(dotEnv)) {
    return true;
  }
  return false;
}

async function queryDeepSeekCatalog(options: {
  env?: Readonly<Record<string, string | undefined>>;
  userHome?: string;
  signal?: AbortSignal;
}): Promise<DeepSeekCatalogProbeResult> {
  if (options.signal?.aborted) {
    throw new Error("cancelled");
  }
  return {
    hasCredentials: hasDeepSeekLocalCredentials(options.env ?? process.env, options.userHome),
  };
}

export const deepseekCatalogProbe: VendorCatalogProbe = {
  parse(raw): ModelCatalog | null {
    return isDeepSeekProbeResult(raw) ? bundledModelCatalog("deepseek") : null;
  },
  availabilityOf(raw): VendorAvailability {
    if (!isDeepSeekProbeResult(raw)) return "unknown";
    return raw.hasCredentials ? "available" : "signed_out";
  },
  availabilityOfError(error): VendorAvailability {
    return defaultAvailabilityOfError("deepseek", error);
  },
};

export function createDeepSeekCatalogSource(options: VendorCatalogSourceOptions): VendorCatalogSource {
  return {
    ...deepseekCatalogProbe,
    query: (signal) => {
      const env = typeof options.env === "function" ? options.env() : options.env;
      return queryDeepSeekCatalog({
        ...(env ? { env } : {}),
        userHome: options.cwd,
        signal,
      });
    },
    installed: options.installed,
    ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
  };
}

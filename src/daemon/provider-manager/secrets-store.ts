// 受管厂商密钥存储 `<stateDir>/provider-secrets.json`（docs/providers-install-login-design.md 第 4.2、8.1.2 节）：
// - 强制 0600 原子替换，有界 64 KiB 读取；
// - 已加入 `READONLY_SECRET_STATE_FILES`，只读 Worker 沙箱禁读、sent-files 禁分享；
// - 按文件 stat 实时感知外部修改/删除，提供不含明文的哈希修订指纹触发模型目录即时重算。
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import {
  AGENT_VENDORS,
  PROVIDER_SECRETS_FILE_MAX_BYTES,
  isAgentVendor,
  type AgentVendor,
} from "../../shared/index.ts";
import type { ManagedProviderSecrets } from "../../vendors/daemon-types.ts";
import { writeFileAtomicSyncWithRetry } from "../platform/index.ts";

interface PersistedSecretsFile {
  version: 1;
  vendors: Partial<Record<AgentVendor, Record<string, string>>>;
}

function emptyStore(): Record<AgentVendor, Record<string, string>> {
  return Object.fromEntries(AGENT_VENDORS.map((v) => [v, {}])) as Record<AgentVendor, Record<string, string>>;
}

function computeVendorDigest(entries: Readonly<Record<string, string>>): string {
  const keys = Object.keys(entries).sort();
  if (keys.length === 0) return "0";
  const hash = createHash("sha256");
  for (const k of keys) {
    hash.update(k);
    hash.update("\0");
    hash.update(entries[k]!);
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 12);
}

export function createManagedProviderSecrets(
  filePath: string,
  options?: {
    platform?: string;
    maxBytes?: number;
    log?: (line: string) => void;
  },
): ManagedProviderSecrets {
  const platform = options?.platform ?? process.platform;
  const maxBytes = options?.maxBytes ?? PROVIDER_SECRETS_FILE_MAX_BYTES;
  const log = options?.log ?? (() => {});

  let loadedSig: string | null = null;
  let data = emptyStore();
  let digests = Object.fromEntries(AGENT_VENDORS.map((v) => [v, "0"])) as Record<AgentVendor, string>;

  const refreshDigests = () => {
    for (const vendor of AGENT_VENDORS) {
      digests[vendor] = computeVendorDigest(data[vendor]);
    }
  };

  const statSigOf = (): { sig: string; size: number } | null => {
    try {
      const st = statSync(filePath);
      if (!st.isFile()) return null;
      return { sig: `${Math.trunc(st.mtimeMs)}:${st.size}`, size: st.size };
    } catch {
      return null;
    }
  };

  const reloadIfNeeded = () => {
    const st = statSigOf();
    if (st === null) {
      if (loadedSig !== "missing") {
        data = emptyStore();
        refreshDigests();
        loadedSig = "missing";
      }
      return;
    }
    if (st.sig === loadedSig) return;
    if (st.size > maxBytes) {
      log(`[provider-secrets] 跳过超限密钥文件（${st.size} > ${maxBytes} bytes）：${filePath}`);
      data = emptyStore();
      refreshDigests();
      loadedSig = st.sig;
      return;
    }
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedSecretsFile>;
      const next = emptyStore();
      if (parsed && typeof parsed === "object" && parsed.vendors && typeof parsed.vendors === "object") {
        for (const [vendorKey, envMap] of Object.entries(parsed.vendors)) {
          if (!isAgentVendor(vendorKey) || typeof envMap !== "object" || envMap === null || Array.isArray(envMap)) {
            continue;
          }
          for (const [envName, val] of Object.entries(envMap)) {
            if (typeof val === "string" && val.trim() !== "") {
              next[vendorKey][envName] = val;
            }
          }
        }
      }
      data = next;
      refreshDigests();
      loadedSig = st.sig;
    } catch {
      log(`[provider-secrets] 解析密钥文件失败，按空库回退：${filePath}`);
      data = emptyStore();
      refreshDigests();
      loadedSig = st.sig;
    }
  };

  const persist = () => {
    const serializedVendors: Partial<Record<AgentVendor, Record<string, string>>> = {};
    for (const vendor of AGENT_VENDORS) {
      const entries = data[vendor];
      if (Object.keys(entries).length > 0) {
        serializedVendors[vendor] = { ...entries };
      }
    }
    const payload: PersistedSecretsFile = {
      version: 1,
      vendors: serializedVendors,
    };
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileAtomicSyncWithRetry(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
      fsync: true,
    });
    if (platform !== "win32" && existsSync(filePath)) {
      try {
        chmodSync(filePath, 0o600);
      } catch {
        // ignore chmod errors on special filesystems
      }
    }
    refreshDigests();
    loadedSig = statSigOf()?.sig ?? null;
  };

  return {
    keys(vendor) {
      reloadIfNeeded();
      return Object.keys(data[vendor]);
    },
    has(vendor, envName) {
      reloadIfNeeded();
      const val = data[vendor][envName];
      return typeof val === "string" && val.trim() !== "";
    },
    getEnv(vendor) {
      reloadIfNeeded();
      return { ...data[vendor] };
    },
    set(vendor, entries) {
      reloadIfNeeded();
      const next = { ...data[vendor] };
      for (const [k, v] of Object.entries(entries)) {
        const trimmed = v.trim();
        if (trimmed === "") {
          delete next[k];
        } else {
          next[k] = trimmed;
        }
      }
      data[vendor] = next;
      persist();
    },
    remove(vendor, names) {
      reloadIfNeeded();
      if (names === undefined) {
        if (Object.keys(data[vendor]).length === 0) return;
        data[vendor] = {};
        persist();
        return;
      }
      let changed = false;
      const next = { ...data[vendor] };
      for (const name of names) {
        if (name in next) {
          delete next[name];
          changed = true;
        }
      }
      if (changed) {
        data[vendor] = next;
        persist();
      }
    },
    fingerprint(vendor) {
      reloadIfNeeded();
      return digests[vendor];
    },
  };
}

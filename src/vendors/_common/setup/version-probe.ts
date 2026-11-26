import { statSync } from "node:fs";
import { LRUCache } from "lru-cache";
import {
  AGENT_VENDORS,
  PROVIDER_VERSION_PROBE_RETRY_MS,
  PROVIDER_VERSION_PROBE_TIMEOUT_MS,
  type AgentVendor,
} from "../../../shared/index.ts";
import { stripAnsi } from "./browser-capture.ts";
import { runShortSubcommand } from "./file-helpers.ts";

interface VersionCacheEntry {
  readonly binarySig: string;
  readonly version: string | null;
}

const MAX_VERSION_CHARS = 48;
const VERSION_TOKEN_RE = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z._-]+)?)\b/u;

function binaryStatSignature(filePath: string): string | null {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    return `${filePath}:${st.dev}:${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

export function parseCliVersionOutput(raw: string): string | null {
  const cleaned = stripAnsi(raw);
  for (const rawLine of cleaned.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = VERSION_TOKEN_RE.exec(line);
    if (match && match[1]) {
      return match[1].slice(0, MAX_VERSION_CHARS);
    }
    if (/^[0-9A-Za-z._-]+$/u.test(line)) {
      return line.slice(0, MAX_VERSION_CHARS);
    }
  }
  return null;
}

export interface VendorVersionCache {
  peek(vendor: AgentVendor, binaryPath: string | null): string | null;
  probe(
    vendor: AgentVendor,
    binaryPath: string | null,
    options: {
      args?: readonly string[];
      cwd: string;
      env?: Record<string, string | undefined>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<string | null>;
  invalidate(vendor?: AgentVendor): void;
  waitForIdle(): Promise<void>;
}

export function createVendorVersionCache(): VendorVersionCache {
  const cache = new LRUCache<AgentVendor, VersionCacheEntry>({ max: AGENT_VENDORS.length });
  const inflight = new Map<AgentVendor, { binarySig: string; task: Promise<string | null> }>();

  const probe: VendorVersionCache["probe"] = async (vendor, binaryPath, options) => {
    const sig = binaryPath === null ? null : binaryStatSignature(binaryPath);
    if (!binaryPath || sig === null) {
      cache.delete(vendor);
      return null;
    }
    if (options.signal?.aborted) return null;
    const existing = cache.get(vendor);
    if (existing?.binarySig === sig) return existing.version;
    const running = inflight.get(vendor);
    if (running) {
      if (running.binarySig === sig) return running.task;
      await running.task;
      return probe(vendor, binaryPath, options);
    }

    const task = runShortSubcommand(binaryPath, options.args ?? ["--version"], {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? PROVIDER_VERSION_PROBE_TIMEOUT_MS,
      signal: options.signal,
      purpose: `probe:version:${vendor}`,
    }).then(
      ({ code, stdout, stderr }) => code === 0 ? parseCliVersionOutput(`${stdout}\n${stderr}`) : null,
      () => null,
    ).then((version) => {
      if (options.signal?.aborted || binaryStatSignature(binaryPath) !== sig) return null;
      cache.set(vendor, { binarySig: sig, version }, { ttl: version === null ? PROVIDER_VERSION_PROBE_RETRY_MS : 0 });
      return version;
    }).finally(() => inflight.delete(vendor));
    inflight.set(vendor, { binarySig: sig, task });
    return task;
  };

  return {
    probe,
    async waitForIdle() {
      await Promise.allSettled([...inflight.values()].map(({ task }) => task));
    },
    peek(vendor, binaryPath) {
      if (!binaryPath) return null;
      const entry = cache.get(vendor);
      if (!entry) return null;
      const sig = binaryStatSignature(binaryPath);
      if (sig !== entry.binarySig) {
        cache.delete(vendor);
        return null;
      }
      return entry.version;
    },

    invalidate(vendor) {
      if (vendor === undefined) {
        cache.clear();
        return;
      }
      cache.delete(vendor);
    },
  };
}

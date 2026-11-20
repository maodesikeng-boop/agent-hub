import { statSync } from "node:fs";
import { LRUCache } from "lru-cache";
import {
  AGENT_VENDORS,
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
    return `${filePath}:${Math.trunc(st.mtimeMs)}:${st.size}`;
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
}

export function createVendorVersionCache(): VendorVersionCache {
  const cache = new LRUCache<AgentVendor, VersionCacheEntry>({ max: AGENT_VENDORS.length });
  const inflight = new Map<AgentVendor, Promise<string | null>>();

  return {
    peek(vendor, binaryPath) {
      if (!binaryPath) return null;
      const entry = cache.get(vendor);
      if (!entry) return null;
      const sig = binaryStatSignature(binaryPath);
      if (sig === null) {
        cache.delete(vendor);
        return null;
      }
      if (sig !== entry.binarySig) {
        cache.delete(vendor);
        return null;
      }
      return entry.version;
    },

    async probe(vendor, binaryPath, options) {
      if (!binaryPath) {
        cache.delete(vendor);
        return null;
      }
      const sig = binaryStatSignature(binaryPath);
      if (sig !== null) {
        const existing = cache.get(vendor);
        if (existing && existing.binarySig === sig) {
          return existing.version;
        }
      }
      const running = inflight.get(vendor);
      if (running) return running;

      const task = (async () => {
        try {
          const res = await runShortSubcommand(binaryPath, options.args ?? ["--version"], {
            cwd: options.cwd,
            env: options.env,
            timeoutMs: options.timeoutMs ?? PROVIDER_VERSION_PROBE_TIMEOUT_MS,
            signal: options.signal,
            purpose: `probe:version:${vendor}`,
          });
          const version = res.code === 0 ? parseCliVersionOutput(`${res.stdout}\n${res.stderr}`) : null;
          const freshSig = binaryStatSignature(binaryPath) ?? `cmd:${binaryPath}`;
          if (version !== null) {
            cache.set(vendor, { binarySig: freshSig, version });
          }
          return version;
        } catch {
          return null;
        } finally {
          inflight.delete(vendor);
        }
      })();
      inflight.set(vendor, task);
      return task;
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

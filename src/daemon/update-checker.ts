import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LRUCache } from "lru-cache";
import { z } from "zod";
import {
  ENV_UPDATE_INSTALL_KIND,
  ENV_UPDATE_RELEASE_URL,
  LATEST_RELEASE_API_URL,
  PRODUCT_NAME,
  RELEASES_PAGE_URL,
  UPDATE_CHECK_RETRY_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_CHECK_TTL_MS,
  UPDATE_RELEASE_MAX_ASSETS,
  UPDATE_RELEASE_MAX_BYTES,
  UPDATE_STATUS_CACHE_MAX,
  evaluateRelease,
  platformTargetOf,
  type InstallKind,
  type LatestRelease,
  type PlatformTarget,
  type UpdateBase,
  type UpdateStatus,
} from "../shared/index.ts";

export interface UpdateCheckerOptions {
  currentVersion: string;
  installKind: InstallKind;
  platformTarget: PlatformTarget;
  releaseApiUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface UpdateChecker {
  get(): Promise<UpdateStatus>;
  check(): Promise<UpdateStatus>;
  close(): void;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const httpsUrl = z.url({ protocol: /^https$/ });

const releaseSchema = z.object({
  tag_name: z.string().max(128),
  html_url: httpsUrl,
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().max(64).nullable(),
  assets: z.array(z.object({ name: z.string().max(256), browser_download_url: httpsUrl })).max(UPDATE_RELEASE_MAX_ASSETS),
});

function readPackageVersion(packageRoot: string): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

export function installKindOf(packageRoot: string, override: string | undefined): InstallKind {
  if (override === "bundled" || override === "source") return override;
  return existsSync(join(packageRoot, ".git")) ? "source" : "bundled";
}

// The override exists for offline tests, so it only accepts plain-HTTP loopback servers.
export function releaseApiUrlOf(override: string | undefined): string {
  if (override === undefined || !URL.canParse(override)) return LATEST_RELEASE_API_URL;
  const url = new URL(override);
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) ? url.href : LATEST_RELEASE_API_URL;
}

export function updateCheckerOptionsFor(input: { packageRoot: string; env: Record<string, string | undefined>; platform?: string; arch?: string }): UpdateCheckerOptions {
  return {
    currentVersion: readPackageVersion(input.packageRoot),
    installKind: installKindOf(input.packageRoot, input.env[ENV_UPDATE_INSTALL_KIND]),
    platformTarget: platformTargetOf(input.platform ?? process.platform, input.arch ?? process.arch),
    releaseApiUrl: releaseApiUrlOf(input.env[ENV_UPDATE_RELEASE_URL]),
  };
}

export function parseLatestRelease(text: string): LatestRelease | null {
  if (text.length > UPDATE_RELEASE_MAX_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = releaseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const release = parsed.data;
  return {
    tagName: release.tag_name,
    htmlUrl: release.html_url,
    draft: release.draft,
    prerelease: release.prerelease,
    publishedAt: release.published_at,
    assets: release.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url })),
  };
}

async function fetchLatestRelease(options: UpdateCheckerOptions, signal: AbortSignal): Promise<LatestRelease | null> {
  const res = await (options.fetch ?? fetch)(options.releaseApiUrl, {
    headers: { accept: "application/vnd.github+json", "user-agent": `${PRODUCT_NAME}/${options.currentVersion}` },
    signal,
  });
  if (!res.ok || Number(res.headers.get("content-length") ?? 0) > UPDATE_RELEASE_MAX_BYTES) {
    await res.body?.cancel();
    return null;
  }
  return parseLatestRelease(await res.text());
}

async function runCheck(options: UpdateCheckerOptions, lifetime: AbortSignal, now: () => number): Promise<UpdateStatus> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS);
  const release = await fetchLatestRelease(options, AbortSignal.any([lifetime, timeout])).catch(() => null);
  const base: UpdateBase = {
    currentVersion: options.currentVersion,
    installKind: options.installKind,
    platformTarget: options.platformTarget,
    releaseUrl: RELEASES_PAGE_URL,
    checkedAt: now(),
  };
  return release === null ? { ...base, status: "unavailable" } : evaluateRelease(base, release);
}

export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const now = options.now ?? Date.now;
  const cache = new LRUCache<"status", { value: UpdateStatus; expiresAt: number }>({ max: UPDATE_STATUS_CACHE_MAX });
  const lifetime = new AbortController();
  let inflight: Promise<UpdateStatus> | null = null;
  const refresh = (): Promise<UpdateStatus> => {
    inflight ??= runCheck(options, lifetime.signal, now).then((value) => {
      inflight = null;
      const ttl = value.status === "unavailable" ? UPDATE_CHECK_RETRY_MS : UPDATE_CHECK_TTL_MS;
      if (!lifetime.signal.aborted) cache.set("status", { value, expiresAt: value.checkedAt + ttl });
      return value;
    });
    return inflight;
  };
  return {
    get() {
      const hit = cache.get("status");
      return hit !== undefined && now() < hit.expiresAt ? Promise.resolve(hit.value) : refresh();
    },
    check: refresh,
    close() {
      lifetime.abort();
      cache.clear();
    },
  };
}

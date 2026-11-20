import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENV_UPDATE_INSTALL_KIND,
  ENV_UPDATE_RELEASE_URL,
  LATEST_RELEASE_API_URL,
  UPDATE_CHECK_RETRY_MS,
  UPDATE_CHECK_TTL_MS,
  UPDATE_RELEASE_MAX_BYTES,
} from "../shared/index.ts";
import { createUpdateChecker, installKindOf, parseLatestRelease, releaseApiUrlOf, updateCheckerOptionsFor, type UpdateCheckerOptions } from "./update-checker.ts";

const DOWNLOAD = "https://github.com/maodesikeng-boop/agent-hub/releases/download/v0.3.0";

function githubRelease(overrides: Record<string, unknown> = {}) {
  const asset = (name: string) => ({ name, browser_download_url: `${DOWNLOAD}/${name}`, size: 1, uploader: { login: "bot" } });
  return {
    url: "https://api.github.com/repos/maodesikeng-boop/agent-hub/releases/1",
    tag_name: "v0.3.0",
    name: "Bellwood v0.3.0",
    html_url: "https://github.com/maodesikeng-boop/agent-hub/releases/tag/v0.3.0",
    draft: false,
    prerelease: false,
    published_at: "2026-11-20T08:00:00Z",
    body: "notes",
    assets: ["Bellwood-macos-arm64.dmg", "Bellwood-macos-arm64.dmg.sha256", "Bellwood-windows-x64-setup.exe", "Bellwood-windows-x64-setup.exe.sha256"].map(asset),
    ...overrides,
  };
}

function options(fetchImpl: typeof fetch, clock: { t: number }, overrides: Partial<UpdateCheckerOptions> = {}): UpdateCheckerOptions {
  return {
    currentVersion: "0.2.0",
    installKind: "bundled",
    platformTarget: "macos-arm64",
    releaseApiUrl: "http://127.0.0.1:9/releases/latest",
    fetch: fetchImpl,
    now: () => clock.t,
    ...overrides,
  };
}

const okFetch = () => vi.fn<typeof fetch>(async () => Response.json(githubRelease()));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseLatestRelease", () => {
  it("keeps the fields the checker needs from a GitHub release payload", () => {
    expect(parseLatestRelease(JSON.stringify(githubRelease()))).toEqual({
      tagName: "v0.3.0",
      htmlUrl: "https://github.com/maodesikeng-boop/agent-hub/releases/tag/v0.3.0",
      draft: false,
      prerelease: false,
      publishedAt: "2026-11-20T08:00:00Z",
      assets: expect.arrayContaining([{ name: "Bellwood-macos-arm64.dmg", url: `${DOWNLOAD}/Bellwood-macos-arm64.dmg` }]),
    });
  });

  it("rejects malformed JSON, missing fields, non-https links, too many assets, and oversized bodies", () => {
    expect(parseLatestRelease("{")).toBeNull();
    expect(parseLatestRelease(JSON.stringify({ tag_name: "v0.3.0" }))).toBeNull();
    expect(parseLatestRelease(JSON.stringify(githubRelease({ html_url: "javascript:alert(1)" })))).toBeNull();
    const evil = githubRelease({ assets: [{ name: "Bellwood-macos-arm64.dmg", browser_download_url: "http://example.com/x.dmg" }] });
    expect(parseLatestRelease(JSON.stringify(evil))).toBeNull();
    const many = githubRelease({ assets: Array.from({ length: 101 }, (_, i) => ({ name: `a${i}`, browser_download_url: `${DOWNLOAD}/a${i}` })) });
    expect(parseLatestRelease(JSON.stringify(many))).toBeNull();
    expect(parseLatestRelease(JSON.stringify(githubRelease({ body: "x".repeat(UPDATE_RELEASE_MAX_BYTES) })))).toBeNull();
  });
});

describe("update checker options", () => {
  it("reads the version from package.json and treats a checkout with .git as a source install", () => {
    const root = mkdtempSync(join(tmpdir(), "hub-update-"));
    dirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fusa-daemon-runtime", version: "0.2.0" }));
    const env = {};
    expect(updateCheckerOptionsFor({ packageRoot: root, env, platform: "win32", arch: "x64" })).toEqual({
      currentVersion: "0.2.0",
      installKind: "bundled",
      platformTarget: "windows-x64",
      releaseApiUrl: LATEST_RELEASE_API_URL,
    });
    mkdirSync(join(root, ".git"));
    expect(installKindOf(root, undefined)).toBe("source");
    expect(installKindOf(root, "bundled")).toBe("bundled");
    expect(updateCheckerOptionsFor({ packageRoot: root, env: { [ENV_UPDATE_INSTALL_KIND]: "bundled", [ENV_UPDATE_RELEASE_URL]: "http://127.0.0.1:7/r" } })).toMatchObject({
      installKind: "bundled",
      releaseApiUrl: "http://127.0.0.1:7/r",
    });
  });

  it("accepts a release URL override only for plain-HTTP loopback servers", () => {
    expect(releaseApiUrlOf("http://localhost:8123/latest")).toBe("http://localhost:8123/latest");
    for (const rejected of [undefined, "", "not a url", "https://127.0.0.1/latest", "http://example.com/latest", "http://10.0.0.2/latest"]) {
      expect(releaseApiUrlOf(rejected), String(rejected)).toBe(LATEST_RELEASE_API_URL);
    }
  });
});

describe("createUpdateChecker", () => {
  it("serves a successful check from cache for an hour and sends a generic user agent", async () => {
    const clock = { t: 1_000 };
    const fetchImpl = okFetch();
    const checker = createUpdateChecker(options(fetchImpl, clock));
    const first = await checker.get();
    expect(first).toMatchObject({ status: "update_available", latestVersion: "0.3.0", checkedAt: 1_000 });
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).get("user-agent")).toBe("Bellwood/0.2.0");
    clock.t += UPDATE_CHECK_TTL_MS - 1;
    expect(await checker.get()).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock.t += 1;
    await checker.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps failures and rate limits only for the short retry backoff", async () => {
    const clock = { t: 0 };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ message: "API rate limit exceeded" }, { status: 403 }));
    const checker = createUpdateChecker(options(fetchImpl, clock));
    expect(await checker.get()).toMatchObject({ status: "unavailable", releaseUrl: "https://github.com/maodesikeng-boop/agent-hub/releases" });
    clock.t += UPDATE_CHECK_RETRY_MS - 1;
    await checker.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock.t += 1;
    fetchImpl.mockImplementation(async () => Response.json(githubRelease()));
    expect((await checker.get()).status).toBe("update_available");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats network errors, timeouts, and oversized responses as unavailable", async () => {
    const clock = { t: 0 };
    const offline = createUpdateChecker(options(vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("fetch failed"))), clock));
    expect((await offline.get()).status).toBe("unavailable");
    const hanging = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))));
    expect((await createUpdateChecker(options(hanging, clock, { timeoutMs: 10 })).get()).status).toBe("unavailable");
    const huge = vi.fn<typeof fetch>(async () => new Response("{}", { headers: { "content-length": String(UPDATE_RELEASE_MAX_BYTES + 1) } }));
    expect((await createUpdateChecker(options(huge, clock)).get()).status).toBe("unavailable");
  });

  it("shares one request between concurrent callers and lets a manual check bypass the cache", async () => {
    const clock = { t: 0 };
    const fetchImpl = okFetch();
    const checker = createUpdateChecker(options(fetchImpl, clock));
    const [a, b] = await Promise.all([checker.get(), checker.check()]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock.t += 5;
    expect((await checker.check()).checkedAt).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborts the in-flight request on close and does not cache its result", async () => {
    const clock = { t: 0 };
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      signal = init!.signal!;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason)));
    });
    const checker = createUpdateChecker(options(fetchImpl, clock));
    const pending = checker.get();
    checker.close();
    expect(signal?.aborted).toBe(true);
    expect((await pending).status).toBe("unavailable");
  });
});

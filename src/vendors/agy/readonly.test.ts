// Outer OS sandbox parameters for read-only Antigravity Workers.
import { describe, expect, it } from "vitest";
import { buildReadonlyPolicy, type ReadonlyPolicy } from "../../shared/index.ts";
import { AGY_RUNTIME_DIRS, READONLY_CACHE_DIRS, agyReadonlySandboxInput } from "./readonly.ts";

const policy = (connectors: Partial<ReadonlyPolicy["connectors"]> = {}): ReadonlyPolicy =>
  buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/Users/u/.agent-hub/state", connectors });

describe("agyReadonlySandboxInput", () => {
  it("keeps writable scope to tmpDir, agy runtime dirs/files, and caches while leaving Keychains readable", () => {
    const real = (p: string) => p.replace(/^\/tmp\//, "/private/tmp/");
    const input = agyReadonlySandboxInput({ homeDir: "/Users/u", tmpDir: "/tmp/ro-1", policy: policy(), realpath: real });
    expect(input.tmpDir).toBe("/private/tmp/ro-1");
    expect(input.writableDirs).toEqual([
      ...AGY_RUNTIME_DIRS.map((d) => `/Users/u/.gemini/antigravity-cli/${d}`),
      ...READONLY_CACHE_DIRS.map((d) => `/Users/u/${d}`),
    ]);
    expect(input.writableDirs).not.toContain("/Users/u/.gemini/antigravity-cli/bin");
    expect(input.writableDirs).not.toContain("/Users/u/.gemini/antigravity-cli/mcp");
    expect(input.writableFileGlobs).toContain("/Users/u/.gemini/antigravity-cli/bin/agentapi*");
    expect(input.writableFileGlobs).toContain("/Users/u/.gemini/antigravity-cli/mcp/*");
    expect(input.writableFileGlobs).toContain("/Users/u/.gemini/antigravity-cli/mcp/*/*");
    expect(input.writableFileRegexes).toContain("^/Users/u/\\.gemini/antigravity-cli/bin/agentapi[^/]*$");
    expect(input.writableFileRegexes).toContain("^/Users/u/\\.gemini/antigravity-cli/mcp/[^/]*$");
    expect(input.writableFileRegexes).toContain("^/Users/u/\\.gemini/antigravity-cli/mcp/[^/]*/[^/]*$");
    expect(input.writableFileRegexes.some((r) => r.includes("webm_encoder"))).toBe(false);
    expect(input.writableDirs).toContain("/Users/u/.cache");
    expect(input.writableDirs).toContain("/Users/u/Library/Caches");
    expect(input.writableDirs.some((d) => d.endsWith("/config") || d.endsWith("settings.json"))).toBe(false);
    expect(input.writableFileRegexes).toContain("^/Users/u/\\.gemini/antigravity-cli/conversation_summaries\\.db[^/]*$");
    expect(input.secretPaths).toContain("/Users/u/.ssh");
    expect(input.secretPaths).not.toContain("/Users/u/Library/Keychains");
    expect(input.secretPaths).toContain("/Users/u/.aws");
    expect(input.secretGlobs).toContain("**/.env");
  });
});

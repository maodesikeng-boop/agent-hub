import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModelCatalogs } from "../../daemon/driver/model-catalog.ts";
import { removeTreeWithRetry } from "../../daemon/platform/index.ts";
import { writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";
import { claudeCatalogProbe, createClaudeCatalogSource } from "./catalog.ts";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-catalog-test-")));
});

afterEach(async () => {
  await removeTreeWithRetry(dir);
});

function writeFakeClaude(options: {
  authStatusJson: Record<string, unknown>;
  authStatusExitCode?: number;
  authStatusMarkerPath: string;
}): string {
  return writeExecutableNodeScript(
    join(dir, "claude"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  fs.writeFileSync(${JSON.stringify(options.authStatusMarkerPath)}, "called");
  process.stdout.write(JSON.stringify(${JSON.stringify(options.authStatusJson)}) + "\\n");
  process.exit(${options.authStatusExitCode ?? 0});
}
readline.createInterface({ input: process.stdin }).once("line", (line) => {
  const req = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: req.request_id,
      response: {
        models: [{ value: "opus", displayName: "Opus 5.5" }],
        account: { email: "stale@example.com", organization: "Example Org" },
      },
    },
  }) + "\\n");
  process.exit(0);
});
`,
  );
}

describe("claudeCatalogProbe and createClaudeCatalogSource", () => {
  it("never marks initialize account metadata as available without verifying credentials", () => {
    expect(
      claudeCatalogProbe.availabilityOf({
        models: [{ value: "opus" }],
        account: { email: "stale@example.com", organization: "Example Org" },
      }),
    ).toBe("unknown");
    expect(claudeCatalogProbe.availabilityOf({ models: [], account: {} })).toBe("unknown");
    expect(claudeCatalogProbe.availabilityOf(null)).toBe("unknown");
  });

  it("reports signed_out when .claude.json and initialize carry email but claude auth status --json returns loggedIn: false", async () => {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "stale@example.com" } }),
    );
    const authMarker = join(dir, "auth-status-called");
    const claudePath = writeFakeClaude({
      authStatusJson: { loggedIn: false, authMethod: "none" },
      authStatusExitCode: 1,
      authStatusMarkerPath: authMarker,
    });

    const catalogs = createModelCatalogs({
      sources: {
        claude: createClaudeCatalogSource({
          path: claudePath,
          cwd: home,
          installed: () => true,
          env: { HOME: home, PATH: process.env.PATH ?? "" },
        }),
      },
      log: () => {},
    });

    try {
      const [claude] = await catalogs.list({ vendor: "claude" });
      expect(claude?.source).toBe("vendor");
      expect(claude?.availability).toBe("signed_out");
      expect(existsSync(authMarker)).toBe(true);
      expect(readFileSync(authMarker, "utf8")).toBe("called");
    } finally {
      await catalogs.close();
    }
  });

  it("reports available when claude auth status --json returns loggedIn: true", async () => {
    const authMarker = join(dir, "auth-status-called");
    const claudePath = writeFakeClaude({
      authStatusJson: { loggedIn: true, authMethod: "claude.ai" },
      authStatusMarkerPath: authMarker,
    });

    const catalogs = createModelCatalogs({
      sources: {
        claude: createClaudeCatalogSource({
          path: claudePath,
          cwd: dir,
          installed: () => true,
          env: { HOME: dir, PATH: process.env.PATH ?? "" },
        }),
      },
      log: () => {},
    });

    try {
      const [claude] = await catalogs.list({ vendor: "claude" });
      expect(claude?.availability).toBe("available");
      expect(existsSync(authMarker)).toBe(true);
    } finally {
      await catalogs.close();
    }
  });

  it("skips claude auth status --json and reports available when managed key env vars are configured", async () => {
    for (const envEntry of [
      { ANTHROPIC_API_KEY: "sk-ant-managed-key" },
      { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-managed-token" },
    ]) {
      const authMarker = join(dir, `auth-status-${Object.keys(envEntry)[0]}`);
      const claudePath = writeFakeClaude({
        authStatusJson: { loggedIn: false, authMethod: "none" },
        authStatusMarkerPath: authMarker,
      });

      const catalogs = createModelCatalogs({
        sources: {
          claude: createClaudeCatalogSource({
            path: claudePath,
            cwd: dir,
            installed: () => true,
            env: { HOME: dir, PATH: process.env.PATH ?? "", ...envEntry },
          }),
        },
        log: () => {},
      });

      try {
        const [claude] = await catalogs.list({ vendor: "claude" });
        expect(claude?.availability).toBe("available");
        expect(existsSync(authMarker)).toBe(false);
      } finally {
        await catalogs.close();
      }
    }
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import { removeTreeWithRetry } from "../platform/index.ts";
import { createManagedProviderSecrets, createVendorRuntimeResolver } from "../provider-manager/index.ts";
import { createProviderQuota } from "./provider-quota.ts";

it("reads all three current accounts through their CLIs before any session exists", async () => {
  const home = mkdtempSync(join(tmpdir(), "provider-quota-"));
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const iso = new Date(reset * 1000).toISOString();
  const codexAuth = join(home, ".codex", "auth.json");
  mkdirSync(join(home, ".codex"));
  writeFileSync(codexAuth, JSON.stringify({ account: "weekly" }));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "example" } }));
  const code = (name: string, source: string) => writeExecutableNodeScript(join(home, name), source);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: home,
    AGENT_HUB_HOME: join(home, "hub"),
    AGENT_HUB_CODEX: code("codex", `
const rl = require("node:readline").createInterface({ input: process.stdin });
const reply = (id, result) => console.log(JSON.stringify({ id, result }));
rl.on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") reply(id, {});
  else if (method === "account/rateLimits/read") {
    const auth = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(codexAuth)}, "utf8"));
    const windowDurationMins = auth.account === "weekly" ? 10080 : 300;
    reply(id, { rateLimits: { limitId: "codex", primary: { usedPercent: 0, windowDurationMins, resetsAt: ${reset} }, secondary: null } });
  } else if (method !== "initialized") process.exit(1);
});
`),
    AGENT_HUB_CLAUDE: code("claude", `
const rl = require("node:readline").createInterface({ input: process.stdin });
let initialized = false;
rl.on("line", (line) => {
  const { request_id, request } = JSON.parse(line);
  let response = {};
  if (request.subtype === "initialize") {
    initialized = true;
    require("node:fs").writeFileSync(${JSON.stringify(join(home, ".claude.json"))}, JSON.stringify({ numStartups: 9, oauthAccount: { accountUuid: "example" } }));
  } else if (initialized && request.subtype === "get_usage") {
    response = { rate_limits_available: true, rate_limits: { five_hour: { utilization: 43, resets_at: ${JSON.stringify(iso)} }, seven_day: null } };
  } else process.exit(1);
  console.log(JSON.stringify({ type: "control_response", response: { request_id, subtype: "success", response } }));
});
`),
    AGENT_HUB_AGY: code("agy", `
if (process.argv.slice(2).join(" ") !== "-p /usage") process.exit(1);
console.log("Gemini Models\\tWeekly Limit Remaining\\t75%\\t${iso}");
`),
  };
  const paths = resolveHubPaths(env, home, { platform: process.platform });
  const runtime = createVendorRuntimeResolver({
    paths, userHome: home, baseEnv: env, secrets: createManagedProviderSecrets(paths.providerSecretsFile),
  });
  const service = createProviderQuota(runtime);
  try {
    const { groups } = await service.get();
    expect(groups).toEqual(expect.arrayContaining([
      { id: "codex", vendor: "codex", windows: { seven_day: { utilization: 0, resetsAt: reset, status: "allowed" } } },
      { id: "claude", vendor: "claude", windows: { five_hour: { utilization: 0.43, resetsAt: reset, status: "allowed" } } },
      { id: "gemini", vendor: "agy", windows: { seven_day: { utilization: 0.25, resetsAt: reset, status: "allowed" } } },
    ]));
    expect(groups).toHaveLength(3);

    writeFileSync(codexAuth, JSON.stringify({ account: "hourly" }));
    const updated = (await service.get()).groups.find((group) => group.vendor === "codex");
    expect(updated?.windows).toEqual({ five_hour: { utilization: 0, resetsAt: reset, status: "allowed" } });
  } finally {
    await service.close();
    await removeTreeWithRetry(home);
  }
});

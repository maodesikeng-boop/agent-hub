import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHubLedger } from "../../src/daemon/agent-api/fake-ledger.ts";
import { startAgentApi } from "../../src/daemon/agent-api/server.ts";
import { installHubShim } from "../../src/daemon/agent-api/shim.ts";
import { createSessionTokens } from "../../src/daemon/agent-api/tokens.ts";
import { removeTreeWithRetry } from "../../src/daemon/platform/index.ts";
import { HUB_USAGE } from "../../src/hub/usage.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN, POWERSHELL_UTF8_PIPE } from "../../src/shared/index.ts";
import { resolveHubPaths } from "../../src/shared/paths.ts";
import { writeDiagLog } from "./diag-helper.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function documentedPowerShellExample(): { script: string; body: string } {
  const lines = HUB_USAGE.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${POWERSHELL_UTF8_PIPE}; @'`));
  const end = lines.findIndex((line, i) => i > start && line.startsWith("'@ | "));
  expect(start, HUB_USAGE).toBeGreaterThanOrEqual(0);
  expect(end, HUB_USAGE).toBeGreaterThan(start);
  return { script: lines.slice(start, end + 1).join("\n"), body: lines.slice(start + 1, end).join("\n") };
}

async function startHub(): Promise<{ ledger: FakeHubLedger; env: NodeJS.ProcessEnv }> {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-ps51-")));
  cleanups.push(() => removeTreeWithRetry(dir));
  const paths = resolveHubPaths({}, dir);
  const ledger = new FakeHubLedger();
  const tokens = createSessionTokens();
  const api = await startAgentApi({ ledger, tokens, runDir: paths.runDir, hubSock: paths.hubSock });
  cleanups.push(() => api.close());
  installHubShim({ binDir: paths.hubBinDir });
  const env = {
    ...process.env,
    PATH: `${paths.hubBinDir};${process.env.PATH ?? process.env.Path ?? ""}`,
    [ENV_HUB_TOKEN]: tokens.issue(77),
    [ENV_HUB_SOCK]: api.socketPath,
  };
  return { ledger, env };
}

// powershell.exe is the Windows PowerShell 5.1 every Windows install ships, unlike pwsh.exe (PowerShell 7).
// Async on purpose: the hub server runs in this process, so a sync spawn would block the reply hub.exe waits for.
function windowsPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      resolve({ status: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr });
    });
  });
}

function report(line: string): void {
  writeDiagLog("powershell-stdin", line);
  console.log(`[powershell-stdin] ${line}`);
}

const taskOf = (ledger: FakeHubLedger): string | undefined => (ledger.calls.at(-1)?.args as { task?: string } | undefined)?.task;

async function pipeIntoHub(ledger: FakeHubLedger, env: NodeJS.ProcessEnv, label: string, script: string) {
  ledger.calls.length = 0;
  const run = await windowsPowerShell(script, env);
  const task = taskOf(ledger);
  report(`${label}: exit=${run.status} stderr=${JSON.stringify(run.stderr.trim())} received=${JSON.stringify(task)}`);
  return { ...run, task };
}

describe.runIf(process.platform === "win32")("Windows PowerShell 5.1 pipes a here-string body into hub.exe", () => {
  it("the PowerShell example in hub help delivers Chinese text intact, and dropping its encoding line does not", { timeout: 60_000 }, async () => {
    const { ledger, env } = await startHub();
    const version = await windowsPowerShell("\"$($PSVersionTable.PSVersion) $($PSVersionTable.PSEdition) $($OutputEncoding.WebName)\"", env);
    report(`powershell.exe version, edition, default $OutputEncoding: ${version.stdout.trim()}`);
    const { script, body } = documentedPowerShellExample();
    const multiline = "第一行 & | %PATH% \"引号\" 🚀\n第二行末尾";

    const documented = await pipeIntoHub(ledger, env, "help example", script);
    const withEmoji = await pipeIntoHub(ledger, env, "help example, multi-line body with emoji", script.replace(body, multiline));
    const withoutEncoding = await pipeIntoHub(ledger, env, "help example without the encoding line", script.replace(`${POWERSHELL_UTF8_PIPE}; `, ""));

    expect(version.stdout.trim()).toMatch(/^5\.1\.\S+ Desktop /u);
    expect(body).toMatch(/[\u3400-\u9fff]/u);
    expect(documented.status, documented.stderr).toBe(0);
    expect(documented.task).toBe(body);
    expect(withEmoji.status, withEmoji.stderr).toBe(0);
    expect(withEmoji.task).toBe(multiline);
    expect(withoutEncoding.task).not.toBe(body);
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { startAgentApi } from "../daemon/agent-api/server.ts";
import { createSessionTokens } from "../daemon/agent-api/tokens.ts";
import { createLedger } from "../daemon/ledger/index.ts";
import { openTestDb } from "../daemon/store/test-helpers.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../shared/hub.ts";
import { personaFilePath, pmMemoryIndexPath, resolveHubPaths } from "../shared/paths.ts";
import { runHub } from "./cli.ts";

async function personaFixture(text: string) {
  const dir = mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "ah-persona-"));
  const paths = resolveHubPaths({}, dir, { home: dir, platform: process.platform });
  const db = openTestDb();
  const ledger = createLedger(db, {
    pmHomeRoot: paths.pmHomeDir, personasDir: paths.personasDir, pmMemoryDir: paths.pmMemoryDir, dataHome: dir, userHome: dir,
  });
  let closeApi: (() => Promise<void>) | undefined;
  const close = async () => {
    await closeApi?.();
    ledger.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const { pm, sessionId } = ledger.createPm({ name: "PM", mode: "manage_only", persona: text });
    const tokens = createSessionTokens();
    const running = await startAgentApi({ ledger, tokens, runDir: paths.runDir, hubSock: paths.hubSock });
    closeApi = () => running.close();
    const env = { [ENV_HUB_TOKEN]: tokens.issue(sessionId), [ENV_HUB_SOCK]: running.socketPath };
    const hub = async (argv: string[], stdin?: string) => {
      let stdout = "";
      let stderr = "";
      const code = await runHub({
        argv, env, cwd: dir,
        stdin: () => Readable.from([Buffer.from(stdin ?? "", "utf8")]),
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      expect(code, stderr).toBe(0);
      return stdout;
    };
    return {
      close, hub,
      persona: () => ledger.getPersona(pm.id),
      personaFile: () => readFileSync(personaFilePath(paths.personasDir, pm.id), "utf8"),
      memoryIndex: () => readFileSync(pmMemoryIndexPath(paths.pmMemoryDir, pm.id), "utf8"),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

it("writes back repeated show edits without adding mode headers or dropping body text", async () => {
  const heading = "模式：只管理\n\nMode: Hands on\n模式：自己也干活\n";
  const fixture = await personaFixture(`${heading}Original note\r\n`);
  try {
    for (const { before, after } of [
      { before: "Original note", after: "Original note\nAdded note" },
      { before: "Original note\nAdded note", after: "Added note" },
      { before: "Added note", after: "Updated note" },
    ]) {
      const shown = await fixture.hub(["persona", "show"]);
      await fixture.hub(["persona", "edit", "--stdin"], shown.replace(before, after));
      expect.soft(fixture.persona()).toMatchObject({ text: `${heading}${after}\r\n`, mode: "manage_only" });
    }
    expect.soft(fixture.personaFile()).toBe(`${heading}Updated note\r\n`);
    expect.soft(fixture.memoryIndex()).toBe(`${heading}Updated note\r\n`);
  } finally {
    await fixture.close();
  }
});

it("lets a PM remove existing legacy headers and change mode in the same edit", async () => {
  const legacy = "模式：只管理\n\n模式：自己也干活\n\n模式：只管理\n\n";
  const body = "Mode: Manage only\n\nKeep the example below.\n模式：自己也干活";
  const fixture = await personaFixture(legacy + body);
  try {
    const shown = await fixture.hub(["persona", "show"]);
    await fixture.hub(["persona", "edit", "--stdin", "--mode", "hands_on"], shown.replace(legacy, ""));
    expect.soft(fixture.persona()).toMatchObject({ text: body, mode: "hands_on" });
    expect.soft(await fixture.hub(["status"])).toContain("自己也干活");

    const shownAgain = await fixture.hub(["persona", "show"]);
    await fixture.hub(["persona", "edit", "--stdin"], shownAgain);
    expect.soft(fixture.persona()).toMatchObject({ text: body, mode: "hands_on", changes: [{ textBefore: legacy + body, textAfter: body }] });
    expect.soft(fixture.memoryIndex()).toBe(body);
  } finally {
    await fixture.close();
  }
});

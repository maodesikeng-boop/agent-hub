import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_VENDORS, type AgentSessionRow } from "../../shared/index.ts";
import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import { makeHarness, type Harness } from "../driver/test-helpers.ts";
import { createLaunchPreparer } from "../launch.ts";
import { createLedger } from "../ledger/index.ts";
import { getAgentSession } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createCapabilityInventory } from "./inventory.ts";

let dir: string;
let db: ReturnType<typeof openTestDb>;
let ledger: ReturnType<typeof createLedger>;
let prepareLaunch: ReturnType<typeof createLaunchPreparer>;
let session: AgentSessionRow;
let harness: Harness | undefined;
const user = (id: number) => ({ messageIds: [id], source: "user" as const, text: `Message ${id}` });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "capability-refresh-")));
  db = openTestDb();
  const dataHome = join(dir, "data");
  ledger = createLedger(db, { pmHomeRoot: join(dataHome, "pm"), userHome: dir, osSandboxed: () => true });
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  const { sessionId } = ledger.createPm({ name: "PM", persona: "", mode: "manage_only", vendor: "claude", folder: projectDir });
  session = getAgentSession(db, sessionId)!;
  const launchDir = join(dataHome, "launch");
  prepareLaunch = createLaunchPreparer({
    launchDir,
    dataDir: dataHome,
    stateDir: join(dataHome, "state"),
    homeDir: dir,
    osSandboxed: true,
    worktreesDir: join(dataHome, "worktrees"),
    getLaunchContext: (id) => ledger.getLaunchContext(id),
    tokens: { issue: () => "test-token" },
    hubSock: join(dir, "hub.sock"),
    hubBinDir: join(dir, "bin"),
    capabilityPolicies: ledger,
    capabilityInventory: createCapabilityInventory({ ctx: { userHome: dir, env: {} } }),
    sessionTmp: { allocate: (id) => join(dir, "tmp", String(id)) },
    prepareOsSandbox: async () => {},
  });
});

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  ledger.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function addMcp(vendor: (typeof AGENT_VENDORS)[number]): string {
  const { configPath, nextContent } = VENDOR_DAEMONS[vendor].sync!.planMcpPatch(
    { userHome: dir, env: {} },
    { upsert: { calendar: { transport: "stdio", command: "echo", args: [], env: {} } }, removeNames: new Set() },
  );
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, nextContent!);
  return configPath;
}

describe("capability refresh in existing sessions", () => {
  it("resumes a live PM with an externally added MCP before delivering the next message", async () => {
    harness = makeHarness({ dir, driver: { prepareLaunch } });
    harness.store.add(session);
    await harness.driver.send(session.id, user(1));
    await harness.waitFor("turn.ended");
    expect(harness.driver.isRunning(session.id)).toBe(true);

    addMcp("claude");
    await harness.driver.send(session.id, user(2));
    await harness.waitFor("turn.ended", () => true, 2);
    expect(harness.argvs()).toHaveLength(2);
    expect(harness.argvs()[1]).toContain("--resume");
    expect(harness.of("turn.ended").map((turn) => turn.messageIds)).toEqual([[1], [2]]);
  });

  it("applies Project defaults before handing a new message to a busy PM", async () => {
    const go = join(dir, "go");
    addMcp("claude");
    harness = makeHarness({
      dir,
      script: {
        capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"],
        turns: [{ steps: [{ text: "Started" }, { waitFile: go }] }],
      },
      driver: { prepareLaunch },
    });
    harness.store.add(session);
    await harness.driver.send(session.id, user(1));
    await harness.waitFor("agent.text");

    ledger.patchCapabilities({ kind: "default" }, { set: { "mcp:calendar": false } });
    await expect(harness.driver.send(session.id, user(2))).resolves.toEqual({ kind: "queued" });
    await expect(harness.driver.send(session.id, user(3))).resolves.toEqual({ kind: "queued" });
    expect(harness.of("message.delivered").map((event) => event.messageIds)).toEqual([[1]]);

    writeFileSync(go, "");
    await harness.waitFor("turn.ended", () => true, 2);
    expect(harness.argvs()).toHaveLength(2);
    expect(harness.argvs()[1]).toContain("--resume");
    expect(JSON.parse(readFileSync(join(dir, "data", "launch", String(session.id), "settings.json"), "utf8")))
      .toMatchObject({ deniedMcpServers: [{ serverName: "calendar" }] });
    expect(harness.of("turn.ended").map((turn) => turn.messageIds)).toEqual([[1], [2, 3]]);
  });

  it.each(AGENT_VENDORS)("tracks MCP and skill additions and removals for %s PMs and Workers", async (vendor) => {
    const pm = { ...session, vendor };
    const started = ledger.hubCall(session.id, "worker.start", { title: "Worker", task: "List events", noWorktree: true });
    const workerId = started.data.worker.id;
    const workerSessionId = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", workerId)!.id;
    const worker = { ...getAgentSession(db, workerSessionId)!, vendor };
    const fingerprint = async () => [(await prepareLaunch(pm)).fingerprint, (await prepareLaunch(worker)).fingerprint];
    const before = await fingerprint();
    const mcp = addMcp(vendor);
    const withMcp = await fingerprint();
    for (const [index, hash] of withMcp.entries()) expect(hash).not.toBe(before[index]);
    expect(await fingerprint()).toEqual(withMcp);
    rmSync(mcp);
    expect(await fingerprint()).toEqual(before);

    const target = VENDOR_DAEMONS[vendor].sync!.skillTarget({ userHome: dir, env: {} }, { kind: "global" });
    const skill = join(target.mode === "native" ? join(dir, ".agents", "skills") : target.targetDir, "calendar");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: calendar\ndescription: List events\n---\n");
    const withSkill = await fingerprint();
    for (const [index, hash] of withSkill.entries()) expect(hash).not.toBe(before[index]);
    rmSync(skill, { recursive: true });
    expect(await fingerprint()).toEqual(before);
  });
});

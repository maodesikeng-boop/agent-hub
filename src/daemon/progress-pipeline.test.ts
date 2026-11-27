import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { progressFrame, progressFrames, progressJsonLines } from "../../test/fixtures/progress/load.ts";
import { writeExecutableNodeScript } from "../../test/fake-cli-shim.ts";
import { API_PATHS, checklistOf, type AgentVendor, type DriverEvent, type MessagesPage, type WsServerMessage } from "../shared/index.ts";
import { VENDOR_LIST } from "../vendors/registry.ts";
import { createLedger } from "./ledger/index.ts";
import { createSessionStore } from "./store/index.ts";
import { openTestDb } from "./store/test-helpers.ts";
import { createUiServer } from "./ui-server/server.ts";
import { testLogin } from "./ui-server/test-login.ts";
import { DAEMON_VENDORS } from "./vendors/index.ts";

const acpTool = (sessionId: string, name: string) => ({
  jsonrpc: "2.0", method: "session/update",
  params: {
    sessionId,
    update: { sessionUpdate: "tool_call", toolCallId: "read-probe", title: name, kind: "read", status: "in_progress", rawInput: { path: "probe.txt" } },
  },
});

interface ReplayCase {
  frames: unknown[];
  snapshots: { id?: string; title: string; status: string }[][];
  action: "text" | "tool_use";
  startedAt?: number;
  pending?: true;
}

const probeList = [{ title: "Read probe", status: "in_progress" }, { title: "Confirm marker", status: "pending" }];
const completedProbe = probeList.map((item) => ({ ...item, status: "completed" }));
const cursorFrames = progressFrames<{
  method: string;
  params: { todos?: { id: string; content: string; status: string }[] };
  jsonrpc: string;
}>("cursor-todo.live.jsonl");
const cursorFirst = cursorFrames.find((frame) => frame.method === "cursor/update_todos")!;
const cursorNotification = {
  jsonrpc: cursorFirst.jsonrpc,
  method: cursorFirst.method,
  params: { ...cursorFirst.params, todos: cursorFirst.params.todos?.map((todo) => ({ ...todo, status: "pending" })) },
};
const cases = {
  agy: {
    frames: [acpTool("illustrative-session", "read_file")],
    snapshots: [],
    action: "tool_use",
  },
  claude: {
    frames: progressFrames<unknown>("claude-task-tools.live.jsonl"),
    snapshots: [[{ title: "Read probe", id: "1", status: "pending" }], completedProbe],
    action: "tool_use",
  },
  codex: {
    frames: progressFrames<unknown>("codex-plan.live.jsonl"),
    snapshots: [[{ title: "Inspect marker", status: "in_progress" }], [{ title: "Report marker", status: "completed" }]],
    action: "text",
    startedAt: 1795596095584,
  },
  cursor: {
    frames: [cursorNotification, ...cursorFrames, ...progressFrames<unknown>("cursor-create-plan.live.jsonl")],
    snapshots: [probeList, completedProbe],
    action: "tool_use",
    pending: true,
  },
  deepseek: {
    frames: [progressFrame<unknown>("deepseek-todo.source-derived.json"), acpTool("illustrative-session", "read_file")],
    snapshots: [probeList],
    action: "tool_use",
  },
  kimi: {
    frames: [progressFrame<unknown>("kimi-plan.source-derived.json"), progressFrame<unknown>("kimi-tool.source-derived.json"), acpTool("illustrative-session", "ReadFile")],
    snapshots: [probeList],
    action: "tool_use",
  },
  opencode: {
    frames: progressFrames<unknown>("opencode-todo.live.jsonl"),
    snapshots: [probeList, completedProbe],
    action: "tool_use",
    pending: true,
  },
  pi: {
    frames: progressFrames<unknown>("pi-tools.live.jsonl"),
    snapshots: [],
    action: "tool_use",
  },
} satisfies Record<AgentVendor, ReplayCase>;

async function replayVendor(vendor: AgentVendor, fixture: ReplayCase, nextFrames?: unknown[]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bellwood-progress-")));
  const config = join(dir, "replay.json");
  const log = join(dir, "replay.jsonl");
  const promptFile = join(dir, "prompt.md");
  const spec = VENDOR_LIST.find((entry) => entry.id === vendor)!;
  writeFileSync(promptFile, "Check the probe.");
  writeFileSync(join(dir, "index.html"), "<title>Progress replay</title>");
  writeFileSync(config, JSON.stringify({ vendor, frames: fixture.frames, nextFrames, launchEnv: Object.keys(spec.checklist.enable?.env ?? {}) }));
  const executablePath = writeExecutableNodeScript(join(dir, "replay-cli"), readFileSync(new URL("../../test/fixtures/progress/replay-cli.cjs", import.meta.url), "utf8"));

  const db = openTestDb();
  const ledger = createLedger(db, { pmHomeRoot: dir, userHome: dir, initialSeq: 1 });
  const { sessionId, conversation } = ledger.createPm({ name: "Progress replay", mode: "hands_on", persona: "", vendor });
  const driver = DAEMON_VENDORS[vendor].createDriver({
    executablePath,
    store: createSessionStore(db),
    prepareLaunch: async () => ({
      promptFile, tmpDir: dir, fingerprint: "progress", env: { OPENCODE_FLAGS: "existing_flag" },
    }),
    env: { PROGRESS_REPLAY: config, PROGRESS_LOG: log },
    startTimeoutMs: 5_000,
  });
  const port = 4000;
  const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, cookie: testLogin(db, port).cookie() };
  const app = createUiServer({ ledger, token: "progress-replay-token-0123456789", staticDir: dir, uploadsDir: dir, sentFilesDir: dir, port, db });
  const events: DriverEvent[] = [];
  const unsubscribe = driver.onEvent((id, event) => {
    events.push(event);
    ledger.applyDriverEvent(id, event);
  });
  try {
    const received: WsServerMessage[] = [];
    await app.ready();
    const socket = await app.injectWS(API_PATHS.ws, { headers }, {
      onInit: (ws) => ws.on("message", (raw: Buffer) => received.push(JSON.parse(raw.toString("utf8")))),
    });
    try {
      for (let turn = 1; turn <= (nextFrames === undefined ? 1 : 2); turn++) {
        const text = `Check probe ${turn}.`;
        const { messageId } = ledger.postUserMessage({ conversationId: conversation.id, clientId: `probe-${turn}`, text });
        await expect(driver.send(sessionId, { source: "user", messageIds: [messageId], text })).resolves.toMatchObject({ kind: "written" });
        await vi.waitFor(() => expect(events.filter((event) => event.type === "turn.ended" && event.ok)).toHaveLength(turn));
        await ledger.settleDriverEvents();
      }
      const response = await app.inject({ url: `/api/conversations/${conversation.id}/messages?before=${Number.MAX_SAFE_INTEGER}`, headers });
      expect(response.statusCode).toBe(200);
      const page = response.json<MessagesPage>();
      const statuses = received.flatMap((event) => event.type === "session.status" ? [event.data.session] : []);
      return { page, statuses, events, childLog: progressJsonLines<unknown>(readFileSync(log, "utf8")) };
    } finally {
      socket.terminate();
    }
  } finally {
    unsubscribe();
    await driver.shutdown();
    await app.close();
    ledger.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("progress pipeline from vendor frames to the API", () => {
  for (const spec of VENDOR_LIST) {
    it(`${spec.id}: replays vendor frames into conversation messages and WebSocket status`, async () => {
      const fixture: ReplayCase = cases[spec.id];
      const { page, statuses, events, childLog } = await replayVendor(spec.id, fixture);
      const rows = page.messages.filter(({ kind }) => kind === "checklist");
      expect(rows.every(({ sender, collapsed, text }) => sender === "agent" && collapsed && text === "")).toBe(true);
      const snapshots = rows.map(checklistOf);
      expect(snapshots).not.toContain(null);
      if (fixture.snapshots.length === 0) expect(snapshots).toEqual([]);
      for (const snapshot of fixture.snapshots) {
        expect(snapshots).toContainEqual(expect.arrayContaining(snapshot.map((item) => expect.objectContaining(item))));
      }
      const tools = page.messages.filter(({ kind }) => kind === "tool");
      expect(tools.every((tool) => spec.tools?.actions[String(tool.meta?.name)] !== "todo")).toBe(true);
      if (fixture.action === "tool_use") expect(tools).toHaveLength(1);
      const toolId = tools[0]?.meta?.toolUseId;
      const starts = events.flatMap((event) => (
        (event.type === "agent.tool_running" || (event.type === "agent.tool" && !event.pending)) &&
        event.toolUseId === toolId ? [event.startedAt ?? event.at] : []
      ));
      const start = fixture.startedAt ?? starts[0];
      expect(start).toEqual(expect.any(Number));
      expect(statuses).toContainEqual(expect.objectContaining({ step: expect.objectContaining({ type: fixture.action }), stepStartedAt: start }));
      if (fixture.pending) expect(statuses).toContainEqual(expect.objectContaining({ step: expect.objectContaining({ type: "tool_use" }), stepStartedAt: null }));
      expect(statuses.at(-1)).toMatchObject({ activity: "idle", step: null, stepStartedAt: null });
      if (spec.checklist.enable?.args) expect(childLog[0]).toMatchObject({ argv: expect.arrayContaining([...spec.checklist.enable.args]) });
      for (const [name, setting] of Object.entries(spec.checklist.enable?.env ?? {})) {
        expect(childLog[0]).toMatchObject({ env: { [name]: typeof setting === "string" ? setting : `existing_flag,${setting.appendToList}` } });
      }
      if (spec.id === "cursor") {
        expect(childLog).toContainEqual({ reply: { jsonrpc: "2.0", id: 0, result: {} } });
        expect(childLog).toContainEqual({ reply: {
          jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "rejected", reason: "Interactive plan approval is disabled in unattended Bellwood sessions." } },
        } });
        expect(snapshots).toHaveLength(4);
        expect(snapshots[0]?.map((item) => item.status)).toEqual(["pending", "pending", "pending"]);
      }
    }, 10_000);
  }
});

describe("progress pipeline across two turns", () => {
  it.each(["claude", "codex", "cursor"] as const)("%s: recorded checklist frames keep only this turn's work", async (vendor) => {
    const frames = progressFrames<unknown>(`${vendor}-turn-1.live.jsonl`);
    const next = progressFrames<unknown>(`${vendor}-turn-2.live.jsonl`);
    const { page } = await replayVendor(vendor, { ...cases[vendor], frames }, next);
    const start = page.messages.findLastIndex((message) => message.sender === "user");
    expect(start).toBeGreaterThan(0);
    const steps = (messages: MessagesPage["messages"]) => {
      const latest = messages.findLast((message) => message.kind === "checklist");
      return latest && checklistOf(latest)?.map(({ title, status }) => [title, status]);
    };
    expect(steps(page.messages.slice(0, start))).toEqual(["Read marker", "Confirm marker", "Report marker"].map((title) => [title, "completed"]));
    expect(steps(page.messages.slice(start))).toEqual(["Check symbol", "Confirm symbol", "Report symbol"].map((title) => [title, "completed"]));
  }, 10_000);

  it("codex: a repeated checklist title remains visible after completion", async () => {
    const frames = progressFrames<unknown>("codex-repeat-1.live.jsonl");
    const next = progressFrames<unknown>("codex-repeat-2.live.jsonl");
    const { page } = await replayVendor("codex", { ...cases.codex, frames }, next);
    const start = page.messages.findLastIndex((message) => message.sender === "user");
    const snapshots = page.messages.slice(start).map(checklistOf).filter((items) => items !== null);
    expect(snapshots.map((items) => items.map(({ title, status }) => [title, status]))).toEqual([
      [["Run tests", "in_progress"], ["Review results", "pending"]],
      [["Run tests", "completed"], ["Review results", "completed"]],
    ]);
  }, 10_000);

  it.each(["opencode", "deepseek", "kimi"] as const)("%s: replays a second plan using the same wire format", async (vendor) => {
    const fixture = cases[vendor];
    const next: unknown[] = JSON.parse(JSON.stringify(fixture.frames)
      .replaceAll("Read probe", "Read next probe").replaceAll("Confirm marker", "Confirm next marker").replaceAll("Reply", "Report next probe")
      .replaceAll("illustrative-call", "next-call").replaceAll("read-probe", "read-next-probe"));
    const { page } = await replayVendor(vendor, fixture, next);
    const start = page.messages.findLastIndex((message) => message.sender === "user");
    expect(start).toBeGreaterThan(0);
    const final = page.messages.slice(start).findLast((message) => message.kind === "checklist");
    expect(final && checklistOf(final)?.map(({ title }) => title)).toEqual([
      "Read next probe", "Confirm next marker", ...(vendor === "opencode" ? ["Report next probe"] : []),
    ]);
  }, 10_000);

  it.each(["agy", "pi"] as const)("%s: two tool turns with no checklist events keep action timing only", async (vendor) => {
    const { page, statuses } = await replayVendor(vendor, cases[vendor], cases[vendor].frames);
    expect(page.messages.filter((message) => message.sender === "user")).toHaveLength(2);
    expect(page.messages.some((message) => message.kind === "checklist")).toBe(false);
    expect(statuses).toContainEqual(expect.objectContaining({ step: expect.objectContaining({ type: "tool_use" }), stepStartedAt: expect.any(Number) }));
  }, 10_000);
});

// 驱动层测试的共用零件：内存版 SessionStore、假 claude 的路径和记录、按事件等待。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSessionPatch,
  AgentSessionRow,
  DriverEvent,
  DriverOptions,
  SessionId,
  SessionStore,
} from "../../shared/index.ts";
import type { FakeLogEntry, FakeScript } from "../../../test/fake-claude/fake-claude.ts";
import { createClaudeDriver, type ClaudeDriver } from "./index.ts";

export const FAKE_CLAUDE = new URL("../../../test/fake-claude/fake-claude.ts", import.meta.url).pathname;

/** 在 vi.useFakeTimers 之前拿到的真计时器，测试里“真等一会儿”用。 */
const realSetTimeout = globalThis.setTimeout;
export const realSleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

export class MemorySessionStore implements SessionStore {
  readonly rows = new Map<SessionId, AgentSessionRow>();
  readonly patches: Array<{ id: SessionId; patch: AgentSessionPatch }> = [];

  add(row: AgentSessionRow): void {
    this.rows.set(row.id, row);
  }
  get(id: SessionId): AgentSessionRow | null {
    return this.rows.get(id) ?? null;
  }
  update(id: SessionId, patch: AgentSessionPatch): AgentSessionRow {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no session ${id}`);
    this.patches.push({ id, patch });
    const next = { ...row, ...patch, updatedAt: Date.now() };
    this.rows.set(id, next);
    return next;
  }
  listWithProcess(): AgentSessionRow[] {
    return [...this.rows.values()].filter((r) => r.pid !== null);
  }
}

export interface Harness {
  dir: string;
  store: MemorySessionStore;
  driver: ClaudeDriver;
  events: Array<{ sessionId: SessionId; event: DriverEvent }>;
  /** 等到满足条件的事件累计出现 count 次（含之前已经出过的）。 */
  waitFor<T extends DriverEvent["type"]>(
    type: T,
    pred?: (e: Extract<DriverEvent, { type: T }>) => boolean,
    count?: number,
  ): Promise<Extract<DriverEvent, { type: T }>>;
  of<T extends DriverEvent["type"]>(type: T): Array<Extract<DriverEvent, { type: T }>>;
  log(): FakeLogEntry[];
  /** 假 claude 收到的用户消息（只算 type=user 的行）里的文字。 */
  stdinTexts(): string[];
  argvs(): string[][];
  addSession(patch?: Partial<AgentSessionRow>): AgentSessionRow;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  script?: FakeScript;
  driver?: Partial<DriverOptions>;
  /** 换一个状态目录不共享（默认和日志在一起）。 */
  dir?: string;
}

let nextId = 1;

export function makeHarness(options: HarnessOptions = {}): Harness {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "agent-hub-driver-"));
  const logFile = join(dir, "fake-claude.log");
  const scriptFile = join(dir, "script.json");
  writeFileSync(scriptFile, JSON.stringify(options.script ?? {}));
  const store = new MemorySessionStore();
  const driver = createClaudeDriver({
    claudePath: FAKE_CLAUDE,
    sessionLogsDir: join(dir, "logs", "sessions"),
    store,
    prepareLaunch: async (session) => {
      const launch = join(dir, "launch", String(session.id));
      mkdirSync(launch, { recursive: true });
      writeFileSync(join(launch, "prompt.md"), "你是项目经理。");
      writeFileSync(join(launch, "mcp.json"), JSON.stringify({ mcpServers: {} }));
      return { promptFile: join(launch, "prompt.md"), mcpConfigFile: join(launch, "mcp.json"), env: {}, fingerprint: "" };
    },
    env: { FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_SCRIPT: scriptFile, FAKE_CLAUDE_STATE: dir },
    ...options.driver,
  });
  const events: Harness["events"] = [];
  const waiters: Array<() => void> = [];
  driver.onEvent((sessionId, event) => {
    events.push({ sessionId, event });
    for (const w of waiters.splice(0)) w();
  });

  const of = <T extends DriverEvent["type"]>(type: T) =>
    events.map((e) => e.event).filter((e): e is Extract<DriverEvent, { type: T }> => e.type === type);

  const waitFor: Harness["waitFor"] = (type, pred = () => true, count = 1) =>
    new Promise((resolve) => {
      const check = () => {
        const hits = of(type).filter(pred);
        if (hits.length >= count) resolve(hits[count - 1]!);
        else waiters.push(check);
      };
      check();
    });

  const log = () =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as FakeLogEntry)
      : [];

  const stdinTexts = () =>
    log().flatMap((e) => {
      if (e.kind !== "stdin") return [];
      const obj = JSON.parse(e.line) as { type: string; message?: { content: Array<{ text: string }> } };
      return obj.type === "user" ? [obj.message!.content.map((c) => c.text).join("")] : [];
    });

  const addSession = (patch: Partial<AgentSessionRow> = {}): AgentSessionRow => {
    const id = nextId++;
    const cwd = join(dir, "pm-home", String(id));
    mkdirSync(cwd, { recursive: true });
    const row: AgentSessionRow = {
      id,
      role: "pm",
      conversationId: id,
      pmId: null,
      ticketId: null,
      vendor: "claude",
      vendorSessionId: randomUUID(),
      cwd,
      addDirs: [],
      generation: 1,
      model: null,
      pid: null,
      status: "idle",
      hasCompletedTurn: false,
      lastEventAt: null,
      rateLimit: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...patch,
    };
    store.add(row);
    return row;
  };

  return {
    dir,
    store,
    driver,
    events,
    waitFor,
    of,
    log,
    stdinTexts,
    argvs: () => log().flatMap((e) => (e.kind === "argv" ? [e.argv] : [])),
    addSession,
    cleanup: async () => {
      await driver.shutdown();
      if (!options.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 一轮慢慢回：先等 ms 毫秒再回 text。 */
export const slowTurn = (ms: number, text = "done") => ({ steps: [{ sleepMs: ms }, { text }] });

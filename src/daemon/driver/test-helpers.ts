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
  LaunchFiles,
  SessionId,
  SessionStore,
} from "../../shared/index.ts";
import type { FakeLogEntry, FakeScript } from "../../../test/fake-claude/fake-claude.ts";
import { createClaudeDriver, type ClaudeDriver } from "./index.ts";

export const FAKE_CLAUDE = new URL("../../../test/fake-claude/fake-claude.ts", import.meta.url).pathname;

/** 在 vi.useFakeTimers 之前拿到的真计时器，测试里“真等一会儿”用。 */
const realSetTimeout = globalThis.setTimeout;
export const realSleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

/** 等条件满足（fn 返回非 undefined）再往下走；等的是进程起来、写日志这类事，机器忙时可能很慢，所以上限给足，超了抛错说清楚等的是什么。 */
export async function waitUntil<T>(what: string, fn: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  for (const deadline = Date.now() + timeoutMs; ; ) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await realSleep(25);
  }
}

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
  /** 只给测试用：像账本那样改驱动层不写的列（cwd、addDirs……），不记进 patches。 */
  set(id: SessionId, patch: Partial<AgentSessionRow>): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no session ${id}`);
    this.rows.set(id, { ...row, ...patch });
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
  /**
   * 默认的 prepareLaunch 每次返回什么（M2）：改这里就是“设置变了”。perSession 按会话覆盖。
   * settings 为 true 时多写一个 settings.json 并给 settingsFile。
   */
  launch: {
    fingerprint: string;
    env: Record<string, string>;
    settings: boolean;
    /** true：prepareLaunch 抛错。 */
    fail: boolean;
    perSession: Map<SessionId, { fingerprint?: string; env?: Record<string, string> }>;
  };
  /** prepareLaunch 被调了几次（按会话）。 */
  prepareCalls: Map<SessionId, number>;
  /** 某个会话的进程启动时记下的环境变量（按启动先后）。 */
  envs(sessionId?: SessionId): Array<Record<string, string>>;
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
  const launch: Harness["launch"] = { fingerprint: "", env: {}, settings: false, fail: false, perSession: new Map() };
  const prepareCalls = new Map<SessionId, number>();
  const driver = createClaudeDriver({
    claudePath: FAKE_CLAUDE,
    sessionLogsDir: join(dir, "logs", "sessions"),
    store,
    prepareLaunch: async (session) => {
      prepareCalls.set(session.id, (prepareCalls.get(session.id) ?? 0) + 1);
      if (launch.fail) throw new Error("prepareLaunch 坏了");
      const launchDir = join(dir, "launch", String(session.id));
      mkdirSync(launchDir, { recursive: true });
      writeFileSync(join(launchDir, "prompt.md"), "你是项目经理。");
      writeFileSync(join(launchDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
      const files: LaunchFiles = {
        promptFile: join(launchDir, "prompt.md"),
        mcpConfigFile: join(launchDir, "mcp.json"),
        env: { ...launch.env, ...launch.perSession.get(session.id)?.env },
        fingerprint: launch.perSession.get(session.id)?.fingerprint ?? launch.fingerprint,
      };
      if (launch.settings) {
        files.settingsFile = join(launchDir, "settings.json");
        writeFileSync(files.settingsFile, "{}");
      }
      return files;
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
      workerId: null,
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
    launch,
    prepareCalls,
    envs: (sessionId) => {
      const entries = log();
      return entries.flatMap((e) => {
        if (e.kind !== "env") return [];
        if (sessionId !== undefined) {
          const argv = entries.find((a) => a.kind === "argv" && a.pid === e.pid);
          const vendorId = store.get(sessionId)?.vendorSessionId;
          if (!argv || argv.kind !== "argv" || vendorId === undefined || !argv.argv.includes(vendorId)) return [];
        }
        return [e.env];
      });
    },
    cleanup: async () => {
      await driver.shutdown();
      if (!options.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 一轮慢慢回：先等 ms 毫秒再回 text。 */
export const slowTurn = (ms: number, text = "done") => ({ steps: [{ sleepMs: ms }, { text }] });

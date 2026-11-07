// 驱动层测试的共用零件：内存版 SessionStore、假 claude 的路径和记录、按事件等待。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSessionPatch,
  AgentSessionRow,
  DriverEvent,
  LaunchFiles,
  ReadonlyPolicy,
  SessionId,
  SessionStore,
  WriteScope,
} from "../../shared/index.ts";
import { EMPTY_TOKEN_USAGE } from "../../shared/index.ts";
import type { FakeLogEntry, FakeScript } from "../../../test/fake-claude/fake-claude.ts";
import { createClaudeDriver, type ClaudeDriver, type ClaudeDriverOptions } from "./index.ts";

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
  /**
   * 假 claude 收到的用户消息（只算 type=user 的行）里的文字：几个 text 块之间空一行连起来
   * （我们加的说明、标签各占一块，原文放最后一块；以前是同一块里空一行连着，这样比对的字和以前一样）。
   */
  stdinTexts(): string[];
  /** 同上，每条消息的 text 块分开（测“原文单独放最后一块”）。 */
  stdinBlocks(): string[][];
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
    /** 给了就当 LaunchFiles.personaRevision（拼进提示词的性格设定是哪一版），见 persona-fixture.ts。 */
    personaRevision: (() => number) | null;
    perSession: Map<SessionId, { fingerprint?: string; env?: Record<string, string> }>;
    /** 给了就当 LaunchFiles.writeScope（Worker 的可写范围）。 */
    writeScope: WriteScope | null;
    /** 给了就当 LaunchFiles.backgroundHoldMaxMs（这个会话有后台任务时最多不关多久）。 */
    backgroundHoldMaxMs: number | null;
    /** 给了就当 LaunchFiles.readonly（只读 Worker 的统一策略）。 */
    readonly: ReadonlyPolicy | null;
  };
  /** prepareLaunch 被调了几次（按会话）。 */
  prepareCalls: Map<SessionId, number>;
  /** 某个会话的进程启动时记下的环境变量（按启动先后）。 */
  envs(sessionId?: SessionId): Array<Record<string, string>>;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  script?: FakeScript;
  driver?: Partial<ClaudeDriverOptions>;
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
  const launch: Harness["launch"] = { fingerprint: "", env: {}, settings: false, fail: false, personaRevision: null, perSession: new Map(), writeScope: null, backgroundHoldMaxMs: null, readonly: null };
  const prepareCalls = new Map<SessionId, number>();
  const driver = createClaudeDriver({
    claudePath: FAKE_CLAUDE,
    store,
    prepareLaunch: async (session) => {
      prepareCalls.set(session.id, (prepareCalls.get(session.id) ?? 0) + 1);
      if (launch.fail) throw new Error("prepareLaunch 坏了");
      const launchDir = join(dir, "launch", String(session.id));
      mkdirSync(launchDir, { recursive: true });
      writeFileSync(join(launchDir, "prompt.md"), "你是项目经理。");
      const files: LaunchFiles = {
        promptFile: join(launchDir, "prompt.md"),
        env: { ...launch.env, ...launch.perSession.get(session.id)?.env },
        fingerprint: launch.perSession.get(session.id)?.fingerprint ?? launch.fingerprint,
      };
      if (launch.personaRevision) files.personaRevision = launch.personaRevision();
      if (launch.writeScope) files.writeScope = launch.writeScope;
      if (launch.backgroundHoldMaxMs !== null) files.backgroundHoldMaxMs = launch.backgroundHoldMaxMs;
      if (launch.readonly) files.readonly = launch.readonly;
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

  const stdinBlocks = () =>
    log().flatMap((e) => {
      if (e.kind !== "stdin") return [];
      const obj = JSON.parse(e.line) as { type: string; message?: { content: Array<{ text: string }> } };
      return obj.type === "user" ? [obj.message!.content.map((c) => c.text)] : [];
    });
  const stdinTexts = () => stdinBlocks().map((blocks) => blocks.join("\n\n"));

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
      effort: null,
      pid: null,
      status: "idle",
      hasCompletedTurn: false,
      lastEventAt: null,
      rateLimit: null,
      usage: { ...EMPTY_TOKEN_USAGE },
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
    stdinBlocks,
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

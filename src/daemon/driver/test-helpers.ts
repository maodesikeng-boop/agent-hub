import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonLog } from "../../../test/append-log.ts";
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
import { wrapScriptAsPlatformCli } from "../../../test/fake-cli-shim.ts";
import { createClaudeDriver, type ClaudeDriver, type ClaudeDriverOptions } from "../../vendors/claude/driver.ts";

export const FAKE_CLAUDE = fileURLToPath(new URL("../../../test/fake-claude/fake-claude.ts", import.meta.url));

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
  waitFor<T extends DriverEvent["type"]>(
    type: T,
    pred?: (e: Extract<DriverEvent, { type: T }>) => boolean,
    count?: number,
  ): Promise<Extract<DriverEvent, { type: T }>>;
  of<T extends DriverEvent["type"]>(type: T): Array<Extract<DriverEvent, { type: T }>>;
  log(): FakeLogEntry[];
  stdinTexts(): string[];
  stdinBlocks(): string[][];
  argvs(): string[][];
  addSession(patch?: Partial<AgentSessionRow>): AgentSessionRow;
  launch: {
    fingerprint: string;
    env: Record<string, string>;
    settings: boolean;
    fail: boolean;
    personaRevision: (() => number) | null;
    perSession: Map<SessionId, { fingerprint?: string; env?: Record<string, string> }>;
    writeScope: WriteScope | null;
    backgroundHoldMaxMs: number | null;
    readonly: ReadonlyPolicy | null;
  };
  prepareCalls: Map<SessionId, number>;
  envs(sessionId?: SessionId): Array<Record<string, string>>;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  script?: FakeScript;
  driver?: Partial<ClaudeDriverOptions>;
  dir?: string;
}

let nextId = 1;

export function makeHarness(options: HarnessOptions = {}): Harness {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "agent-hub-driver-"));
  const logFile = join(dir, "fake-claude.log");
  const scriptFile = join(dir, "script.json");
  writeFileSync(scriptFile, JSON.stringify(options.script ?? {}));
  const defaultExe = wrapScriptAsPlatformCli(FAKE_CLAUDE, dir, "fake-claude");
  const store = new MemorySessionStore();
  const launch: Harness["launch"] = { fingerprint: "", env: {}, settings: false, fail: false, personaRevision: null, perSession: new Map(), writeScope: null, backgroundHoldMaxMs: null, readonly: null };
  const prepareCalls = new Map<SessionId, number>();
  const driver = createClaudeDriver({
    executablePath: defaultExe,
    store,
    prepareLaunch: async (session) => {
      prepareCalls.set(session.id, (prepareCalls.get(session.id) ?? 0) + 1);
      if (launch.fail) throw new Error("prepareLaunch 坏了");
      const launchDir = join(dir, "launch", String(session.id));
      mkdirSync(launchDir, { recursive: true });
      writeFileSync(join(launchDir, "prompt.md"), "你是项目经理。");
      let settingsFile: string | undefined;
      if (launch.settings) {
        settingsFile = join(launchDir, "settings.json");
        writeFileSync(settingsFile, "{}");
      }
      const base = {
        promptFile: join(launchDir, "prompt.md"),
        env: { ...launch.env, ...launch.perSession.get(session.id)?.env },
        fingerprint: launch.perSession.get(session.id)?.fingerprint ?? launch.fingerprint,
        ...(launch.personaRevision ? { personaRevision: launch.personaRevision() } : {}),
        ...(launch.writeScope ? { writeScope: launch.writeScope } : {}),
        ...(launch.backgroundHoldMaxMs !== null ? { backgroundHoldMaxMs: launch.backgroundHoldMaxMs } : {}),
        ...(settingsFile === undefined ? {} : { settingsFile }),
      };
      if (!launch.readonly) return base;
      const tmpDir = join(dir, "session-tmp", String(session.id));
      mkdirSync(tmpDir, { recursive: true });
      return { ...base, readonly: launch.readonly, tmpDir } satisfies LaunchFiles;
    },
    env: {
      FAKE_CLAUDE_LOG: logFile,
      FAKE_CLAUDE_SCRIPT: scriptFile,
      FAKE_CLAUDE_STATE: dir,
      ...(process.platform === "win32"
        ? { PATH: `${dirname(process.execPath)};${process.env.PATH ?? process.env.Path ?? ""}` }
        : {}),
    },
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

  const log = () => readJsonLog<FakeLogEntry>(logFile);

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

export const slowTurn = (ms: number, text = "done") => ({ steps: [{ sleepMs: ms }, { text }] });

export const AGY_SIGNED_OUT_STDOUT =
  "Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DriverError,
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  type Driver,
  type DriverEvent,
  type DriverEventListener,
  type DriverSendInput,
  type DriverSendResult,
  type LaunchFiles,
  type SessionId,
} from "../../shared/index.ts";
import { sessionLaunchDir } from "../../shared/paths.ts";
import { MACOS_NESTED_SANDBOX_MESSAGE } from "../../shared/errors.ts";
import { createSessionTokens } from "../agent-api/tokens.ts";
import { createLedger, type SqliteLedger } from "../ledger/index.ts";
import { getAgentSession } from "../store/index.ts";
import type { Db } from "../store/db.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { prepareRouterSandboxLaunch } from "./sandbox.ts";
import { createRouterTurnPurposes, createRouterTurnRunner, type RouterTurnPurposes, type RouterTurnRequest } from "./single-turn.ts";

/** 假驱动层：start 时和守护进程一样按用途拼启动文件，send 后照 onTurn 发事件。 */
class FakeDriver implements Driver {
  readonly launches = new Map<SessionId, LaunchFiles>();
  readonly interrupted: SessionId[] = [];
  readonly ended: SessionId[] = [];
  private readonly listeners = new Set<DriverEventListener>();
  startError: Error | null = null;
  sendResult: DriverSendResult = { kind: "written" };
  onTurn: ((emit: (event: DriverEvent) => void, input: DriverSendInput) => void) | null = null;

  private readonly launch: (sessionId: SessionId) => LaunchFiles;

  constructor(launch: (sessionId: SessionId) => LaunchFiles) {
    this.launch = launch;
  }

  async start(sessionId: SessionId): Promise<void> {
    if (this.startError) throw this.startError;
    this.launches.set(sessionId, this.launch(sessionId));
  }
  async send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult> {
    queueMicrotask(() => this.onTurn?.((event) => this.listeners.forEach((fn) => fn(sessionId, event)), input));
    return this.sendResult;
  }
  async interrupt(sessionId: SessionId): Promise<void> {
    this.interrupted.push(sessionId);
  }
  async end(sessionId: SessionId): Promise<void> {
    this.ended.push(sessionId);
  }
  async shutdown(): Promise<void> {}
  async cleanupStale(): Promise<void> {}
  async queryCommands(): Promise<null> {
    return null;
  }
  onEvent(listener: DriverEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

let root: string;
let stateDir: string;
let launchDir: string;
let db: Db;
let ledger: SqliteLedger;
let driver: FakeDriver;
let purposes: RouterTurnPurposes;
let tokens: ReturnType<typeof createSessionTokens>;

const at = () => Date.now();
const text = (t: string, parentToolUseId?: string): DriverEvent => ({ type: "agent.text", uuid: t, text: t, at: at(), ...(parentToolUseId ? { parentToolUseId } : {}) }) as DriverEvent;
const ended = (ok = true): DriverEvent => ({ type: "turn.ended", ok, interrupted: false, messageIds: [1], durationMs: 1, at: at() }) as DriverEvent;

function request(over: Partial<RouterTurnRequest> = {}): RouterTurnRequest {
  return { purpose: "dispatch", vendor: "claude", model: "haiku", effort: "low", text: "你好", timeoutMs: 1_000, ...over };
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-single-turn-")));
  stateDir = join(root, "state");
  launchDir = join(root, "launch");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(launchDir, { recursive: true });
  db = openTestDb();
  ledger = createLedger(db, { pmHomeRoot: join(root, "pm-home"), dataHome: root });
  purposes = createRouterTurnPurposes();
  tokens = createSessionTokens();
  driver = new FakeDriver((sessionId) =>
    prepareRouterSandboxLaunch(getAgentSession(db, sessionId)!, {
      tmpDir: root,
      launchDir,
      dataDir: root,
      stateDir,
      osSandboxed: false,
      tokens,
      hubSock: join(root, "hub.sock"),
      hubBinDir: join(root, "bin"),
      basePath: "/usr/bin",
      purpose: purposes.of(sessionId),
    }),
  );
});

afterEach(() => {
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const runner = () => createRouterTurnRunner({ ledger, driver, tokens, purposes, stateDir, launchDir, cleanupGraceMs: 50 });

describe("createRouterTurnRunner", () => {
  it("正常结束时返回这一轮顶层 agent 的全部文字和用量，不含子代理的文字", async () => {
    driver.onTurn = (emit) => {
      emit(text("第一段"));
      emit(text("子代理说的", "tool-1"));
      emit(text("第二段"));
      emit(ended());
    };
    const result = await runner()(request());
    expect(result).toMatchObject({ ok: true, text: "第一段\n\n第二段", usage: null });
  });

  it("到 timeoutMs 时打断这一轮，返回 ok: false 和已经收到的文字", async () => {
    driver.onTurn = (emit) => emit(text("写了一半"));
    const result = await runner()(request({ timeoutMs: 30 }));
    expect(result).toMatchObject({ ok: false, reason: "timeout", partialText: "写了一半" });
    expect(driver.interrupted).toHaveLength(1);
  });

  it("signal 触发时打断这一轮，返回 reason aborted", async () => {
    const controller = new AbortController();
    driver.onTurn = () => controller.abort();
    const result = await runner()(request({ signal: controller.signal }));
    expect(result).toMatchObject({ ok: false, reason: "aborted" });
    expect(driver.interrupted).toHaveLength(1);
  });

  it("起进程失败、写不进会话、进程提前退出时返回 ok: false，不抛错", async () => {
    driver.startError = new Error("spawn ENOENT");
    expect(await runner()(request())).toMatchObject({ ok: false, reason: "error", errorRaw: "spawn ENOENT" });

    driver.startError = null;
    driver.sendResult = { kind: "rejected" } as DriverSendResult;
    expect(await runner()(request())).toMatchObject({ ok: false, reason: "error" });

    driver.sendResult = { kind: "written" };
    driver.onTurn = (emit) => emit({ type: "session.exited", reason: "crash", hadResult: false, at: at() } as unknown as DriverEvent);
    expect(await runner()(request())).toMatchObject({ ok: false, reason: "error", error: expect.stringContaining("crash") });
  });

  it("acceptance S2: surfaces actionable macOS nested sandbox-exec exit 71 message instead of bare 进程提前退出（startup_failed）", async () => {
    const startErr = new DriverError(
      "spawn_failed",
      "claude exited before system/init (exit code 71): sandbox-exec: sandbox_apply: Operation not permitted",
    );
    const origStart = driver.start.bind(driver);
    driver.start = async (sessionId) => {
      // Real drivers emit session.exited(startup_failed) synchronously before start() rejects.
      for (const fn of (driver as unknown as { listeners: Set<DriverEventListener> }).listeners) {
        fn(sessionId, {
          type: "session.exited",
          reason: "startup_failed",
          exitCode: 71,
          signal: null,
          hadResult: false,
          messageIds: [],
          at: at(),
        });
      }
      throw startErr;
    };
    try {
      const result = await runner()(request());
      expect(result).toMatchObject({
        ok: false,
        reason: "error",
        error: MACOS_NESTED_SANDBOX_MESSAGE,
      });
      expect(result.ok ? "" : result.error).not.toContain("进程提前退出");
    } finally {
      driver.start = origStart;
    }
  });

  it("不管成败都撤令牌、结束会话、删掉临时启动目录，onSession 返回的收尾函数被调一次", async () => {
    const revoke = vi.spyOn(tokens, "revoke");
    for (const outcome of ["ok", "error"] as const) {
      driver.onTurn = (emit) => emit(ended(outcome === "ok"));
      const release = vi.fn();
      let sessionId = 0;
      await runner()(request({ onSession: (id) => ((sessionId = id), release) }));
      expect(release).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith(sessionId);
      expect(driver.ended).toContain(sessionId);
      expect(existsSync(sessionLaunchDir(launchDir, sessionId))).toBe(false);
      expect(getAgentSession(db, sessionId)?.status ?? "ended").toBe("ended");
      expect(purposes.of(sessionId)).toBe("dispatch");
    }
  });

  it("purpose 为 catalog 的会话启动环境里没有 HUB_TOKEN、HUB_SOCK，系统提示词是写档提示词", async () => {
    let launch: LaunchFiles | undefined;
    driver.onTurn = (emit) => {
      launch = [...driver.launches.values()].at(-1);
      emit(ended());
    };
    await runner()(request({ purpose: "catalog" }));
    expect(launch!.env[ENV_HUB_TOKEN]).toBeUndefined();
    expect(launch!.env[ENV_HUB_SOCK]).toBeUndefined();
    expect(launch!.env.PATH).toBe("/usr/bin");
    expect(launch!.promptFile).toBeDefined();
  });

  it("purpose 为 dispatch 的会话和现在的总助轨道 B 一样拿总助提示词和 hub 令牌", async () => {
    let launch: LaunchFiles | undefined;
    let prompt = "";
    driver.onTurn = (emit) => {
      launch = [...driver.launches.values()].at(-1);
      prompt = readFileSync(launch!.promptFile, "utf8");
      emit(ended());
    };
    await runner()(request({ purpose: "dispatch" }));
    expect(launch!.env[ENV_HUB_TOKEN]).toEqual(expect.any(String));
    expect(launch!.env[ENV_HUB_SOCK]).toBe(join(root, "hub.sock"));
    expect(prompt).toContain("总助（Router）");

    driver.onTurn = (emit) => {
      prompt = readFileSync([...driver.launches.values()].at(-1)!.promptFile, "utf8");
      emit(ended());
    };
    await runner()(request({ purpose: "catalog" }));
    expect(prompt).toContain("只回一个 JSON 对象");
    expect(prompt).not.toContain("hub dispatch");
  });
});

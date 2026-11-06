import { describe, expect, it, vi } from "vitest";
import {
  DriverError,
  QUEUED_RECHECK_MS,
  SessionTokenRevokedError,
  WORKER_FIRST_TURN_RECHECK_MS,
  type ActionRow,
  type AgentSessionRow,
  type DriverSendResult,
  type Message,
  type RateLimitInfo,
  type SetupOutcome,
  type WorktreeTask,
} from "../shared/index.ts";
import {
  createSessionEndHandler,
  createSessionSendHandler,
  createSessionStartHandler,
  createWorktreeCreateHandler,
  endedOnRevokedTokens,
  type HandlerDeps,
} from "./handlers.ts";
import type { SetupJob } from "./setup/index.ts";

const NOW = 1_800_000_000_000;

function message(patch: Partial<Message> = {}): Message {
  return {
    id: 7,
    conversationId: 1,
    sessionId: 1,
    workerId: null,
    sender: "user",
    kind: "text",
    text: "你好",
    meta: null,
    collapsed: false,
    dedupeKey: "client:1:a",
    status: "queued",
    failureReason: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function action<T extends "session.start" | "session.send" | "session.end" | "worktree.create">(type: T, params: ActionRow<T>["params"]): ActionRow<T> {
  return { id: 1, type, dedupeKey: "k", params, status: "running", attempts: 0, nextAttemptAt: 0, lastError: null, createdAt: 0, updatedAt: 0 };
}

function deps(
  options: { message?: Message | null; send?: DriverSendResult | Error; rateLimit?: RateLimitInfo | null; waitsForFirstTurn?: boolean; waitsForHandover?: boolean } = {},
) {
  const send = vi.fn(async () => {
    if (options.send instanceof Error) throw options.send;
    return options.send ?? { kind: "written" as const };
  });
  const start = vi.fn(async () => {});
  const end = vi.fn(async () => {});
  const getMessage = vi.fn(() => (options.message === undefined ? message() : options.message));
  const onActionFailed = vi.fn();
  const refreshSessionState = vi.fn();
  const stopMessage = vi.fn();
  const revoke = vi.fn();
  const waitsForFirstTurn = vi.fn(() => options.waitsForFirstTurn ?? false);
  const waitsForHandover = vi.fn(() => options.waitsForHandover ?? false);
  const d: HandlerDeps = {
    driver: { start, send, end },
    ledger: { getMessage, onActionFailed, refreshSessionState, stopMessage, waitsForFirstTurn, waitsForHandover },
    sessions: { get: () => ({ rateLimit: options.rateLimit ?? null }) as AgentSessionRow },
    tokens: { revoke },
    now: () => NOW,
  };
  return { d, send, start, end, getMessage, onActionFailed, refreshSessionState, stopMessage, revoke, waitsForFirstTurn, waitsForHandover };
}

const sendAction = (extra: { resend?: boolean } = {}) =>
  action("session.send", { sessionId: 1, messageId: 7, source: "user", ...extra });

describe("session.send 处理函数：带附件的消息", () => {
  const attachment = { id: "0123456789abcdef", name: "图.png", path: "/data/uploads/0123456789abcdef/图.png", size: 12, mime: "image/png" };

  it("发给 agent 的正文 = 用户写的字 + 附件的完整绝对路径", async () => {
    const { d, send } = deps({ message: message({ text: "看这张", meta: { attachments: [attachment] } }) });
    await createSessionSendHandler(d)(sendAction());
    const text = (send.mock.calls[0] as unknown as [number, { text: string }])[1].text;
    expect(text.startsWith("看这张\n\n")).toBe(true);
    expect(text).toContain(`- \`${attachment.path}\``);
  });

  it("只有文件：正文就是路径清单", async () => {
    const { d, send } = deps({ message: message({ text: "", meta: { attachments: [attachment] } }) });
    await createSessionSendHandler(d)(sendAction());
    const text = (send.mock.calls[0] as unknown as [number, { text: string }])[1].text;
    expect(text).toContain(attachment.path);
    expect(text.startsWith("\n")).toBe(false);
  });

  it("没有附件的消息（含 meta 是 null 的老消息）：原文不变", async () => {
    const { d, send } = deps({ message: message({ text: "你好" }) });
    await createSessionSendHandler(d)(sendAction());
    expect((send.mock.calls[0] as unknown as [number, { text: string }])[1].text).toBe("你好");
  });
});

describe("session.start 处理函数", () => {
  it("调 driver.start", async () => {
    const { d, start } = deps();
    expect(await createSessionStartHandler(d)(action("session.start", { sessionId: 3, generation: 1 }))).toEqual({ kind: "done" });
    expect(start).toHaveBeenCalledWith(3);
  });

  it("会话已经结束（session_ended）→ done，不抛给执行器（不计入 driver 的 health）", async () => {
    const { d, start } = deps();
    start.mockRejectedValueOnce(new DriverError("session_ended", "session 3 has been ended"));
    expect(await createSessionStartHandler(d)(action("session.start", { sessionId: 3, generation: 1 }))).toEqual({ kind: "done" });
  });

  it("起不来的 DriverError 抛给执行器退避", async () => {
    const { d, start } = deps();
    start.mockRejectedValueOnce(new DriverError("claude_not_found", "claude: ENOENT"));
    await expect(createSessionStartHandler(d)(action("session.start", { sessionId: 3, generation: 1 }))).rejects.toThrow(/^claude_not_found/);
  });
});

describe("session.send 处理函数", () => {
  it("R1 Worker 还没开工、或者任务说明还没写进去（ledger.waitsForFirstTurn）：later，不调 driver.send，会话不会被拉起来", async () => {
    const { d, send, waitsForFirstTurn } = deps({ waitsForFirstTurn: true });
    expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "later", delayMs: WORKER_FIRST_TURN_RECHECK_MS, reason: "worker_not_started" });
    expect(waitsForFirstTurn).toHaveBeenCalledWith(1, 7);
    expect(send).not.toHaveBeenCalled();
  });

  it("项目经理在写交接、新会话的第一条还没发（ledger.waitsForHandover）：later，换代后再发给新会话", async () => {
    const { d, send, waitsForHandover } = deps({ waitsForHandover: true });
    expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "handover" });
    expect(waitsForHandover).toHaveBeenCalledWith(7);
    expect(send).not.toHaveBeenCalled();
  });

  it("读出消息文字，调 driver.send；写进去了 → done", async () => {
    const { d, send } = deps();
    expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "done" });
    expect(send).toHaveBeenCalledWith(1, { messageIds: [7], source: "user", text: "你好" });
  });

  it("Worker 对话里用户直接说的话：带【用户直接对你说】标签（prefixes，驱动层放在原文前面单独一块）；项目经理的话、项目经理对话里用户的话原样发", async () => {
    for (const [patch, extra] of [
      [{ workerId: 3, sender: "user" }, { prefixes: ["【用户直接对你说】"] }],
      [{ workerId: 3, sender: "pm" }, {}],
      [{ workerId: null, sender: "user" }, {}],
    ] as const) {
      const { d, send } = deps({ message: message(patch) });
      await createSessionSendHandler(d)(sendAction());
      expect(send).toHaveBeenCalledWith(1, { messageIds: [7], source: "user", text: "你好", ...extra });
    }
  });

  it("重启后重发：resend 传过去（重发说明由驱动层加，这里不加标签）", async () => {
    const { d, send } = deps({ message: message({ status: "processing" }) });
    await createSessionSendHandler(d)(sendAction({ resend: true }));
    expect(send).toHaveBeenCalledWith(1, { messageIds: [7], source: "user", text: "你好", resend: true });
  });

  it("重启恢复的第一条：recovery 传过去（恢复说明由驱动层和这条写在同一行）", async () => {
    const { d, send } = deps();
    await createSessionSendHandler(d)(action("session.send", { sessionId: 1, messageId: 7, source: "user", resend: true, recovery: true }));
    expect(send).toHaveBeenCalledWith(1, { messageIds: [7], source: "user", text: "你好", resend: true, recovery: true });
  });

  it("会话正忙、在驱动层排队 → later，过一会儿再问", async () => {
    const { d } = deps({ send: { kind: "queued" } });
    expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "session_busy" });
  });

  it("写入前校验没过 → done（驱动层已经出了 driver.error，账本标失败）", async () => {
    const { d } = deps({ send: { kind: "rejected" } });
    expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "done" });
  });

  it("可重试的 DriverError 直接抛出去", async () => {
    const { d } = deps({ send: new DriverError("spawn_failed", "boom") });
    await expect(createSessionSendHandler(d)(sendAction())).rejects.toBeInstanceOf(DriverError);
  });

  it("额度用完 → later 到恢复之后，不调 driver", async () => {
    const resetsAt = NOW / 1000 + 60;
    const { d, send } = deps({ rateLimit: { status: "rejected", resetsAt, windows: {} } });
    expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "later", delayMs: 61_000, reason: "rate_limited" });
    expect(send).not.toHaveBeenCalled();
  });

  it("额度很久以后才恢复：最多推迟 5 分钟再看", async () => {
    const { d } = deps({ rateLimit: { status: "rejected", resetsAt: NOW / 1000 + 3600, windows: {} } });
    expect(await createSessionSendHandler(d)(sendAction())).toMatchObject({ kind: "later", delayMs: 300_000 });
  });

  it("额度快用完（allowed_warning）、或者恢复时间已经过了：照常发", async () => {
    for (const rateLimit of [
      { status: "allowed_warning", resetsAt: NOW / 1000 + 60, windows: {} },
      { status: "rejected", resetsAt: NOW / 1000 - 1, windows: {} },
      { status: "rejected", resetsAt: null, windows: {} },
    ]) {
      const { d, send } = deps({ rateLimit });
      expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "done" });
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it("消息不在了，或者已经有结果（已回复、已停止）→ done，不再发", async () => {
    for (const m of [null, message({ status: "replied" }), message({ status: "stopped" }), message({ status: "cancelled" })]) {
      const { d, send } = deps({ message: m });
      expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "done" });
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("失败过的消息再发（用户重试）照常发", async () => {
    const { d, send } = deps({ message: message({ status: "failed", failureReason: "crash" }) });
    expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "done" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("session.send 处理函数：撞上 session_ended（会话已经结束，比如迁移 0003 结束了老项目群的会话）", () => {
  it("已经写进去一半（已送达、处理中，重启恢复时会遇到）→ 按这一轮被打断处理，标已停止，不标失败，done", async () => {
    for (const status of ["delivered", "processing"] as const) {
      const { d, onActionFailed, stopMessage } = deps({ send: new DriverError("session_ended", "session 1 has been ended"), message: message({ sessionId: 1, status }) });
      expect(await createSessionSendHandler(d)(sendAction({ resend: true }))).toEqual({ kind: "done" });
      expect(stopMessage).toHaveBeenCalledWith(7);
      expect(onActionFailed).not.toHaveBeenCalled();
    }
  });

  it("还在排队（queued）：停不了（排队中没有这一轮）→ 标失败，写中文原因", async () => {
    const { d, onActionFailed, stopMessage } = deps({ send: new DriverError("session_ended", "session 1 has been ended"), message: message({ sessionId: 1, status: "queued" }) });
    const row = sendAction();
    expect(await createSessionSendHandler(d)(row)).toEqual({ kind: "done" });
    expect(stopMessage).not.toHaveBeenCalled();
    expect(onActionFailed).toHaveBeenCalledWith(row, "这个会话已经结束，发不出去了");
  });

  it("重读时消息没了 → done", async () => {
    const { d, getMessage, onActionFailed } = deps({ send: new DriverError("session_ended", "x") });
    getMessage.mockReturnValueOnce(message()).mockReturnValueOnce(null);
    expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "done" });
    expect(onActionFailed).not.toHaveBeenCalled();
  });
});

describe("session.end 处理函数", () => {
  const endAction = () => action("session.end", { sessionId: 4, generation: 1 });

  it("调 driver.end，等它结束后作废令牌、推一次会话状态，done", async () => {
    const { d, end, revoke, refreshSessionState } = deps();
    let finish!: () => void;
    end.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const pending = createSessionEndHandler(d)(endAction());
    await Promise.resolve();
    expect(end).toHaveBeenCalledWith(4);
    // 还在等这一轮回完：令牌不能先作废（agent 这一轮里可能还要用 hub）
    expect(revoke).not.toHaveBeenCalled();
    finish();
    expect(await pending).toEqual({ kind: "done" });
    expect(revoke).toHaveBeenCalledWith(4);
    expect(refreshSessionState).toHaveBeenCalledWith(4);
  });

  it("18 先停掉这个会话正在跑的准备命令，再 driver.end", async () => {
    const { d, end } = deps();
    const order: string[] = [];
    const cancel = vi.fn(() => void order.push("cancel"));
    end.mockImplementationOnce(async () => void order.push("end"));
    expect(await createSessionEndHandler({ ...d, setup: { cancel } })(endAction())).toEqual({ kind: "done" });
    expect(cancel).toHaveBeenCalledWith(4);
    expect(order).toEqual(["cancel", "end"]);
  });

  it("driver.end 出错：抛给执行器重试，令牌不作废", async () => {
    const { d, end, revoke } = deps();
    end.mockRejectedValueOnce(new DriverError("internal_error", "boom"));
    await expect(createSessionEndHandler(d)(endAction())).rejects.toThrow(/^internal_error/);
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("worktree.create 处理函数（m3-plan 第 3 节接口约定）", () => {
  const task: WorktreeTask = {
    workerId: 3,
    sessionId: 30,
    repo: "/code/foo",
    branch: "hub/3-fix-x",
    worktreePath: "/data/worktrees/1/3",
    status: "open",
    setupCommand: null,
  };

  function worktreeDeps(options: { task?: WorktreeTask | null; add?: Error; preparing?: boolean } = {}) {
    const calls: string[] = [];
    const getWorktreeTask = vi.fn(() => (options.task === undefined ? task : options.task));
    const onSetupStarted = vi.fn(() => {
      calls.push("onSetupStarted");
      return options.preparing ?? true;
    });
    const onWorktreeCreated = vi.fn(() => void calls.push("onWorktreeCreated"));
    const addWorktree = vi.fn(async () => {
      calls.push("addWorktree");
      if (options.add) throw options.add;
      return { created: true, baseCommit: "c0ffee" };
    });
    const jobs: SetupJob[] = [];
    const start = vi.fn((job: SetupJob) => {
      calls.push("setup.start");
      jobs.push(job);
      return true;
    });
    const deps = {
      ledger: { getWorktreeTask, onSetupStarted, onWorktreeCreated },
      addWorktree,
      setup: { start },
      setupLogPath: (id: number) => `/data/state/logs/setup/worker-${id}.log`,
    };
    return { deps, getWorktreeTask, onSetupStarted, onWorktreeCreated, addWorktree, start, jobs, calls };
  }

  it("先取任务，再在主文件夹里建 worktree，最后把起点提交交给账本", async () => {
    const t = worktreeDeps();
    const result = await createWorktreeCreateHandler(t.deps)(action("worktree.create", { workerId: 3 }));
    expect(result).toEqual({ kind: "done" });
    expect(t.getWorktreeTask).toHaveBeenCalledWith(3);
    expect(t.addWorktree).toHaveBeenCalledWith({ repoFolder: "/code/foo", worktreePath: "/data/worktrees/1/3", branch: "hub/3-fix-x" });
    expect(t.onWorktreeCreated).toHaveBeenCalledWith(3, "c0ffee");
    expect(t.calls).toEqual(["addWorktree", "onWorktreeCreated"]);
  });

  it("16 没配准备命令：建好马上交给账本，不跑准备命令", async () => {
    const t = worktreeDeps();
    await createWorktreeCreateHandler(t.deps)(action("worktree.create", { workerId: 3 }));
    expect(t.start).not.toHaveBeenCalled();
    expect(t.onSetupStarted).not.toHaveBeenCalled();
    expect(t.onWorktreeCreated).toHaveBeenCalledWith(3, "c0ffee");
  });

  it("17 配了准备命令：标准备中、交给 runner，自己马上做完；跑完 runner 才把起点提交和结果交给账本", async () => {
    const t = worktreeDeps({ task: { ...task, setupCommand: "pnpm install" } });
    expect(await createWorktreeCreateHandler(t.deps)(action("worktree.create", { workerId: 3 }))).toEqual({ kind: "done" });
    expect(t.calls).toEqual(["addWorktree", "onSetupStarted", "setup.start"]);
    expect(t.onWorktreeCreated).not.toHaveBeenCalled();
    expect(t.jobs[0]).toMatchObject({
      workerId: 3,
      sessionId: 30,
      command: "pnpm install",
      cwd: "/data/worktrees/1/3",
      rootPath: "/code/foo",
      logPath: "/data/state/logs/setup/worker-3.log",
    });
    const outcome: SetupOutcome = { kind: "failed", command: "pnpm install", exitCode: 1, signal: null, error: null, timeoutMs: 600_000, durationMs: 5, tail: "x", logPath: "/l", logError: null };
    t.jobs[0]!.onDone(outcome);
    expect(t.onWorktreeCreated).toHaveBeenCalledWith(3, "c0ffee", outcome);
  });

  it("R2 建 worktree 的时候收工了（onSetupStarted 返回 false）：不跑准备命令、不交给账本，做完", async () => {
    const t = worktreeDeps({ task: { ...task, setupCommand: "pnpm install" }, preparing: false });
    expect(await createWorktreeCreateHandler(t.deps)(action("worktree.create", { workerId: 3 }))).toEqual({ kind: "done" });
    expect(t.calls).toEqual(["addWorktree", "onSetupStarted"]);
    expect(t.start).not.toHaveBeenCalled();
    expect(t.onWorktreeCreated).not.toHaveBeenCalled();
  });

  it("Worker 不在了、不用 worktree（null）或已经收工：直接做完，不碰 git", async () => {
    for (const value of [null, { ...task, status: "ended" as const }]) {
      const t = worktreeDeps({ task: value });
      expect(await createWorktreeCreateHandler(t.deps)(action("worktree.create", { workerId: 3 }))).toEqual({ kind: "done" });
      expect(t.addWorktree).not.toHaveBeenCalled();
      expect(t.onWorktreeCreated).not.toHaveBeenCalled();
    }
  });

  it("git 出错：原样抛给执行器重试（次数用完由执行器调 onActionFailed），不告诉账本建好了", async () => {
    const t = worktreeDeps({ add: new Error("分支 hub/3-fix-x 已经存在") });
    await expect(createWorktreeCreateHandler(t.deps)(action("worktree.create", { workerId: 3 }))).rejects.toThrow("已经存在");
    expect(t.onWorktreeCreated).not.toHaveBeenCalled();
  });
});

describe("endedOnRevokedTokens：给 prepareLaunch 的令牌", () => {
  it("同一个会话照常拿令牌；revoke 过的会话 issue 抛 DriverError(session_ended)，不是可重试的错", () => {
    const revoked = new Set<number>();
    const tokens = endedOnRevokedTokens({
      issue: (id) => {
        if (revoked.has(id)) throw new SessionTokenRevokedError(id);
        return `t${id}`;
      },
    });
    expect(tokens.issue(1)).toBe("t1");
    revoked.add(1);
    let caught: unknown;
    try {
      tokens.issue(1);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DriverError);
    expect((caught as DriverError).code).toBe("session_ended");
    expect((caught as DriverError).retryable).toBe(false);
  });

  it("issue 抛的别的错（不是令牌已作废）原样抛出，不当成 session_ended", () => {
    const boom = new Error("random source failed");
    const tokens = endedOnRevokedTokens({
      issue: () => {
        throw boom;
      },
    });
    expect(() => tokens.issue(1)).toThrow(boom);
  });
});

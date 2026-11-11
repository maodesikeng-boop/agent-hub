import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveUpload, saveUpload } from "../uploads.ts";
import {
  createSessionTokens,
} from "../agent-api/tokens.ts";
import { createLedger, type SqliteLedger } from "../ledger/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { Db } from "../store/db.ts";
import {
  DriverError,
  bundledModelCatalog,
  vendorSpec,
  type Driver,
  type DriverEvent,
  type DriverEventListener,
  type DriverSendInput,
  type DriverSendResult,
  type ModelCatalog,
  ROUTER_REPLY_MAX_CHARS,
  type RouterCommandAttachment,
  type RouterCommandRecord,
  type SessionId,
} from "../../shared/index.ts";
import { createRouterSandboxGuard, type RouterSandboxGuard } from "./sandbox.ts";
import {
  RouterTargetError,
  createLocalTargetPort,
  createRouterTargetRegistry,
  type DigestFetchResult,
  type RouterTargetOp,
  type RouterTargetOpResult,
  type RouterTargetPort,
} from "./target-port.ts";
import { createRouterDispatcher, type RouterDispatcher } from "./dispatcher.ts";

class FakeRouterDriver implements Driver {
  readonly started: SessionId[] = [];
  readonly sent: Array<{ sessionId: SessionId; input: DriverSendInput }> = [];
  readonly interrupted: SessionId[] = [];
  readonly ended: SessionId[] = [];
  private readonly listeners = new Set<DriverEventListener>();
  /** 还原真实 BaseDriver 的不变量：end 过的会话号同步标上，之后 start / send 一律抛 session_ended（号被复用就会撞上）。 */
  private readonly endedIds = new Set<SessionId>();

  private assertNotEnded(sessionId: SessionId): void {
    if (this.endedIds.has(sessionId)) throw new DriverError("session_ended", `session ${sessionId} has been ended`);
  }

  /** 自定义本轮行为：收到 send 后可调 dispatcher.handleAgentDispatch 或发事件。 */
  onTurn:
    | ((ctx: {
        sessionId: SessionId;
        input: DriverSendInput;
        emit: (event: DriverEvent) => void;
      }) => Promise<void>)
    | null = null;

  emit(sessionId: SessionId, event: DriverEvent): void {
    for (const fn of this.listeners) fn(sessionId, event);
  }

  async start(sessionId: SessionId): Promise<void> {
    this.assertNotEnded(sessionId);
    this.started.push(sessionId);
  }

  async send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult> {
    this.assertNotEnded(sessionId);
    this.sent.push({ sessionId, input });
    queueMicrotask(async () => {
      if (this.onTurn) {
        await this.onTurn({
          sessionId,
          input,
          emit: (ev) => this.emit(sessionId, ev),
        });
      } else {
        this.emit(sessionId, {
          type: "agent.text",
          uuid: "u-default",
          text: "默认答复",
          at: Date.now(),
        });
        this.emit(sessionId, {
          type: "turn.ended",
          ok: true,
          interrupted: false,
          messageIds: input.messageIds,
          durationMs: 12,
          at: Date.now(),
        });
      }
    });
    return { kind: "written" };
  }

  async interrupt(sessionId: SessionId): Promise<void> {
    this.interrupted.push(sessionId);
  }

  async end(sessionId: SessionId): Promise<void> {
    this.endedIds.add(sessionId);
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

/** 与 daemon.ts 注入的解析器同一口径：按上传编号从磁盘取显示信息，不信客户端报的。 */
function attachmentMetaOf(uploadsDir: string, id: string): RouterCommandAttachment | null {
  const a = resolveUpload(uploadsDir, id);
  return a === null ? null : { id: a.id, name: a.name, mime: a.mime, size: a.size };
}

/** 发一段主 agent 文字再正常结束本轮。 */
function answerTurn(...texts: string[]) {
  return async ({ input, emit }: { input: DriverSendInput; emit: (event: DriverEvent) => void }) => {
    texts.forEach((text, i) => emit({ type: "agent.text", uuid: `u-${i}`, text, at: Date.now() }));
    emit({ type: "turn.ended", ok: true, interrupted: false, messageIds: input.messageIds, durationMs: 5, at: Date.now() });
  };
}

const CLAUDE_ROUTER_PRESET = vendorSpec("claude").models.routerDefault;

/** 轨道 B 收尾后：没有还活着的 assistant 会话行，已结束的最多留 1 行（全表最大 id 那行，保证 id 不回退）。 */
function expectAssistantRowsSettled(db: Db): void {
  expect(db.all("SELECT id FROM agent_sessions WHERE role = 'assistant' AND status != 'ended'")).toHaveLength(0);
  expect(db.all("SELECT id FROM agent_sessions WHERE role = 'assistant'").length).toBeLessThanOrEqual(1);
}

const AVAILABLE_CLAUDE_CATALOG: ModelCatalog = {
  ...bundledModelCatalog("claude"),
  availability: "available",
  source: "vendor",
  defaultModelId: "claude-sonnet-4-6",
  efforts: ["low", "medium", "high"],
  models: [
    { id: CLAUDE_ROUTER_PRESET.model, label: "Claude Fast", description: null, efforts: ["low", "medium", "high"] },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", description: null, efforts: ["low", "medium", "high"] },
  ],
};

describe("RouterDispatcher (Track A zero-model pass-through & Track B read-only fast planning)", () => {
  let rootDir: string;
  let stateDir: string;
  let launchDir: string;
  let uploadsDir: string;
  let db: Db;
  let ledger: SqliteLedger;
  let driver: FakeRouterDriver;
  let sandboxGuard: RouterSandboxGuard;
  let tokens: ReturnType<typeof createSessionTokens>;
  let localPort: RouterTargetPort;
  let remoteOps: RouterTargetOp[];
  let remoteOnline: boolean;
  let remotePort: RouterTargetPort;
  /** 远端设备是否在注册表里（false 时显式目标找不到设备，用来测整条重跑）。 */
  let remoteRegistered: boolean;
  let dispatcher: RouterDispatcher;
  let catalogs: ModelCatalog[];
  let pm1Id: number;
  let pm1ConvId: number;
  let proj1Id: number;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "router-disp-"));
    const dataHome = join(rootDir, "data");
    stateDir = join(dataHome, "state");
    launchDir = join(stateDir, "launch");
    uploadsDir = join(stateDir, "uploads");
    const personasDir = join(dataHome, "personas");
    const pmHomeRoot = join(stateDir, "pm-home");
    const projFolder = join(rootDir, "agent-hub-repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(launchDir, { recursive: true });
    mkdirSync(uploadsDir, { recursive: true });
    mkdirSync(personasDir, { recursive: true });
    mkdirSync(pmHomeRoot, { recursive: true });
    mkdirSync(projFolder, { recursive: true });

    db = openTestDb();
    ledger = createLedger(db, {
      personasDir,
      pmHomeRoot,
      dataHome,
      uploadsDir,
    });

    const created = ledger.createPm({
      name: "总控PM",
      mode: "manage_only",
      vendor: "claude",
      persona: "负责核心仓库研发",
    });
    pm1Id = created.pm.id;
    pm1ConvId = created.conversation.id;
    proj1Id = ledger.hubCall(created.sessionId, "project.create", {
      folder: projFolder,
      name: "agent-hub",
    }).data.project.id;

    driver = new FakeRouterDriver();
    sandboxGuard = createRouterSandboxGuard();
    tokens = createSessionTokens();
    catalogs = [AVAILABLE_CLAUDE_CATALOG];

    localPort = createLocalTargetPort({
      ledger,
      deviceId: "dev-local",
      deviceName: "MacStudio",
      uploadsDir,
      probeWorkspace: async () => ({ kind: "ok", isRepoWithCommit: false, hasUncommittedChanges: false }),
    });

    remoteOps = [];
    remoteOnline = true;
    remoteRegistered = true;
    remotePort = {
      deviceId: "dev-linux",
      deviceName: "LinuxBox",
      isLocal: false,
      async getDigest(): Promise<DigestFetchResult> {
        if (!remoteOnline) {
          return { online: false, digest: null, error: "设备 LinuxBox 当前离线" };
        }
        return {
          online: true,
          digest: {
            generatedAt: Date.now(),
            pms: [
              {
                pmId: 20,
                name: "推理PM",
                vendor: "claude",
                model: null,
                mode: "hands_on",
                activity: "idle",
                conversationId: 200,
                project: {
                  id: 30,
                  name: "gpu-worker",
                  description: null,
                  mainFolder: "/srv/gpu-worker",
                  otherFolders: [],
                },
                personaSummary: "负责 Linux GPU 训练服务",
                pmNote: null,
                activeWorkers: [],
                activeWorkerTotal: 0,
                pendingDecisionCount: 0,
                recentBrief: null,
                lastActiveAt: Date.now(),
              },
            ],
          },
        };
      },
      async executeOp(op: RouterTargetOp): Promise<RouterTargetOpResult> {
        if (!remoteOnline) {
          throw new RouterTargetError("device_offline", "设备「LinuxBox」当前离线，无法投递消息");
        }
        remoteOps.push(op);
        if (op.kind === "pm.forward") {
          return {
            kind: "pm.forward",
            pmId: op.pmId ?? 20,
            pmName: "推理PM",
            projectId: 30,
            projectName: "gpu-worker",
            conversationId: 200,
            messageId: 888,
          };
        }
        throw new RouterTargetError("invalid", `unexpected remote op ${op.kind}`);
      },
    };

    const registry = createRouterTargetRegistry({ localPort });
    // Wrap registry to include our mock remotePort alongside localPort
    const customRegistry = {
      ...registry,
      selfDeviceId: () => "dev-local",
      getPort(deviceId: string): RouterTargetPort | null {
        if (deviceId === "self" || deviceId === "dev-local") return localPort;
        if (deviceId === "dev-linux" && remoteRegistered) return remotePort;
        return null;
      },
      listPorts(): RouterTargetPort[] {
        return remoteRegistered ? [localPort, remotePort] : [localPort];
      },
      async listAllDigests() {
        const [d1, d2] = await Promise.all([localPort.getDigest(), remotePort.getDigest()]);
        return [
          { port: localPort, result: d1 },
          { port: remotePort, result: d2 },
        ];
      },
    };

    dispatcher = createRouterDispatcher({
      ledger,
      driver,
      tokens,
      sandboxGuard,
      targetRegistry: customRegistry,
      models: { list: async () => catalogs },
      resolveAttachment: (id) => attachmentMetaOf(uploadsDir, id),
      stateDir,
      launchDir,
      agentTimeoutMs: 500,
    });
  });

  afterEach(async () => {
    await dispatcher.close();
    ledger.close();
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("Track A: explicit target delivers verbatim text + attachments with 0 driver calls and clientId idempotency", async () => {
    const savedAtt = await saveUpload(uploadsDir, "crash.png", Buffer.from("PNGDATA"));
    const attId = savedAtt.id;

    const changes: string[] = [];
    ledger.onChange((c) => {
      if (c.type.startsWith("router.command.")) changes.push(`${c.type}:${(c.data as { command: RouterCommandRecord }).command.status}`);
    });

    const rawText = "请排查这个报错：$HOME `rm -rf` 不要被转义\n第二行原样保留";
    const cmd1 = await dispatcher.submitCommand({
      clientId: "cid-track-a-1",
      text: rawText,
      attachmentIds: [attId],
      target: { deviceId: "self", pmId: pm1Id },
    });

    expect(driver.started).toHaveLength(0);
    expect(driver.sent).toHaveLength(0);
    expect(cmd1.status).toBe("dispatched");
    expect(cmd1.model).toBeNull();
    expect(cmd1.dispatched).toHaveLength(1);
    expect(cmd1.dispatched![0]).toMatchObject({
      deviceId: "dev-local",
      pmId: pm1Id,
      op: "pm.forward",
      verbatim: true,
    });
    // 轨道 A 成功不拼回执文案：去向全在 dispatched 的结构化字段里
    expect(cmd1.plan?.reply).toBe("");
    expect(cmd1.plan?.track).toBe("A");
    expect(cmd1.plan?.target).toEqual({ deviceId: "self", pmId: pm1Id });
    expect(cmd1.plan?.attachments).toEqual([{ id: attId, name: "crash.png", mime: "image/png", size: 7 }]);
    expect(changes).toContain("router.command.created:planning");
    expect(changes).toContain("router.command.updated:dispatched");

    // Target PM conversation received exact verbatim text + attachment
    const msgs = ledger.messagesBefore(pm1ConvId, Number.MAX_SAFE_INTEGER).messages.filter((m) => m.sender === "user");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.text).toBe(rawText);
    expect(msgs[0]?.meta).toMatchObject({
      attachments: [expect.objectContaining({ id: attId })],
    });

    // Duplicate clientId is idempotent
    const cmd2 = await dispatcher.submitCommand({
      clientId: "cid-track-a-1",
      text: rawText,
      attachmentIds: [attId],
      target: { deviceId: "self", pmId: pm1Id },
    });
    expect(cmd2.id).toBe(cmd1.id);
    expect(ledger.messagesBefore(pm1ConvId, Number.MAX_SAFE_INTEGER).messages.filter((m) => m.sender === "user")).toHaveLength(1);
  });

  it("Track A: @设备名/项目名 and @唯一项目名 pass through at 0 tokens, while @tanstack/react-query falls through to Track B", async () => {
    // 1. @LinuxBox/gpu-worker <正文> -> remote port, 0 LLM
    const remoteCmd = await dispatcher.submitCommand({
      clientId: "cid-at-remote",
      text: "@LinuxBox/gpu-worker 重启一下训练队列",
    });
    expect(driver.started).toHaveLength(0);
    expect(remoteCmd.status).toBe("dispatched");
    expect(remoteOps).toEqual([
      expect.objectContaining({
        kind: "pm.forward",
        pmId: 20,
        text: "重启一下训练队列",
      }),
    ]);

    // 2. @agent-hub <正文> (unique project name) -> local port, 0 LLM
    const uniqueCmd = await dispatcher.submitCommand({
      clientId: "cid-at-unique",
      text: "@agent-hub 检查一下构建脚本",
    });
    expect(driver.started).toHaveLength(0);
    expect(uniqueCmd.status).toBe("dispatched");
    const msgs = ledger.messagesBefore(pm1ConvId, Number.MAX_SAFE_INTEGER).messages.filter((m) => m.sender === "user");
    expect(msgs.at(-1)?.text).toBe("检查一下构建脚本");

    // 3. Offline known device @LinuxBox/gpu-worker -> fails immediately at 0 LLM, then retryCommand succeeds once online!
    remoteOnline = false;
    const offlineCmd = await dispatcher.submitCommand({
      clientId: "cid-at-offline",
      text: "@LinuxBox/gpu-worker 恢复后跑基准测试",
    });
    expect(driver.started).toHaveLength(0);
    expect(offlineCmd.status).toBe("failed");
    expect(offlineCmd.error).toContain("离线");

    remoteOnline = true;
    const retried = await dispatcher.retryCommand(offlineCmd.id);
    expect(driver.started).toHaveLength(0);
    expect(retried.status).toBe("dispatched");
    expect(remoteOps.at(-1)).toMatchObject({
      kind: "pm.forward",
      text: "恢复后跑基准测试",
    });

    // 4. Scoped npm package @tanstack/react-query is NOT a device -> falls through to Track B!
    driver.onTurn = async ({ sessionId, input, emit }) => {
      const commandId = sandboxGuard.commandOf(sessionId)!;
      await dispatcher.handleAgentDispatch(sessionId, commandId, {
        op: "pm",
        device: "self",
        pmId: pm1Id,
        verbatim: true,
      });
      emit({
        type: "turn.ended",
        ok: true,
        interrupted: false,
        messageIds: input.messageIds,
        durationMs: 10,
        at: Date.now(),
      });
    };
    const npmCmd = await dispatcher.submitCommand({
      clientId: "cid-npm-scope",
      text: "@tanstack/react-query 的缓存失效怎么配置",
    });
    expect(driver.started).toHaveLength(1);
    expect(npmCmd.status).toBe("dispatched");
    expect(ledger.messagesBefore(pm1ConvId, Number.MAX_SAFE_INTEGER).messages.at(-1)?.text).toBe(
      "@tanstack/react-query 的缓存失效怎么配置",
    );
  });

  it("Track B: --verbatim copies raw user text & attachments byte-for-byte, cleans up temporary assistant session, and writes audit log", async () => {
    const savedAtt = await saveUpload(uploadsDir, "spec.md", Buffer.from("# Design"));
    const attId = savedAtt.id;

    const userRaw = "给核心仓库派一个只读 Worker 排查内存峰值：\n1. 查 SQLite cache\n2. 查 LRU 上限";

    driver.onTurn = async ({ sessionId, input, emit }) => {
      // Fleet Digest + user text are in prompt, within budget
      expect(input.text).toContain("跨设备 PM 与项目名片");
      expect(input.text).toContain("agent-hub");
      expect(input.text).toContain("gpu-worker");

      const commandId = sandboxGuard.commandOf(sessionId);
      expect(commandId).not.toBeNull();

      const res = await dispatcher.handleAgentDispatch(sessionId, commandId!, {
        op: "worker-start",
        device: "self",
        projectId: proj1Id,
        title: "排查内存峰值",
        readonly: true,
        verbatim: true,
      });
      expect(res.text).toContain("排查内存峰值");

      emit({
        type: "turn.ended",
        ok: true,
        interrupted: false,
        messageIds: input.messageIds,
        durationMs: 25,
        at: Date.now(),
      });
    };

    const cmd = await dispatcher.submitCommand({
      clientId: "cid-track-b-verbatim",
      text: userRaw,
      attachmentIds: [attId],
    });

    expect(cmd.status).toBe("dispatched");
    expect(cmd.vendor).toBe("claude");
    expect(cmd.model).toBe(CLAUDE_ROUTER_PRESET.model);
    expect(cmd.effort).toBe(CLAUDE_ROUTER_PRESET.effort);
    expect(cmd.dispatched).toHaveLength(1);
    expect(cmd.dispatched![0]).toMatchObject({
      op: "worker.start",
      deviceId: "dev-local",
      projectId: proj1Id,
      readonly: true,
      verbatim: true,
    });

    // Worker received exact userRaw + attachment path
    const workerId = cmd.dispatched![0]!.workerId!;
    const wInfo = ledger.resolveRouterLocalWorker(workerId);
    const workerMsgs = ledger.messagesBefore(wInfo.workerConversationId, Number.MAX_SAFE_INTEGER).messages;
    expect(workerMsgs[0]?.text).toContain(userRaw);

    // Temporary assistant session was completely cleaned up from DB and sandboxGuard!
    expectAssistantRowsSettled(db);
    expect(driver.ended).toHaveLength(1);
    expect(sandboxGuard.commandOf(driver.started[0]!)).toBeNull();

    // Audit log recorded
    const audits = db.all<{ action: string; actor: string }>(
      "SELECT action, actor FROM router_audit_log ORDER BY id ASC",
    );
    expect(audits.some((a) => a.actor === "router_agent")).toBe(true);
  });

  it("Track B: enforces ROUTER_MAX_DISPATCH_TARGETS (8) cap and handles pure answered turns & timeouts", async () => {
    // 1. Cap at 8 targets
    driver.onTurn = async ({ sessionId, input, emit }) => {
      const commandId = sandboxGuard.commandOf(sessionId)!;
      for (let i = 0; i < 8; i++) {
        await dispatcher.handleAgentDispatch(sessionId, commandId, {
          op: "pm",
          device: "self",
          pmId: pm1Id,
          text: `子任务 #${i + 1}`,
        });
      }
      await expect(
        dispatcher.handleAgentDispatch(sessionId, commandId, {
          op: "pm",
          device: "self",
          pmId: pm1Id,
          text: "第 9 个超限目标",
        }),
      ).rejects.toThrow(/最多分派 8 个目标/);

      emit({
        type: "turn.ended",
        ok: true,
        interrupted: false,
        messageIds: input.messageIds,
        durationMs: 20,
        at: Date.now(),
      });
    };

    const cappedCmd = await dispatcher.submitCommand({
      clientId: "cid-cap-8",
      text: "拆成很多个目标",
    });
    expect(cappedCmd.status).toBe("dispatched");
    expect(cappedCmd.dispatched).toHaveLength(8);

    // 2. Pure answer turn (no write dispatches) -> status === "answered"
    driver.onTurn = async ({ input, emit }) => {
      emit({
        type: "agent.text",
        uuid: "u-ans",
        text: "设备 LinuxBox 当前离线，无法把任务发给推理PM。",
        at: Date.now(),
      });
      emit({
        type: "turn.ended",
        ok: true,
        interrupted: false,
        messageIds: input.messageIds,
        durationMs: 15,
        at: Date.now(),
      });
    };
    const answeredCmd = await dispatcher.submitCommand({
      clientId: "cid-answered",
      text: "帮我看看离线机器",
    });
    expect(answeredCmd.status).toBe("answered");
    expect((answeredCmd.plan as { reply?: string })?.reply).toContain("LinuxBox 当前离线");

    // 3. Hard timeout (ROUTER_AGENT_TIMEOUT_MS) -> interrupts & cleans up session, marks command failed
    driver.onTurn = async () => {
      // Never emits turn.ended!
    };
    const timeoutCmd = await dispatcher.submitCommand({
      clientId: "cid-timeout",
      text: "这条会卡住超时",
    });
    expect(timeoutCmd.status).toBe("failed");
    expect(timeoutCmd.error).toContain("超时");
    expect(driver.interrupted.length).toBeGreaterThanOrEqual(1);
    expectAssistantRowsSettled(db);
  });

  it("handles ambiguous @同名项目 across devices and partial-failure retry without duplicating succeeded targets", async () => {
    // Create a second local PM whose project is also named "gpu-worker" (same as LinuxBox!)
    const dupFolder = join(rootDir, "local-gpu-worker");
    mkdirSync(dupFolder, { recursive: true });
    const dupPm = ledger.createPm({
      name: "本机GPU负责人",
      mode: "manage_only",
      vendor: "claude",
      persona: "本机测试",
    });
    ledger.hubCall(dupPm.sessionId, "project.create", {
      folder: dupFolder,
      name: "gpu-worker",
    });

    // 1. Ambiguous @gpu-worker fails at 0 LLM with disambiguation message
    const ambigCmd = await dispatcher.submitCommand({
      clientId: "cid-ambig",
      text: "@gpu-worker 查看显存占用",
    });
    expect(driver.started).toHaveLength(0);
    expect(ambigCmd.status).toBe("failed");
    expect(ambigCmd.error).toContain("请用 @设备名/项目名 指定");

    // 2. Track B dispatches to self (succeeds) + LinuxBox (offline -> fails); retryCommand only retries LinuxBox!
    remoteOnline = false;
    driver.onTurn = async ({ sessionId, input, emit }) => {
      const commandId = sandboxGuard.commandOf(sessionId)!;
      await dispatcher.handleAgentDispatch(sessionId, commandId, {
        op: "pm",
        device: "self",
        pmId: pm1Id,
        text: "发给本机的部分",
      });
      await expect(
        dispatcher.handleAgentDispatch(sessionId, commandId, {
          op: "pm",
          device: "dev-linux",
          pmId: 20,
          text: "发给远端的部分",
        }),
      ).rejects.toThrow(/离线/);

      emit({
        type: "turn.ended",
        ok: true,
        interrupted: false,
        messageIds: input.messageIds,
        durationMs: 12,
        at: Date.now(),
      });
    };

    const partialCmd = await dispatcher.submitCommand({
      clientId: "cid-partial",
      text: "本机和远端同时部署",
    });
    expect(partialCmd.status).toBe("failed");
    expect(partialCmd.dispatched).toHaveLength(1);
    expect(partialCmd.dispatched?.[0]?.deviceId).toBe("dev-local");
    expect(
      ledger.messagesBefore(pm1ConvId, Number.MAX_SAFE_INTEGER).messages.filter((m) => m.sender === "user"),
    ).toHaveLength(1);

    // Bring LinuxBox online and retry: local PM must STILL have only 1 user message, while remote receives its 1 op!
    remoteOnline = true;
    const afterRetry = await dispatcher.retryCommand(partialCmd.id);
    expect(afterRetry.status).toBe("dispatched");
    expect(afterRetry.dispatched).toHaveLength(2);
    expect(
      ledger.messagesBefore(pm1ConvId, Number.MAX_SAFE_INTEGER).messages.filter((m) => m.sender === "user"),
    ).toHaveLength(1);
    expect(remoteOps).toHaveLength(1);
    expect(remoteOps[0]).toMatchObject({ kind: "pm.forward", pmId: 20, text: "发给远端的部分" });
  });

  describe("回收与幂等（审查 PR #275 补的回归）", () => {
    const makeDispatcher = (overrides: Partial<Parameters<typeof createRouterDispatcher>[0]> = {}) =>
      createRouterDispatcher({
        ledger,
        driver,
        tokens,
        sandboxGuard,
        targetRegistry: {
          selfDeviceId: () => "dev-local",
          getPort: (id: string) => (id === "self" || id === "dev-local" ? localPort : null),
          listPorts: () => [localPort],
          listAllDigests: async () => [{ port: localPort, result: await localPort.getDigest() }],
        },
        models: { list: async () => catalogs },
        resolveAttachment: (id: string) => attachmentMetaOf(uploadsDir, id),
        stateDir,
        launchDir,
        agentTimeoutMs: 100,
        sessionCleanupGraceMs: 50,
        ...overrides,
      });

    it("厂商进程卡死（start / end 都不返回）时超时照样结束本轮、按时释放并发槽，下一条指令不被卡住", async () => {
      const hung = new Set<SessionId>();
      driver.start = async (sessionId) => {
        driver.started.push(sessionId);
        if (driver.started.length === 1) {
          hung.add(sessionId);
          await new Promise<void>(() => {});
        }
      };
      const origEnd = driver.end.bind(driver);
      driver.end = async (sessionId) => {
        if (hung.has(sessionId)) await new Promise<void>(() => {});
        return origEnd(sessionId);
      };
      const d = makeDispatcher({ maxConcurrentTrackB: 1 });
      try {
        const t0 = Date.now();
        const stuck = await d.submitCommand({ clientId: "cid-hung", text: "这条会卡死" });
        expect(stuck.status).toBe("failed");
        expect(stuck.error).toContain("超时");
        expect(Date.now() - t0).toBeLessThan(2_000);
        expect(driver.interrupted).toContain([...hung][0]);

        // 并发槽只有 1 个：上一条没释放的话这条会一直排队
        const next = await d.submitCommand({ clientId: "cid-after-hung", text: "下一条" });
        expect(next.status).toBe("answered");
        expectAssistantRowsSettled(db);
      } finally {
        await d.close();
      }
    });

    it("规划超时前已投出一部分：整条重跑会重复投递，retry 直接拒绝", async () => {
      driver.onTurn = async ({ sessionId }) => {
        const commandId = sandboxGuard.commandOf(sessionId)!;
        await dispatcher.handleAgentDispatch(sessionId, commandId, {
          op: "pm",
          device: "self",
          pmId: pm1Id,
          verbatim: true,
        });
        // 之后一直不结束本轮 → 超时
      };
      const cmd = await dispatcher.submitCommand({ clientId: "cid-partial-timeout", text: "投一半就超时" });
      expect(cmd.status).toBe("failed");
      expect(cmd.dispatched).toHaveLength(1);
      expect(cmd.plan?.retryOps ?? []).toHaveLength(0);

      const userMsgs = () =>
        ledger.messagesBefore(pm1ConvId, Number.MAX_SAFE_INTEGER).messages.filter((m) => m.sender === "user");
      expect(userMsgs()).toHaveLength(1);
      await expect(dispatcher.retryCommand(cmd.id)).rejects.toThrow(/重复投递/);
      expect(userMsgs()).toHaveLength(1);
      expect(ledger.getRouterCommand(cmd.id)?.status).toBe("failed");
    });

    it("模型并发调用 hub dispatch 也不能突破 ROUTER_MAX_DISPATCH_TARGETS", async () => {
      let results: PromiseSettledResult<unknown>[] = [];
      driver.onTurn = async ({ sessionId, input, emit }) => {
        const commandId = sandboxGuard.commandOf(sessionId)!;
        results = await Promise.allSettled(
          Array.from({ length: 12 }, (_, i) =>
            dispatcher.handleAgentDispatch(sessionId, commandId, {
              op: "pm",
              device: "self",
              pmId: pm1Id,
              text: `并发子任务 ${i}`,
            }),
          ),
        );
        emit({ type: "turn.ended", ok: true, interrupted: false, messageIds: input.messageIds, durationMs: 5, at: Date.now() });
      };
      const cmd = await dispatcher.submitCommand({ clientId: "cid-concurrent-cap", text: "并发拆很多条" });
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(8);
      expect(cmd.dispatched).toHaveLength(8);
    });

    it("close() 打断在途规划、等它收尾再返回；关闭后新指令直接标失败，不挂在 planning", async () => {
      const d = makeDispatcher({ agentTimeoutMs: 60_000 });
      driver.onTurn = async () => {
        // 不结束本轮，等 close
      };
      const pending = d.submitCommand({ clientId: "cid-close-mid", text: "关闭时还在规划" });
      await new Promise((r) => setTimeout(r, 20));
      await d.close();
      const cmd = await pending;
      expect(cmd.status).toBe("failed");
      expect(cmd.error).toContain("关闭");
      expectAssistantRowsSettled(db);

      const after = await d.submitCommand({ clientId: "cid-after-close", text: "关了以后发的" });
      expect(after.status).toBe("failed");
      expect(ledger.getRouterCommand(after.id)?.status).toBe("failed");
    });
  });

  describe("临时 assistant 会话号只增不退（不复用驱动层已 end 过的号）", () => {
    it("连续 3 条轨道 B 指令：每条分配的会话号严格递增，全部成功，库里 assistant 行不超过 1 行", async () => {
      const results: RouterCommandRecord[] = [];
      for (let i = 0; i < 3; i++) {
        results.push(await dispatcher.submitCommand({ clientId: `cid-seq-${i}`, text: `第 ${i} 条规划` }));
        expectAssistantRowsSettled(db);
      }
      expect(results.map((r) => r.status)).toEqual(["answered", "answered", "answered"]);
      expect(driver.started).toHaveLength(3);
      for (let i = 1; i < driver.started.length; i++) {
        expect(driver.started[i]!).toBeGreaterThan(driver.started[i - 1]!);
      }
    });

    it("一条轨道 B 指令后紧接着新建项目经理：拿到的号严格大于刚结束的 assistant 号，能正常起会话，下一条指令也成功", async () => {
      const first = await dispatcher.submitCommand({ clientId: "cid-before-pm", text: "先规划一条" });
      expect(first.status).toBe("answered");
      const assistantId = driver.ended.at(-1)!;

      const pm = ledger.createPm({ name: "后建的PM", mode: "manage_only", vendor: "claude", persona: "测试" });
      expect(pm.sessionId).toBeGreaterThan(assistantId);
      await expect(driver.start(pm.sessionId)).resolves.toBeUndefined();

      const second = await dispatcher.submitCommand({ clientId: "cid-after-pm", text: "再规划一条" });
      expect(second.status).toBe("answered");
      expect(driver.started.at(-1)!).toBeGreaterThan(pm.sessionId);
      expectAssistantRowsSettled(db);
    });

    it("重启恢复后：新建会话的号依然严格递增，不撞驱动层已 end 过的号", async () => {
      await dispatcher.submitCommand({ clientId: "cid-pre-restart-1", text: "重启前 1" });
      await dispatcher.submitCommand({ clientId: "cid-pre-restart-2", text: "重启前 2" });
      const maxEnded = Math.max(...driver.ended);

      ledger.recoverAfterRestart();
      expectAssistantRowsSettled(db);

      const after = await dispatcher.submitCommand({ clientId: "cid-post-restart", text: "重启后" });
      expect(after.status).toBe("answered");
      expect(driver.started.at(-1)!).toBeGreaterThan(maxEnded);
      const pm = ledger.createPm({ name: "重启后PM", mode: "manage_only", vendor: "claude", persona: "测试" });
      expect(pm.sessionId).toBeGreaterThan(driver.started.at(-1)!);
    });
  });
  describe("v2 后端契约（docs/router-workbench-v2-design.md 第 3.2 节）", () => {
    it("2,000 字回复原样入库，多段文字之间是空行，不截断也不标 replyTruncated", async () => {
      const long = "长".repeat(2_000);
      driver.onTurn = answerTurn("**本机**状态如下：", long);
      const cmd = await dispatcher.submitCommand({ clientId: "cid-reply-long", text: "现在谁在干活？" });
      expect(cmd.status).toBe("answered");
      expect(cmd.plan?.reply).toBe(`**本机**状态如下：\n\n${long}`);
      expect(cmd.plan?.replyTruncated).toBeUndefined();
    });

    it("超过 ROUTER_REPLY_MAX_CHARS 才截，截了标 replyTruncated，不悄悄拼省略号", async () => {
      driver.onTurn = answerTurn("答".repeat(ROUTER_REPLY_MAX_CHARS + 500));
      const cmd = await dispatcher.submitCommand({ clientId: "cid-reply-over", text: "说个很长的" });
      expect([...cmd.plan!.reply]).toHaveLength(ROUTER_REPLY_MAX_CHARS);
      expect(cmd.plan!.reply.endsWith("…")).toBe(false);
      expect(cmd.plan?.replyTruncated).toBe(true);
    });

    it("显式 target 落进 plan.target；整条重跑带回目标，仍走轨道 A（0 次模型调用）", async () => {
      remoteRegistered = false;
      const failed = await dispatcher.submitCommand({
        clientId: "cid-target-retry",
        text: "重启训练队列",
        target: { deviceId: "dev-linux", pmId: 20 },
      });
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain("找不到目标设备");
      expect(failed.plan?.target).toEqual({ deviceId: "dev-linux", pmId: 20 });
      expect(failed.plan?.retryOps ?? []).toHaveLength(0);

      remoteRegistered = true;
      const retried = await dispatcher.retryCommand(failed.id);
      expect(driver.started).toHaveLength(0);
      expect(retried.status).toBe("dispatched");
      expect(retried.plan?.track).toBe("A");
      expect(retried.plan?.target).toEqual({ deviceId: "dev-linux", pmId: 20 });
      expect(retried.plan?.reply).toBe("");
      expect(remoteOps).toEqual([expect.objectContaining({ kind: "pm.forward", pmId: 20, text: "重启训练队列" })]);

      // 网页 @ 候选里本机的 deviceId 可能是 "local"、"" 或省略：都走本机轨道 A
      for (const [i, deviceId] of ["local", "", undefined].entries()) {
        const localCmd = await dispatcher.submitCommand({
          clientId: `cid-local-target-${i}`,
          text: `本机直转 ${i}`,
          target: { ...(deviceId !== undefined ? { deviceId } : {}), pmId: pm1Id },
        });
        expect(localCmd.status).toBe("dispatched");
        expect(localCmd.plan?.track).toBe("A");
        expect(localCmd.dispatched?.[0]).toMatchObject({ deviceId: "dev-local", pmId: pm1Id, ok: true });
      }
    });

    it("带附件的指令：plan.attachments 有编号、文件名、类型、大小，轨道 B 收尾和重试后都还在", async () => {
      const att = await saveUpload(uploadsDir, "spec.md", Buffer.from("# Design"));
      const expected = [{ id: att.id, name: "spec.md", mime: att.mime, size: 8 }];
      driver.onTurn = async ({ emit, input }) => {
        emit({ type: "turn.ended", ok: false, interrupted: false, messageIds: input.messageIds, durationMs: 5, at: Date.now(), error: { subtype: "error_during_execution", message: "boom" } });
      };
      const failed = await dispatcher.submitCommand({ clientId: "cid-att-meta", text: "看看这个文件", attachmentIds: [att.id] });
      expect(failed.status).toBe("failed");
      expect(failed.plan?.attachments).toEqual(expected);
      expect(failed.plan?.attachmentIds).toEqual([att.id]);

      driver.onTurn = answerTurn("文件收到了");
      const retried = await dispatcher.retryCommand(failed.id);
      expect(retried.status).toBe("answered");
      expect(retried.plan?.attachments).toEqual(expected);
    });

    it("非预期异常：error 是人话，原文进 plan.errorRaw；已是人话的目标错误照旧，不带 errorRaw", async () => {
      driver.start = async () => {
        throw new DriverError("session_ended", "session 512 has been ended");
      };
      const cmd = await dispatcher.submitCommand({ clientId: "cid-raw-error", text: "现在谁在干活？" });
      expect(cmd.status).toBe("failed");
      expect(cmd.plan?.errorRaw).toBe("session_ended: session 512 has been ended");
      expect(cmd.error).not.toMatch(/session|ended/);
      expect(cmd.error).toMatch(/[\u4e00-\u9fff]/);
      expect(cmd.plan?.reply).not.toContain("session 512");

      remoteOnline = false;
      const offline = await dispatcher.submitCommand({ clientId: "cid-human-error", text: "@LinuxBox/gpu-worker 跑基准" });
      expect(offline.status).toBe("failed");
      expect(offline.error).toContain("离线");
      expect(offline.plan?.errorRaw).toBeUndefined();
    });

    it("轨道 B 的厂商失败原文进 errorRaw，error 是人话", async () => {
      driver.onTurn = async ({ emit, input }) => {
        emit({ type: "turn.ended", ok: false, interrupted: false, messageIds: input.messageIds, durationMs: 5, at: Date.now(), error: { subtype: "error_during_execution", message: "TypeError: Cannot read properties of undefined" } });
      };
      const cmd = await dispatcher.submitCommand({ clientId: "cid-vendor-raw", text: "现在谁在干活？" });
      expect(cmd.status).toBe("failed");
      expect(cmd.plan?.errorRaw).toBe("error_during_execution: TypeError: Cannot read properties of undefined");
      expect(cmd.error).not.toContain("TypeError");
    });
  });
});

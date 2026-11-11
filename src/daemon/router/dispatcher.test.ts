import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveUpload } from "../uploads.ts";
import {
  createSessionTokens,
} from "../agent-api/tokens.ts";
import { createLedger, type SqliteLedger } from "../ledger/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { Db } from "../store/db.ts";
import {
  bundledModelCatalog,
  vendorSpec,
  type Driver,
  type DriverEvent,
  type DriverEventListener,
  type DriverSendInput,
  type DriverSendResult,
  type ModelCatalog,
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
    this.started.push(sessionId);
  }

  async send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult> {
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

const CLAUDE_ROUTER_PRESET = vendorSpec("claude").models.routerDefault;

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
        if (deviceId === "dev-linux") return remotePort;
        return null;
      },
      listPorts(): RouterTargetPort[] {
        return [localPort, remotePort];
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
    const leftoverAssistants = db.all("SELECT id FROM agent_sessions WHERE role = 'assistant'");
    expect(leftoverAssistants).toHaveLength(0);
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
    expect(db.all("SELECT id FROM agent_sessions WHERE role = 'assistant'")).toHaveLength(0);
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
});

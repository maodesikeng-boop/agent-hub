import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeviceInfo } from "../../shared/index.ts";
import { PEER_DEVICE_HEADER, ROUTER_PEER_DIGEST_TTL_MS, ROUTER_PEER_OFFLINE_BACKOFF_MS } from "../../shared/index.ts";
import { createResolveFolder } from "../ledger/files.ts";
import { createLedger, type SqliteLedger } from "../ledger/index.ts";
import type { ProxyTarget } from "../peers/proxy.ts";
import { PEER_UNAUTHORIZED } from "../peers/service.ts";
import { openDatabase, type Db } from "../store/db.ts";
import { migrate } from "../store/migrate.ts";
import { saveUpload } from "../uploads.ts";
import {
  RouterTargetError,
  createLocalTargetPort,
  createRouterTargetRegistry,
} from "./target-port.ts";

let root: string;
let db: Db;
let ledger: SqliteLedger;
let uploadsDir: string;
let now: number;
let linPmId: number;
let alphaProjectId: number;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-target-port-")));
  const dataHome = join(root, ".agent-hub");
  uploadsDir = join(dataHome, "uploads");
  mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  now = 50_000;

  db = openDatabase(join(root, "hub.sqlite"));
  migrate(db);
  ledger = createLedger(db, {
    now: () => now,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    worktreesDir: join(dataHome, "worktrees"),
    uploadsDir,
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
  });

  const folderA = join(root, "work", "alpha");
  mkdirSync(folderA, { recursive: true });
  const created = ledger.createPm({
    name: "小林",
    mode: "manage_only",
    persona: "负责后端",
    folder: folderA,
  });
  linPmId = created.pm.id;
  alphaProjectId = created.project!.id;
});

afterEach(() => {
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("RouterTargetPort：本机账本与跨设备隧道代理统一端口", () => {
  it("LocalTargetPort 原样转发文本与已上传附件引用（支持按 pmId 或 projectId 寻址、clientId 幂等），并支持启动/操作 Worker 与建项目", async () => {
    const att = await saveUpload(uploadsDir, "error-log.txt", Buffer.from("stack trace line 1\n"));
    const localPort = createLocalTargetPort({
      deviceId: "00000000-0000-4000-8000-000000000001",
      deviceName: () => "MacBook",
      ledger,
      uploadsDir,
      probeWorkspace: async () => ({ kind: "ok", isRepoWithCommit: false, hasUncommittedChanges: false }),
    });

    const digestRes = await localPort.getDigest();
    expect(digestRes.online).toBe(true);
    expect(digestRes.digest?.pms).toHaveLength(1);

    // 1. 原样转发文本 + 附件（零改写）
    const rawText = "请紧急看下第 42 行报错：\n```ts\nthrow new Error('boom')\n```";
    const delivered = await localPort.executeOp({
      kind: "pm.forward",
      clientId: "fwd-local-1",
      projectId: alphaProjectId,
      text: rawText,
      attachmentIds: [att.id],
    });
    expect(delivered.kind).toBe("pm.forward");
    if (delivered.kind === "pm.forward") {
      expect(delivered.pmId).toBe(linPmId);
      const msg = ledger.getMessage(delivered.messageId)!;
      expect(msg.text).toBe(rawText);
      expect(msg.meta).toMatchObject({
        attachments: [{ id: att.id, name: "error-log.txt", path: att.path }],
      });

      // 相同 clientId 幂等：返回同一 messageId
      const dup = await localPort.executeOp({
        kind: "pm.forward",
        clientId: "fwd-local-1",
        pmId: linPmId,
        text: rawText,
        attachmentIds: [att.id],
      });
      expect(dup).toEqual(delivered);
    }

    // 2. 直接启动 Worker 并记录 router_worker_origins
    const cmd = ledger.createRouterCommand({
      clientId: "origin-cmd-1",
      inputText: "直接派只读 Worker 查慢 SQL",
      vendor: "claude",
      status: "planning",
    }).command;

    const started = await localPort.executeOp({
      kind: "worker.start",
      clientId: "ws-local-1",
      projectId: alphaProjectId,
      title: "排查慢 SQL",
      task: "检查索引缺失情况",
      attachmentIds: [att.id],
      readonly: true,
      noWorktree: true,
      sourceCommandId: cmd.id,
    });
    expect(started.kind).toBe("worker.start");
    if (started.kind === "worker.start") {
      expect(started.readonly).toBe(true);
      const originRow = db.get<{ worker_id: number; source_id: number }>(
        "SELECT worker_id, source_id FROM router_worker_origins WHERE worker_id = ?",
        started.workerId,
      );
      expect(originRow).toEqual({ worker_id: started.workerId, source_id: cmd.id });

      const listed = await localPort.executeOp({ kind: "worker.list", projectId: alphaProjectId });
      expect(listed.kind).toBe("worker.list");
      if (listed.kind === "worker.list") {
        expect(listed.workers.some((w) => w.id === started.workerId)).toBe(true);
      }

      const ended = await localPort.executeOp({ kind: "worker.end", workerId: started.workerId });
      expect(ended.kind).toBe("worker.end");
    }

    // 3. 新建项目与 PM
    const newFolder = join(root, "work", "gamma");
    mkdirSync(newFolder, { recursive: true });
    const createdProj = await localPort.executeOp({
      kind: "project.create",
      clientId: "proj-local-1",
      folder: newFolder,
      name: "网关服务",
      pmName: "阿凯",
      mode: "hands_on",
    });
    expect(createdProj).toMatchObject({
      kind: "project.create",
      pmName: "阿凯",
      projectName: "网关服务",
    });
  });

  it("PeerTargetPort 遵守缓存 4 条军规：Digest 10s 缓存与移除即刻失效、离线 5s 短暂退避、跨机流式上传附件后原样投递、超时/离线返回结构化中文错误", async () => {
    const selfId = "00000000-0000-4000-8000-000000000001";
    const remoteId = "00000000-0000-4000-8000-000000000002";
    let peerOnline = true;
    let peerHang = false;
    let peerUnauth = false;
    let pairedDevices: DeviceInfo[] = [
      { id: selfId, name: "MacBook", platform: "darwin", self: true, url: null },
      { id: remoteId, name: "Linux 工作站", platform: "linux", self: false, url: "https://linux.ts.net" },
    ];
    const remoteTargets = new Map<string, ProxyTarget>([
      [
        remoteId,
        {
          name: "Linux 工作站",
          url: "https://linux.ts.net",
          token: "peer-secret-token",
        },
      ],
    ]);

    let digestFetchCount = 0;
    const uploadedFiles: Array<{ name: string; body: string; headers: Record<string, string> }> = [];
    const targetOpsReceived: unknown[] = [];
    let forgottenId: string | null = null;

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (peerHang) {
        await new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      if (!peerOnline) {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }
      if (peerUnauth) {
        return new Response(JSON.stringify({ code: PEER_UNAUTHORIZED, error: PEER_UNAUTHORIZED }), { status: 401 });
      }
      if (url.endsWith("/api/router/digest")) {
        digestFetchCount += 1;
        return new Response(
          JSON.stringify({
            generatedAt: now,
            pms: [
              {
                pmId: 7,
                name: "远端小林",
                mode: "manage_only",
                vendor: "claude",
                model: null,
                conversationId: 70,
                activity: "idle",
                project: { id: 3, name: "推理引擎", description: null, mainFolder: "/srv/infer", otherFolders: [] },
                personaSummary: "负责 GPU 推理",
                pmNote: null,
                activeWorkers: [],
                activeWorkerTotal: 0,
                pendingDecisionCount: 0,
                recentBrief: null,
                lastActiveAt: now,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/uploads")) {
        const parsedUrl = new URL(url);
        const rawBytes = init?.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.from(String(init?.body ?? ""));
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        uploadedFiles.push({
          name: parsedUrl.searchParams.get("name") ?? "",
          body: rawBytes.toString("utf8"),
          headers: hdrs,
        });
        return new Response(
          JSON.stringify({
            attachment: {
              id: "aaaa1111bbbb2222",
              name: parsedUrl.searchParams.get("name") ?? "file",
              path: "/remote/uploads/aaaa1111bbbb2222/spec.md",
              size: rawBytes.length,
              mime: "application/octet-stream",
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/router/target-ops")) {
        const parsed = JSON.parse(String(init?.body ?? "{}"));
        targetOpsReceived.push(parsed);
        return new Response(
          JSON.stringify({
            result: {
              kind: "pm.forward",
              pmId: 7,
              pmName: "远端小林",
              projectId: 3,
              projectName: "推理引擎",
              conversationId: 70,
              messageId: 888,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const localPort = createLocalTargetPort({
      deviceId: selfId,
      deviceName: () => "MacBook",
      ledger,
      uploadsDir,
    });

    const registry = createRouterTargetRegistry({
      localPort,
      peers: {
        selfId,
        list: () => pairedDevices,
        target: (id) => remoteTargets.get(id) ?? null,
        forget: (id) => {
          forgottenId = id;
          remoteTargets.delete(id);
        },
      },
      uploadsDir,
      fetch: fakeFetch,
      now: () => now,
      peerDigestTimeoutMs: 60,
      peerDispatchTimeoutMs: 80,
    });

    // 1. 远端 Digest 10s 缓存命中
    const rPort = registry.portFor(remoteId)!;
    const d1 = await rPort.getDigest();
    expect(d1.online).toBe(true);
    expect(digestFetchCount).toBe(1);

    now += 2_000;
    const d2 = await rPort.getDigest();
    expect(d2.digest).toBe(d1.digest);
    expect(digestFetchCount).toBe(1);

    // 超过 10s TTL 重新拉取
    now += ROUTER_PEER_DIGEST_TTL_MS + 1;
    await rPort.getDigest();
    expect(digestFetchCount).toBe(2);

    // 2. 跨机上传附件并原样投递给远端 PM
    const localAtt = await saveUpload(uploadsDir, "spec.md", Buffer.from("# 设计原稿\n零改写直达"));
    const fwdRes = await rPort.executeOp({
      kind: "pm.forward",
      clientId: "remote-fwd-1",
      pmId: 7,
      text: "请照这份附件实现",
      attachmentIds: [localAtt.id],
    });
    expect(fwdRes).toMatchObject({ kind: "pm.forward", pmId: 7, messageId: 888 });
    expect(uploadedFiles).toHaveLength(1);
    expect(uploadedFiles[0]).toMatchObject({
      name: "spec.md",
      body: "# 设计原稿\n零改写直达",
    });
    expect(uploadedFiles[0]!.headers[PEER_DEVICE_HEADER]).toBe(selfId);
    expect(uploadedFiles[0]!.headers.authorization).toBe("Bearer peer-secret-token");
    expect(targetOpsReceived[0]).toMatchObject({
      kind: "pm.forward",
      pmId: 7,
      text: "请照这份附件实现",
      attachmentIds: ["aaaa1111bbbb2222"],
    });

    // 3. 远端离线：5s 短暂负向退避（不当正常结果缓存几分钟），且 executeOp 返回人话中文错误
    now += ROUTER_PEER_DIGEST_TTL_MS + 100;
    peerOnline = false;
    const offDigest = await rPort.getDigest();
    expect(offDigest.online).toBe(false);
    expect(offDigest.error).toContain("Linux 工作站");
    const countAfterFail = digestFetchCount;

    // 2 秒内命中负向退避，不风暴重试
    now += 2_000;
    await rPort.getDigest();
    expect(digestFetchCount).toBe(countAfterFail);

    // 超过 5 秒退避后恢复在线，立刻拉取成功！
    now += ROUTER_PEER_OFFLINE_BACKOFF_MS + 100;
    peerOnline = true;
    const recoveredDigest = await rPort.getDigest();
    expect(recoveredDigest.online).toBe(true);

    // 4. executeOp 离线与超时的人话结构化错误
    peerOnline = false;
    await expect(
      rPort.executeOp({ kind: "pm.forward", clientId: "off-1", pmId: 7, text: "hi" }),
    ).rejects.toMatchObject({
      name: "RouterTargetError",
      code: "device_offline",
      message: expect.stringContaining("Linux 工作站"),
    });

    peerOnline = true;
    peerHang = true;
    await expect(
      rPort.executeOp({ kind: "pm.forward", clientId: "hang-1", pmId: 7, text: "hi" }),
    ).rejects.toMatchObject({
      name: "RouterTargetError",
      code: "device_timeout",
      message: expect.stringContaining("超时"),
    });
    peerHang = false;

    // 5. 对端返回 401 peer_unauthorized 时自动 forget 并清除缓存
    peerUnauth = true;
    await expect(
      rPort.executeOp({ kind: "pm.forward", clientId: "unauth-1", pmId: 7, text: "hi" }),
    ).rejects.toBeInstanceOf(RouterTargetError);
    expect(forgottenId).toBe(remoteId);

    // 6. 设备从配对列表移除时缓存立即失效
    pairedDevices = [{ id: selfId, name: "MacBook", platform: "darwin", self: true, url: null }];
    expect(registry.portFor(remoteId)).toBeNull();
  });
});

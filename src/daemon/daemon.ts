// Startup and shutdown order lives only in this file; shutdown unwinds exactly as far as startup got.
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import {
  AGENT_API_CLOSE_MS,
  LEDGER_SETTLE_ON_SHUTDOWN_MS,
  API_PATHS,
  DEFAULT_PM_MODE,
  DEFAULT_UI_PORT,
  DEFAULT_AGENT_VENDOR,
  ENV_DB_SHARED_ACCESS,
  ENV_DEFAULT_MODEL,
  ENV_GITHUB_CLIENT_ID,
  ENV_PORT,
  ENV_RELAY_URL,
  EXECUTOR_STOP_GRACE_MS,
  FEISHU_CONTROL_RETRY_MS,
  HANDOVER_STOP_GRACE_MS,
  LedgerRequestError,
  MAX_VENDOR_SYNC_PROJECT_FOLDERS,
  MESH_DEFAULT_RELAY_URL,
  MESH_GITHUB_CLIENT_ID,
  PM_ARCHIVE_CLEANUP_INTERVAL_MS,
  SCHEDULER_TICK_MS,
  AUTO_RENEW_TICK_MS,
  checkModel,
  type ActionExecutor,
  type Driver,
  type Unsubscribe,
  AGENT_VENDORS,
  isAgentVendor,
  vendorFailureOf,
  vendorSpec,
  type AgentVendor,
} from "../shared/index.ts";
import type { HubPaths } from "../shared/paths.ts";
import { LOG_PREFIX } from "../shared/names.ts";
import { startWorkerRetention } from "./db-retention.ts";
import { createBusySessions, createSelfReload, createStagedWebBuild, describeSelfReload, type SelfReloadController } from "./self-reload.ts";
import { describeBusySessionsForReload } from "./self-reload-busy.ts";
import { startFileCleanup } from "./file-cleanup.ts";
import { createDaemonSessionScope } from "./session-tmp.ts";
import { createHandoverRunner, type HandoverRunner } from "./handover/runner.ts";
import { startWorktreeCleanup, type WorktreeCleanup } from "./worktree-cleanup.ts";
import { createSessionProcessReaper, startDaemonResources, type DaemonResourcesHandle } from "./resources/index.ts";
import {
  projectWorktreesDir,
  resolveHubPaths,
  workerSetupLogPath,
  workerWorktreePath,
} from "../shared/paths.ts";
import { createActionExecutor } from "./actions/index.ts";
import { createProcessLedger, installProcessLedger } from "./process-ledger.ts";
import { createCommandCatalogs, type CommandCatalogs } from "./commands-catalog.ts";
import { createComposerService } from "./composer.ts";
import {
  createManagedProviderSecrets,
  createProviderManager,
  createVendorRuntimeResolver,
  type ProviderManager,
} from "./provider-manager/index.ts";
import { createVendorSyncService } from "./vendor-sync/index.ts";
import { createCapabilityInventory } from "./pm-capabilities/inventory.ts";
import {
  DAEMON_VENDORS,
  createVendorCatalogSources,
  createVendorDrivers,
  type VendorCatalogSourceOptions,
  type VendorComposer,
  type VendorDriverDeps,
} from "./vendors/index.ts";
import { createWorkspaceFiles } from "./workspace-files.ts";
import { createSessionTokens, installHubShim, startAgentApi, type RunningAgentApi } from "./agent-api/index.ts";
import {
  createModelCatalogs,
  createMultiVendorDriver,
  type ModelCatalogs,
} from "./driver/index.ts";
import { addWorktree, probeDiffNumstat, probePr, remoteBranchHead, resolveBranchTip, resolveCommit, syncWorktreeBranch } from "./git/index.ts";
import { createWorktreeBranchProbe } from "./git/worktree-branch.ts";
import { createObservedQuotaStore, observeDriverQuota } from "./quota/observed-quota.ts";
import { createProviderQuota } from "./quota/provider-quota.ts";
import { vendorTranscriptPath } from "./driver/transcript.ts";
import type { LedgerOptions } from "./ledger/ledger.ts";
import {
  createSessionEndHandler,
  createSessionSendHandler,
  createSessionStartHandler,
  createReviewObserver,
  createReviewVerifyHandler,
  canDeliverSystemMessage,
  createWorktreeCreateHandler,
  createWorktreeSyncHandler,
  endedOnRevokedTokens,
} from "./handlers.ts";
import { createLaunchPreparer, createPersonaNoter } from "./launch.ts";
import { createProjectCatalogRunner, type ProjectCatalogRunner } from "./project-catalog/runner.ts";
import { resolveRouterModel } from "./router/model-resolver.ts";
import { createRouterTurnPurposes, createRouterTurnRunner } from "./router/single-turn.ts";
import { createLedger, type SqliteLedger } from "./ledger/index.ts";
import { DEFAULT_PM_NAME } from "./prompt.ts";
import { prepareSentFilesDir } from "./sent-files.ts";
import { resolveUpload } from "./uploads.ts";
import { createWatchCommandRunner } from "./watches/launch.ts";
import { createWatchRunner, type WatchRunner } from "./watches/runner.ts";
import { createSetupRunner, type SetupRunner } from "./setup/index.ts";
import { createSkillFiles } from "./skill-files.ts";
import { DaemonAlreadyRunningError, acquireLock, createSessionStore, openStore, type Db, type DirLock } from "./store/index.ts";
import { StartupError } from "./startup-error.ts";
import { loadOrCreateUiToken, loginUrl, rotateUiToken, startUiServer, type RunningUiServer } from "./ui-server/index.ts";
import type { FolderPicker } from "./pick-folder.ts";
import { defaultDeviceName, loadOrCreateDevice, saveDevice } from "./device.ts";
import { createPeers, type Peers } from "./peers/index.ts";
import { AdminSocketInsecureError, startAdminSocket, type RunningAdminSocket } from "./admin/socket.ts";
import { createMesh, type Mesh, type MeshOptions } from "./mesh/index.ts";
import { meshListenPort } from "./mesh/listen-port.ts";
import { createPushService } from "./push/index.ts";
import {
  createFeishuAccountBot,
  createFeishuOfflineInbox,
  feishuPeerAppSyncSchema,
  type FeishuAccountBot,
  type FeishuPeerAppSync,
} from "./feishu/account-bot.ts";
import { createFeishuLease, createFeishuPeerCheckpointPort } from "./feishu/mesh.ts";
import { createFeishuService, type FeishuService, type FeishuServiceOptions } from "./feishu/service.ts";
import { createFeishuStore } from "./feishu/store.ts";
import {
  createLocalTargetPort,
  createRouterDispatcher,
  createRouterSandboxGuard,
  createRouterTargetRegistry,
  type RouterDispatcher,
  type RouterSandboxGuard,
  type RouterTargetRegistry,
} from "./router/index.ts";
import {
  allowWin32WorkerWorktreeAcl,
  createSleepInhibitor,
  denyWin32WorkerPipeAccess,
  ensureProjectWorktreeBridge,
  ensureWin32ProtectedRootAcl,
  hardenWin32PrivateDirAcl,
  isPathInsideOrEqual,
  loadManagedWorktreeRoots,
  normalizePathForComparison,
  selectWorktreeRootForProject,
  type SleepInhibitor,
} from "./platform/index.ts";

export const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../../dist/web", import.meta.url));
const REPO_DIR = fileURLToPath(new URL("../..", import.meta.url));
const SELF_RELOAD_BUILD_LOG = "self-reload-build.log";

export interface DaemonOptions {
  env?: Record<string, string | undefined>;
  userHome: string;
  staticDir?: string;
  log?: (line: string) => void;
  autoRenew?: LedgerOptions["autoRenew"];
  mesh?: Partial<Pick<MeshOptions, "relayUrl" | "githubClientId" | "listenPort" | "listenHost" | "candidates" | "allowLoopback" | "github" | "fetch">>;
  feishu?: Pick<FeishuServiceOptions, "createTransport" | "register">;
  onSelfReload?: () => void;
  selfReloadDrainMaxMs?: number;
  onExternalShutdown?: () => void;
  folderPicker?: FolderPicker;
}

export interface RunningDaemon {
  paths: HubPaths;
  port: number;
  url: string;
  stop(): Promise<void>;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_UI_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new StartupError("bad_port", `现在是 ${raw}`);
  return port;
}

async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line) => console.error(line));
  const paths = resolveHubPaths(env, options.userHome);
  const port = parsePort(env[ENV_PORT]);

  // Setup commands stop first because they never call back into the ledger; the agent API closes after all agents exit because a last turn may still call hub.
  const parts: {
    scheduler?: NodeJS.Timeout;
    autoRenew?: NodeJS.Timeout;
    archiveCleanup?: NodeJS.Timeout;
    worktreeCleanup?: WorktreeCleanup;
    resources?: DaemonResourcesHandle;
    handoverRunner?: HandoverRunner;
    catalogRunner?: ProjectCatalogRunner;
    setup?: SetupRunner;
    watches?: WatchRunner;
    executor?: ActionExecutor;
    driver?: Driver;
    providerManager?: ProviderManager;
    models?: ModelCatalogs;
    commands?: CommandCatalogs;
    routerDispatcher?: RouterDispatcher;
    routerTargetRegistry?: RouterTargetRegistry;
    feishuAccountBot?: FeishuAccountBot;
    feishu?: FeishuService;
    sandboxGuard?: RouterSandboxGuard;
    ui?: RunningUiServer;
    peers?: Peers;
    mesh?: Mesh;
    admin?: RunningAdminSocket;
    agentApi?: RunningAgentApi;
    ledger?: SqliteLedger;
    db?: Db;
    lock?: DirLock;
    uninstallProcessLedger?: () => void;
    stopFileCleanup?: () => void;
    stopWorkerRetention?: () => void;
    sleepInhibitor?: SleepInhibitor;
    selfReload?: SelfReloadController;
    unsubscribe: Unsubscribe[];
    quota?: ReturnType<typeof createProviderQuota>;
  } = { unsubscribe: [] };
  const step = async (what: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (error) {
      log(`${LOG_PREFIX} 关闭${what}时出错：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const shutdown = async () => {
    const { scheduler, autoRenew, archiveCleanup, worktreeCleanup, handoverRunner, setup, executor, driver, models, commands, ui, peers, mesh, admin, agentApi, db, lock } = parts;
    parts.selfReload?.close();
    parts.quota?.close();
    if (scheduler) clearInterval(scheduler);
    if (autoRenew) clearInterval(autoRenew);
    if (archiveCleanup) clearInterval(archiveCleanup);
    if (worktreeCleanup) await step("worktree 自动清理", () => worktreeCleanup.stop());
    if (parts.resources) await step("资源巡检", () => parts.resources!.stop());
    parts.sleepInhibitor?.stop();
    // Handover runners report aborts to the ledger, so they stop before the executor and the database.
    if (handoverRunner) {
      await step("后台写交接", async () => {
        if (!(await within(handoverRunner.stop(), HANDOVER_STOP_GRACE_MS))) throw new Error(`${HANDOVER_STOP_GRACE_MS / 1000} 秒没收完，不再等`);
      });
    }
    // Background handover writers report back to the ledger and end router sessions, so they stop before the driver and the database.
    if (parts.catalogRunner) {
      const catalogRunner = parts.catalogRunner;
      await step("后台写项目档案", async () => {
        if (!(await within(catalogRunner.stop(), HANDOVER_STOP_GRACE_MS))) throw new Error(`${HANDOVER_STOP_GRACE_MS / 1000} 秒没收完，不再等`);
      });
    }
    parts.stopFileCleanup?.();
    parts.stopWorkerRetention?.();
    if (setup) await step("准备命令", () => setup.shutdown());
    if (parts.watches) await step("后台盯的条件", () => parts.watches!.close());
    parts.feishuAccountBot?.close();
    if (parts.feishu) await step("飞书", () => parts.feishu!.close());
    if (parts.routerDispatcher) await step("总助分派引擎", () => parts.routerDispatcher!.close());
    if (executor) {
      await step("执行器", async () => {
        const stopped = executor.stop();
        // Actions may be waiting for claude to start; after a short wait the driver closes and they end with it.
        if (!(await within(stopped, EXECUTOR_STOP_GRACE_MS)) && driver) {
          await driver.shutdown();
          await stopped;
        }
      });
    }
    if (driver) await step("驱动层", () => driver.shutdown());
    if (parts.providerManager) await step("厂商安装与登录管理", () => parts.providerManager!.close());
    if (models) await step("模型名单", () => models.close());
    if (commands) await step("命令列表", () => commands.close());
    if (admin) await step("管理 socket", () => admin.close());
    // Stop peer requests and mesh links before the UI server, because the entry proxies through it.
    parts.routerTargetRegistry?.close();
    peers?.close();
    if (mesh) await step("账号组网", () => mesh.close());
    if (ui) await step("界面服务", () => ui.close());
    if (agentApi) {
      await step("agent 接口", async () => {
        if (!(await within(agentApi.close(), AGENT_API_CLOSE_MS))) throw new Error(`${AGENT_API_CLOSE_MS / 1000} 秒没关完，不再等`);
      });
    }
    parts.sandboxGuard?.clear();
    // All agents have exited; flush queued events whose reply attachments are still copying before closing the database.
    if (parts.ledger) {
      const ledger = parts.ledger;
      await step("账本事件", async () => {
        if (!(await within(ledger.settleDriverEvents(), LEDGER_SETTLE_ON_SHUTDOWN_MS))) {
          throw new Error(`${LEDGER_SETTLE_ON_SHUTDOWN_MS / 1000} 秒没落完，不再等`);
        }
      });
    }
    for (const off of parts.unsubscribe.splice(0)) off();
    if (db) await step("数据库", () => db.close());
    parts.uninstallProcessLedger?.();
    if (lock) await step("目录锁", () => lock.release());
  };

  try {
    parts.lock = acquireLock(paths.lockFile);
    // Reclaim children left by a crash, killing only recorded pids whose start time still matches.
    const processLedger = createProcessLedger({ file: paths.childProcessesFile, log });
    try {
      await processLedger.reapStale();
    } catch (error) {
      log(`${LOG_PREFIX} 回收上次残留的子进程出错：${error instanceof Error ? error.message : String(error)}`);
    }
    parts.uninstallProcessLedger = installProcessLedger(processLedger);
    const { db, migration, autoVacuum } = openStore(paths, { sharedAccess: env[ENV_DB_SHARED_ACCESS] === "1" });
    parts.db = db;
    const backupFile = autoVacuum.backupFile ?? migration.backupFile;
    if (autoVacuum.converted) {
      log(`${LOG_PREFIX} 账本数据库已改成增量回收模式（整库重建了一次${backupFile ? `，重建前的备份：${backupFile}` : ""}）`);
    } else if (autoVacuum.error !== undefined) {
      log(`${LOG_PREFIX} 账本数据库改成增量回收模式没成，本次跳过（不影响运行，下次启动再试）：${autoVacuum.error}`);
    }
    // Sandbox rules and git worktree list both use real paths (macOS /var is /private/var), so these directories are realpath'd once and shared.
    mkdirSync(paths.worktreesDir, { recursive: true });
    mkdirSync(paths.pmMemoryDir, { recursive: true, mode: 0o700 });
    // Agents receive upload paths under this real path, so it is realpath'd too.
    mkdirSync(paths.uploadsDir, { recursive: true, mode: 0o700 });
    const uploadsDir = realpathSync.native(paths.uploadsDir);
    prepareSentFilesDir(paths.sentFilesDir);
    const sentFilesDir = realpathSync.native(paths.sentFilesDir);
    parts.stopFileCleanup = startFileCleanup({ uploadsDir, sentFilesDir, setupLogsDir: paths.setupLogsDir, isWorkerOpen: (id) => db.get("SELECT 1 FROM workers WHERE id = ? AND status = 'open'", id) !== undefined }, log);
    const sessionScope = createDaemonSessionScope({ ledgerFile: paths.sessionTmpFile, env, log });
    const dataDir = realpathSync.native(paths.home);
    const stateDir = realpathSync.native(paths.stateDir);
    const worktreesDir = realpathSync.native(paths.worktreesDir);
    const pmMemoryDir = realpathSync.native(paths.pmMemoryDir);
    if (process.platform === "win32") {
      mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
      mkdirSync(paths.syncBackupsDir, { recursive: true, mode: 0o700 });
      try {
        await ensureWin32ProtectedRootAcl(stateDir, dataDir, { env });
        hardenWin32PrivateDirAcl(stateDir, stateDir, { env });
        hardenWin32PrivateDirAcl(stateDir, paths.runDir, { env });
        hardenWin32PrivateDirAcl(stateDir, dirname(paths.syncBackupsDir), { env });
      } catch (aclErr) {
        log(`${LOG_PREFIX} Windows 目录安全 ACL 初始化提示：${aclErr instanceof Error ? aclErr.message : String(aclErr)}`);
      }
    }
    const providerSecrets = createManagedProviderSecrets(paths.providerSecretsFile, {
      log: (line) => log(`${LOG_PREFIX} ${line}`),
    });
    const vendorRuntime = createVendorRuntimeResolver({
      paths,
      userHome: options.userHome,
      baseEnv: env,
      secrets: providerSecrets,
    });
    const dynamicExecutablePaths = Object.fromEntries(
      AGENT_VENDORS.map((vendor) => [vendor, () => vendorRuntime.resolveExecutablePath(vendor)]),
    ) as Record<AgentVendor, () => string>;
    const models = createModelCatalogs({
      sources: createVendorCatalogSources(
        Object.fromEntries(
          AGENT_VENDORS.map((vendor) => [
            vendor,
            {
              path: () => vendorRuntime.resolveExecutablePath(vendor),
              cwd: options.userHome,
              env: () => vendorRuntime.resolveVendorEnv(vendor),
              installed: () => vendorRuntime.installed(vendor),
              fingerprint: () => vendorRuntime.catalogFingerprint(vendor),
            },
          ]),
        ) as Record<AgentVendor, VendorCatalogSourceOptions>,
      ),
      log,
    });
    parts.models = models;
    const quota = createProviderQuota(vendorRuntime);
    const observedQuota = createObservedQuotaStore();
    parts.quota = quota;
    const providerManager = createProviderManager({
      runtime: vendorRuntime,
      models,
      onVendorChanged: (vendor) => { observedQuota.clearVendor(vendor); quota.refresh(vendor); },
      log: (line) => log(`${LOG_PREFIX} ${line}`),
    });
    parts.providerManager = providerManager;
    const device = loadOrCreateDevice(paths.deviceFile, defaultDeviceName(hostname()));
    const ledger = createLedger(db, {
      models, worktreeBranchProbe: createWorktreeBranchProbe(),
      deviceName: () => device.name,
      knownCommands: (session) => parts.commands?.cached(session) ?? null,
      pmHomeRoot: paths.pmHomeDir,
      personasDir: paths.personasDir,
      pmMemoryDir,
      dataHome: paths.home,
      worktreesDir,
      extraWorktreeRoots: () => loadManagedWorktreeRoots(stateDir, worktreesDir),
      launchDir: paths.launchDir,
      setupLogsDir: paths.setupLogsDir,
      uploadsDir,
      sentFilesDir,
      findTranscript: (ref) => vendorTranscriptPath(ref),
      skillFiles: createSkillFiles({ launchDir: paths.launchDir, userHome: options.userHome, env }),
      ...(options.autoRenew ? { autoRenew: options.autoRenew } : {}),
      onHandoverClaimable: () => parts.handoverRunner?.wake(),
      onCatalogClaimable: () => parts.catalogRunner?.wake(),
      isSessionBusy: (id) => parts.driver?.isBusy?.(id) ?? false,
      log,
    });
    parts.ledger = ledger;
    parts.unsubscribe.push(() => ledger.close());
    const sessions = createSessionStore(db);
    const sleepInhibitor = createSleepInhibitor();
    parts.sleepInhibitor = sleepInhibitor;
    const busySessions = createBusySessions();
    parts.unsubscribe.push(
      ledger.onChange((change) => {
        if (change.type === "session.status") sleepInhibitor.onSessionStatus(change.data.session);
        if (change.type === "session.status" || change.type === "session.created") busySessions.onSessionStatus(change.data.session);
      }),
    );
    const tokens = createSessionTokens();
    const sandboxGuard = createRouterSandboxGuard();
    parts.sandboxGuard = sandboxGuard;
    const routerTurnPurposes = createRouterTurnPurposes();
    const capabilityInventory = createCapabilityInventory({ ctx: { userHome: options.userHome ?? homedir(), env } });
    const agentApi = await startAgentApi({
      ledger,
      tokens,
      runDir: paths.runDir,
      hubSock: paths.hubSock,
      log,
      models, quota: { observed: observedQuota, get: quota.get },
      refreshVendor: (vendor) => models.ensureUsable(vendor),
      capabilityInventory,
      sandboxGuard,
      ...(options.onSelfReload
        ? {
            selfReload: ({ sessionId, build, cancel, status }: { sessionId: number; build: boolean; cancel?: boolean; status?: boolean }) => {
              if (!parts.selfReload) throw new LedgerRequestError("conflict", "守护进程还没启动完，稍后再试");
              if (status) {
                const current = parts.selfReload.status();
                const described = describeSelfReload(current);
                return { text: described === "" ? "当前没有进行中的热重启任务。" : described, data: current };
              }
              if (cancel) {
                const result = parts.selfReload.cancel({ by: `项目经理会话 ${sessionId}` });
                return { text: result.text, data: result.status };
              }
              const result = parts.selfReload.request({ build, by: `项目经理会话 ${sessionId}` });
              return { text: result.text, data: result.status };
            },
            selfReloadStatus: () => parts.selfReload?.status(),
          }
        : {}),
      onRouterDispatch: async (sessionId, commandId, payload) => {
        if (!parts.routerDispatcher) throw new LedgerRequestError("conflict", "总助分派引擎尚未就绪");
        return parts.routerDispatcher.handleAgentDispatch(sessionId, commandId, payload);
      },
    });
    parts.agentApi = agentApi;
    installHubShim({ binDir: paths.hubBinDir });
    const prepareLaunch = createLaunchPreparer({
      launchDir: paths.launchDir,
      dataDir,
      stateDir,
      worktreesDir,
      protectedRoots: () => loadManagedWorktreeRoots(stateDir, worktreesDir),
      getLaunchContext: (sessionId) => ledger.getLaunchContext(sessionId),
      tokens: endedOnRevokedTokens(tokens),
      // Real path written into HUB_SOCK and the settings allowUnixSockets.
      hubSock: agentApi.socketPath,
      hubBinDir: paths.hubBinDir,
      basePath: () => vendorRuntime.effectivePath(),
      vendorAvailability: () => Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, models.availability(vendor)])),
      routerPurposeOf: routerTurnPurposes.of,
      capabilityPolicies: ledger,
      capabilityInventory,
      sessionTmp: sessionScope.tmp, sessionTagNonce: sessionScope.tagNonce, parentSessionTag: sessionScope.parentTag,
    });
    const personaNote = createPersonaNoter((sessionId, since) => ledger.personaUpdate(sessionId, since), paths.launchDir);
    const launch = { appApprovals: ledger.appApprovals, canDeliverSystemMessage: canDeliverSystemMessage.bind(null, ledger), store: sessions, log, prepareLaunch, personaNote, pmMemoryDir, sessionPreamble: (sessionId: number) => ledger.sessionPreamble(sessionId), deliverySuffix: ledger.deliverySuffix, onSessionQuiescent: (sessionId: number) => ledger.onSessionQuiescent?.(sessionId) };
    const driver = createMultiVendorDriver({
      store: sessions,
      drivers: createVendorDrivers(
        Object.fromEntries(
          AGENT_VENDORS.map((vendor): [AgentVendor, VendorDriverDeps] => [
            vendor,
            {
              executablePath: () => vendorRuntime.resolveExecutablePath(vendor),
              env: () => vendorRuntime.resolveManagedDriverEnv(vendor),
              ...launch,
              ...(vendorSpec(vendor).capabilities.explicitDefaultModel
                ? {
                    defaultModel: async () => (await models.list({ vendor })).find((c) => c.vendor === vendor)?.defaultModelId ?? null,
                  }
                : {}),
            },
          ]),
        ) as Record<AgentVendor, VendorDriverDeps>,
      ),
    });
    parts.driver = driver;
    parts.unsubscribe.push(driver.onEvent((sessionId, event) => ledger.applyDriverEvent(sessionId, event)));
    const commands = createCommandCatalogs({
      vendors: Object.fromEntries(
        AGENT_VENDORS.map((vendor) => [
          vendor,
          DAEMON_VENDORS[vendor].createComposer({
            executablePath: () => vendorRuntime.resolveExecutablePath(vendor),
            env: () => vendorRuntime.resolveVendorEnv(vendor),
          }),
        ]),
      ) as Record<AgentVendor, VendorComposer>,
      queryRunning: (sessionId) => driver.queryCommands(sessionId),
      log,
    });
    parts.commands = commands;
    parts.unsubscribe.push(
      driver.onEvent((sessionId, event) => {
        if (event.type !== "commands.changed") return;
        const session = sessions.get(sessionId);
        if (session) commands.update(session, event.commands);
      }),
    );
    parts.unsubscribe.push(
      driver.onEvent((sessionId, event) => {
        const vendor = sessions.get(sessionId)?.vendor;
        if (!isAgentVendor(vendor)) return;
        observeDriverQuota(observedQuota, vendor, event);
        if (event.type === "session.started") models.report(vendor, "available");
        else if (event.type === "turn.ended" && !event.ok && event.error && vendorFailureOf(event.error.message, vendor)?.kind === "auth") {
          models.report(vendor, "signed_out");
        }
      }),
    );

    await driver.cleanupStale();
    void sessionScope.sweepStartupOrphans(db);
    const recovered = ledger.recoverAfterRestart();
    if (recovered.resentMessageIds.length + recovered.requeuedMessageIds.length > 0) {
      log(`${LOG_PREFIX} 重启恢复：重发 ${recovered.resentMessageIds.length} 条，补发排队中的 ${recovered.requeuedMessageIds.length} 条`);
    }
    const synced = ledger.syncPersonaFiles();
    if (synced.recordedPmIds.length > 0) log(`${LOG_PREFIX} 发现 ${synced.recordedPmIds.length} 个手改过的性格设定文件，已记下修改`);
    if (db.get("SELECT 1 AS x FROM pms LIMIT 1") === undefined) {
      let defaultModel = env[ENV_DEFAULT_MODEL]?.trim() || undefined;
      const badModel = defaultModel === undefined ? null : checkModel(DEFAULT_AGENT_VENDOR, defaultModel);
      if (badModel !== null) {
        log(`${LOG_PREFIX} ${ENV_DEFAULT_MODEL}=${JSON.stringify(defaultModel)} 不能用（${badModel}），项目经理按默认模型建`);
        defaultModel = undefined;
      }
      const { pm } = ledger.createPm({ name: DEFAULT_PM_NAME, mode: DEFAULT_PM_MODE, persona: "", ...(defaultModel ? { defaultModel } : {}) });
      log(`${LOG_PREFIX} 第一次启动，建了项目经理“${pm.name}”`);
    }

    const executor = createActionExecutor(db, ledger);
    const setup = createSetupRunner({ log });
    parts.setup = setup;
    const sessionProcesses = createSessionProcessReaper({ db, tagNonce: sessionScope.tagNonce, ownerTag: sessionScope.ownerTag, sessionTmp: sessionScope.tmp });
    const deps = { driver, ledger, sessions, tokens, setup, probeDiffNumstat, probePr, sessionTmp: sessionScope.tmp, reapSessionProcesses: sessionProcesses.reapSession };
    executor.register("session.start", createSessionStartHandler(deps));
    executor.register("session.send", createSessionSendHandler(deps));
    executor.register("session.end", createSessionEndHandler(deps));
    const observeReview = createReviewObserver({ resolveCommit, remoteBranchHead, probePr });
    executor.register("review.verify", createReviewVerifyHandler({ ledger, observeReview }));
    executor.register("worktree.sync", createWorktreeSyncHandler({ ledger, syncWorktree: syncWorktreeBranch }));
    executor.register("worktree.create", createWorktreeCreateHandler({
        ledger, resolveTip: resolveBranchTip, probePr, addWorktree, setup,
        setupLogPath: (workerId) => workerSetupLogPath(paths.setupLogsDir, workerId),
        sessionTmp: sessionScope.tmp,
        sessionTagEnv: sessionScope.ownerEnv,
        resolveWorktreePlacement: async ({ workerId, sessionId, repo, worktreePath }) => {
          let targetPath = worktreePath;
          if (isPathInsideOrEqual(worktreesDir, worktreePath)) {
            const selected = await selectWorktreeRootForProject({
              projectFolder: repo,
              dataDir,
              defaultWorktreesDir: worktreesDir,
              stateDir,
              log,
              ...(process.platform === "win32"
                ? { protectRoot: (sDir: string, root: string) => ensureWin32ProtectedRootAcl(sDir, root, { env }) }
                : {}),
            });
            if (normalizePathForComparison(selected.root) !== normalizePathForComparison(worktreesDir)) {
              const projectRow = db.get<{ project_id: number }>("SELECT project_id FROM workers WHERE id = ?", workerId);
              if (projectRow) {
                const actualProjDir = projectWorktreesDir(selected.root, projectRow.project_id);
                const defaultProjDir = projectWorktreesDir(worktreesDir, projectRow.project_id);
                ensureProjectWorktreeBridge(defaultProjDir, actualProjDir);
                targetPath = workerWorktreePath(selected.root, projectRow.project_id, workerId);
                const nowMs = Date.now();
                db.run("UPDATE workers SET worktree_path = ?, updated_at = ? WHERE id = ?", targetPath, nowMs, workerId);
                db.run("UPDATE agent_sessions SET cwd = ?, updated_at = ? WHERE id = ?", targetPath, nowMs, sessionId);
              }
            }
          }
          return {
            worktreePath: targetPath,
            prepareDir: async (wtDir) => {
              mkdirSync(wtDir, { recursive: true });
              if (process.platform === "win32") {
                await ensureWin32ProtectedRootAcl(stateDir, dataDir, { env });
                await allowWin32WorkerWorktreeAcl(stateDir, workerId, wtDir, { env });
              }
            },
          };
        },
      }),
    );
    parts.unsubscribe.push(
      ledger.onActionEnqueued((action) => {
        if (action.type === "session.end") driver.markEnding?.(action.params.sessionId);
        executor.wake();
      }),
      ledger.onStopRequested(({ sessionId }) => {
        setup.cancel(sessionId);
        driver.interrupt(sessionId).catch((error: unknown) => log(`${LOG_PREFIX} 停止失败：${String(error)}`));
      }),
    );
    // Watches belong to PMs, not sessions, so they resume before any session starts and keep their deadlines.
    const watchRunner = createWatchRunner({
      ledger,
      run: createWatchCommandRunner({
        dataDir, stateDir, protectedRoots: () => loadManagedWorktreeRoots(stateDir, worktreesDir), tagNonce: sessionScope.tagNonce, homeDir: options.userHome, baseEnv: env,
      }),
      log,
    });
    parts.watches = watchRunner;
    watchRunner.start();
    parts.executor = executor;
    executor.start();
    // Missed schedules (daemon stopped or machine asleep) run once at startup, not once per missed slot.
    const runSchedulerTick = () => {
      const now = Date.now();
      try {
        ledger.runDueSchedules(now);
      } catch (error) {
        log(`${LOG_PREFIX} 定时任务调度出错：${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        ledger.runDueBackgroundWaits(now);
      } catch (error) {
        log(`${LOG_PREFIX} Background wait check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    runSchedulerTick();
    parts.scheduler = setInterval(runSchedulerTick, SCHEDULER_TICK_MS);
    const purgeArchivedPms = () => {
      try {
        const purged = ledger.purgeExpiredArchivedPms(Date.now());
        if (purged.length > 0) log(`${LOG_PREFIX} 已清理到期归档项目经理：${purged.join(", ")}`);
      } catch (error) {
        log(`${LOG_PREFIX} 清理到期归档项目经理出错：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    purgeArchivedPms();
    parts.archiveCleanup = setInterval(purgeArchivedPms, PM_ARCHIVE_CLEANUP_INTERVAL_MS);
    const feishuOfflineInbox = createFeishuOfflineInbox(db);
    const feishuPostsStore = createFeishuStore(db);
    parts.stopWorkerRetention = startWorkerRetention({ ledger, db, feishuPosts: feishuPostsStore, feishuOfflineInbox, log });
    parts.worktreeCleanup = startWorktreeCleanup({ ledger, worktreesDir, extraWorktreeRoots: () => loadManagedWorktreeRoots(stateDir, worktreesDir), log });
    const resources = startDaemonResources({ db, paths, ledger, worktrees: parts.worktreeCleanup, sessionScope, sessionProcesses, runningWatchIds: () => watchRunner.runningIds(), processLedger, feishuPosts: feishuPostsStore, feishuOfflineInbox, uploadsDir, sentFilesDir, extraWorktreeRoots: () => loadManagedWorktreeRoots(stateDir, worktreesDir), log });
    parts.resources = resources;
    const runAutoRenew = () => {
      try {
        ledger.runAutoRenew();
      } catch (error) {
        log(`${LOG_PREFIX} 自动换新会话出错：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    runAutoRenew();
    parts.autoRenew = setInterval(runAutoRenew, AUTO_RENEW_TICK_MS);
    const handoverRunner = createHandoverRunner({
      ledger,
      prepareLaunch,
      executablePaths: dynamicExecutablePaths,
      pmMemoryDir,
      log,
    });
    parts.handoverRunner = handoverRunner;
    handoverRunner.start();
    const runRouterTurn = createRouterTurnRunner({ ledger, driver, tokens, purposes: routerTurnPurposes, stateDir, launchDir: paths.launchDir, log });
    const catalogRunner = createProjectCatalogRunner({
      ledger: ledger.projectCatalog,
      runTurn: runRouterTurn,
      resolveModel: async () => resolveRouterModel(ledger.getRouterSettings(), await models.list()),
      log,
    });
    parts.catalogRunner = catalogRunner;
    catalogRunner.start();
    const scanStartedAt = performance.now();
    const queuedCatalogs = ledger.projectCatalog.scanAtStartup(Date.now());
    log(`${LOG_PREFIX} 项目档案：启动扫描 ${(performance.now() - scanStartedAt).toFixed(1)} 毫秒，${queuedCatalogs} 个项目要写档`);

    const token = loadOrCreateUiToken(paths.uiTokenFile);
    const staticDir = options.staticDir ?? DEFAULT_STATIC_DIR;
    const webBuild = options.onSelfReload
      ? createStagedWebBuild({ repoDir: REPO_DIR, staticDir, logPath: join(paths.logsDir, SELF_RELOAD_BUILD_LOG), log })
      : null;
    const initialReloadFailure = webBuild?.recover() ?? null;
    if (!existsSync(staticDir)) log(`${LOG_PREFIX} 没找到网页文件 ${staticDir}，先跑 pnpm build`);
    const composer = createComposerService({ ledger, commands, files: createWorkspaceFiles() });
    const vendorSync = createVendorSyncService({
      userHome: options.userHome,
      env,
      backupsDir: paths.syncBackupsDir,
      listProjectFolders: () =>
        db
          .all<{ path: string; project_name: string }>(
            `SELECT f.path AS path, p.name AS project_name
             FROM project_folders f JOIN projects p ON p.id = f.project_id
             WHERE f.removed_at IS NULL AND p.status = 'active'
             ORDER BY f.id ASC LIMIT ?`,
            MAX_VENDOR_SYNC_PROJECT_FOLDERS,
          )
          .map((row) => ({ path: row.path, projectName: row.project_name })),
    });
    const rotateToken = () => {
      const next = rotateUiToken(paths.uiTokenFile);
      log(`${LOG_PREFIX} 已全部退出，新的登录链接：${loginUrl(parts.ui?.port ?? port, next)}`);
      return next;
    };
    const push = createPushService({
      vapidFile: paths.pushVapidFile,
      subscriptionsFile: paths.pushSubscriptionsFile,
      ledger,
      device,
      log: (line) => log(`${LOG_PREFIX} ${line}`),
    });
    parts.unsubscribe.push(() => push.close());
    const meshOptions = options.mesh ?? {};
    const mesh = await createMesh({
      identityDir: paths.meshDir,
      accountFile: paths.accountFile,
      trustFile: paths.peersFile,
      device,
      platform: process.platform,
      relayUrl: meshOptions.relayUrl ?? env[ENV_RELAY_URL] ?? MESH_DEFAULT_RELAY_URL,
      githubClientId: meshOptions.githubClientId ?? env[ENV_GITHUB_CLIENT_ID] ?? MESH_GITHUB_CLIENT_ID,
      listenPort: meshOptions.listenPort ?? meshListenPort(env, port),
      ...(meshOptions.listenHost !== undefined ? { listenHost: meshOptions.listenHost } : {}),
      ...(meshOptions.candidates ? { candidates: meshOptions.candidates } : {}),
      ...(meshOptions.allowLoopback ? { allowLoopback: true } : {}),
      ...(meshOptions.github ? { github: meshOptions.github } : {}),
      ...(meshOptions.fetch ? { fetch: meshOptions.fetch } : {}),
      onConnection: (connection) => {
        if (parts.ui === undefined) connection.socket.destroy();
        else parts.ui.acceptMeshConnection(connection);
      },
      log: (line) => log(`${LOG_PREFIX} ${line}`),
    });
    parts.mesh = mesh;
    const peers = createPeers({
      device,
      saveName: (name) => {
        device.name = name;
        saveDevice(paths.deviceFile, device);
      },
      mesh,
      log,
    });
    parts.peers = peers;
    const sha = (value: string) => createHash("sha256").update(value).digest();
    try {
      parts.admin = await startAdminSocket({
        runDir: paths.runDir,
        socketPath: paths.adminSock,
        authorize: (given) => {
          try {
            return timingSafeEqual(sha(given), sha(readFileSync(paths.uiTokenFile, "utf8").trim()));
          } catch {
            return false;
          }
        },
        feishu: () => parts.feishu?.setup,
        mesh: () => parts.mesh,
        ...(options.onExternalShutdown ? { onShutdown: options.onExternalShutdown } : {}),
        // The Windows admin pipe lives outside the data dir, so it must get DENY FusaWorker before serving; on POSIX the OS sandbox blocks run/admin.sock.
        ...(process.platform === "win32" ? { secure: (pipe: string) => denyWin32WorkerPipeAccess(stateDir, pipe, { env }) } : {}),
        log: (line) => log(`${LOG_PREFIX} ${line}`),
      });
    } catch (adminErr) {
      if (adminErr instanceof AdminSocketInsecureError) {
        log(`${LOG_PREFIX} ${adminErr.message}`);
      } else if (
        (adminErr as NodeJS.ErrnoException | null)?.code === "EADDRINUSE" ||
        (adminErr instanceof Error && adminErr.message.includes("已有守护进程在跑"))
      ) {
        throw new DaemonAlreadyRunningError(0);
      } else {
        throw adminErr;
      }
    }
    const routerLocalPort = createLocalTargetPort({
      deviceId: device.id,
      deviceName: () => device.name,
      ledger,
      uploadsDir,
      refreshVendor: (vendor) => models.ensureUsable(vendor),
    });
    const routerTargetRegistry = createRouterTargetRegistry({
      localPort: routerLocalPort,
      peers,
      uploadsDir,
    });
    parts.routerTargetRegistry = routerTargetRegistry;
    const routerDispatcher = createRouterDispatcher({
      ledger,
      runTurn: runRouterTurn,
      sandboxGuard,
      targetRegistry: routerTargetRegistry,
      models,
      resolveAttachment: (id) => {
        const att = resolveUpload(uploadsDir, id);
        return att === null ? null : { id: att.id, name: att.name, mime: att.mime, size: att.size };
      },
    });
    parts.routerDispatcher = routerDispatcher;
    const { lease: feishuLease, unsubscribe: unsubscribeFeishuLease } = createFeishuLease(mesh, device.id, () => parts.feishu);
    const pushFeishuToPeer = (peerId: string, payload: { app?: FeishuPeerAppSync | null; chats?: { chatId: string; pmId: number }[] }, attempt = 0) => {
      if (mesh.status().state !== "signed_in" || !mesh.isOnline(peerId) || mesh.trust.get(peerId) === undefined) return;
      void (async () => {
        if (payload.app !== undefined && payload.app !== null) {
          const res = await mesh.request(peerId, API_PATHS.peerFeishuApp, { method: "PUT", body: JSON.stringify(payload.app) });
          await res.body?.cancel();
          if (!res.ok) throw new Error(`PUT app HTTP ${res.status}`);
        } else if (payload.app === null && parts.feishu !== undefined) {
          const res = await mesh.request(peerId, API_PATHS.peerFeishuApp);
          if (res.ok) {
            const raw = (await res.json()) as { app?: unknown };
            const parsed = feishuPeerAppSyncSchema.safeParse(raw?.app);
            if (parsed.success) await parts.feishu.applyPeerApp(parsed.data);
          } else {
            await res.body?.cancel();
          }
        }
        if (payload.chats !== undefined && payload.chats.length > 0) {
          const res = await mesh.request(peerId, API_PATHS.peerFeishuChats, { method: "POST", body: JSON.stringify({ chats: payload.chats }) });
          await res.body?.cancel();
          if (!res.ok) throw new Error(`POST chats HTTP ${res.status}`);
        }
      })().catch((error: unknown) => {
        if (attempt < 4 && mesh.isOnline(peerId)) {
          const timer = setTimeout(() => pushFeishuToPeer(peerId, payload, attempt + 1), FEISHU_CONTROL_RETRY_MS * (attempt + 1));
          timer.unref?.();
          return;
        }
        log(`${LOG_PREFIX} 飞书跨机同步给 ${peerId} 没成：${error instanceof Error ? error.message : String(error)}`);
      });
    };

    const onlinePeers = new Set<string>();
    const onlineListeners = new Set<(id: string) => void>();
    const checkPeerTransitions = () => {
      const signed = mesh.status().state === "signed_in";
      const trustedPeers = signed ? mesh.trust.list().slice(1) : [];
      const trustedIds = new Set(trustedPeers.map((p) => p.id));
      for (const prevId of [...onlinePeers]) {
        if (!trustedIds.has(prevId) || !mesh.isOnline(prevId)) onlinePeers.delete(prevId);
      }
      for (const peer of trustedPeers) {
        if (!mesh.isOnline(peer.id) || onlinePeers.has(peer.id)) continue;
        onlinePeers.add(peer.id);
        for (const fn of onlineListeners) fn(peer.id);
        if (parts.feishu !== undefined) {
          pushFeishuToPeer(peer.id, { app: parts.feishu.exportPeerApp(), chats: parts.feishu.localPmChats() });
        }
      }
    };

    parts.unsubscribe.push(
      unsubscribeFeishuLease,
      mesh.onChange(checkPeerTransitions),
      mesh.trust.onChange(() => {
        checkPeerTransitions();
      }),
    );

    const feishu = createFeishuService({
      db,
      ledger,
      router: routerDispatcher,
      models,
      secretsFile: paths.feishuSecretsFile,
      inboundStateFile: paths.feishuInboundFile,
      inboundRelay: mesh.relayCheckpoints,
      inboundPeers: createFeishuPeerCheckpointPort(mesh),
      uploadsDir,
      sentFilesDir,
      device,
      lease: feishuLease,
      mesh: {
        activeDevices: () => {
          const st = mesh.status();
          return st.state === "signed_in" ? Math.max(1, st.devices.filter((d) => d.online).length) : 1;
        },
        onAppChanged: (sync) => {
          if (mesh.status().state !== "signed_in") return;
          for (const peer of mesh.trust.list().slice(1)) {
            if (mesh.isOnline(peer.id)) pushFeishuToPeer(peer.id, { app: sync });
          }
        },
        onChatsSynced: (chats) => {
          if (mesh.status().state !== "signed_in" || chats.length === 0) return;
          for (const peer of mesh.trust.list().slice(1)) {
            if (mesh.isOnline(peer.id)) pushFeishuToPeer(peer.id, { chats });
          }
        },
        approvals: () => {
          const st = mesh.status();
          return st.state === "signed_in" ? { approvals: st.approvals, joinedIds: new Set(st.devices.map((d) => d.id)) } : null;
        },
        beginApproval: (requestId) => mesh.beginApproval(requestId),
        answerApproval: (requestId, match) => mesh.answerApproval(requestId, match),
        onChange: (fn) => mesh.onChange(fn),
      },
      ...(options.feishu ? options.feishu : {}),
      log: (line) => log(`${LOG_PREFIX} ${line}`),
    });
    const feishuAccountBot = createFeishuAccountBot({
      mesh: {
        selfId: device.id,
        deviceName: (id) => (id === device.id ? device.name : (mesh.trust.get(id)?.name ?? null)),
        isOnline: (id) => mesh.isOnline(id),
        post: async (id, path, body, timeoutMs) => {
          const res = await mesh.request(id, path, { method: "POST", body: JSON.stringify(body), timeoutMs });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status} ${text}`);
          }
          return await res.json();
        },
        onOnline: (fn) => {
          onlineListeners.add(fn);
          return () => onlineListeners.delete(fn);
        },
      },
      local: feishu,
      inbox: feishuOfflineInbox,
      log: (line) => log(`${LOG_PREFIX} ${line}`),
    });
    feishu.useAccountBot(feishuAccountBot);
    parts.feishuAccountBot = feishuAccountBot;
    parts.feishu = feishu;
    await feishu.start();
    checkPeerTransitions();
    if (options.onSelfReload) {
      const onSelfReload = options.onSelfReload;
      parts.selfReload = createSelfReload({
        busyReasons: () => {
          const reasons: string[] = [];
          const snapshots = ledger.busySessionSnapshots();
          if (snapshots.length > 0) {
            reasons.push(...describeBusySessionsForReload(snapshots, Date.now()));
          } else {
            const sessionsBusy = busySessions.count();
            if (sessionsBusy > 0) reasons.push(`${sessionsBusy} 个会话仍在忙碌`);
          }
          if (routerDispatcher.busy()) reasons.push("总助分派引擎有规划中或在途分派");
          if (handoverRunner.busy()) reasons.push("后台在写交接");
          if (catalogRunner.busy()) reasons.push("后台在写项目档案");
          if (db.get("SELECT 1 AS x FROM actions WHERE status = 'running' OR (status = 'pending' AND next_attempt_at <= ?) LIMIT 1", Date.now()) !== undefined) {
            reasons.push("执行器有待执行的动作");
          }
          return reasons;
        },
        // Router dispatch commands are not replayed after a restart; recoverAfterRestart marks them failed for the user to retry.
        unresumableReasons: () => {
          const reasons = ledger.turnsLostOnShutdown().map(({ sessionId, role }) => `${role === "pm" ? "项目经理" : "总助"}会话 ${sessionId} 正在回用户的消息`);
          if (routerDispatcher.busy()) reasons.push("总助在处理用户的指令");
          return reasons;
        },
        subscribe: (listener) => ledger.onChange(listener),
        initialFailure: initialReloadFailure,
        ...(webBuild ? { build: (signal: AbortSignal) => webBuild.build(signal), applyBuild: () => webBuild.apply(), cancelBuild: () => webBuild.cleanup() } : {}),
        restart: onSelfReload,
        ...(options.selfReloadDrainMaxMs !== undefined ? { drainMaxMs: options.selfReloadDrainMaxMs } : {}),
        log,
      });
    }
    parts.ui = await startUiServer({
      ledger,
      token,
      port,
      staticDir,
      uploadsDir,
      sentFilesDir,
      models,
      quota,
      composer,
      vendorSync,
      capabilityInventory,
      providers: providerManager,
      db,
      rotateToken,
      push,
      peers,
      mesh,
      feishu: feishu.setup,
      feishuPeer: {
        acceptInbound: (body) => feishuAccountBot.acceptForwarded(body),
        learnChats: (from, chats) => feishuAccountBot.learnChats(from, chats),
        exportApp: () => feishu.exportPeerApp(),
        applyApp: (sync) => feishu.applyPeerApp(sync),
        exportInboundState: () => feishu.exportInboundState?.() ?? null,
        applyInboundState: (state) => feishu.applyInboundState?.(state),
      },
      routerDispatcher,
      routerLocalPort,
      resources: resources.inspector,
      ...(parts.selfReload ? { selfReload: parts.selfReload } : {}),
      ...(options.folderPicker ? { folderPicker: options.folderPicker } : {}),
    });

    void quota.get();
    let stopping: Promise<void> | undefined;
    return {
      paths,
      port: parts.ui.port,
      url: loginUrl(parts.ui.port, token),
      stop: () => (stopping ??= shutdown()),
    };
  } catch (error) {
    await shutdown();
    // A busy UI port becomes port_in_use so the shell prints a short hint instead of a stack.
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && typeof (error as { port?: unknown }).port === "number") {
      throw new StartupError("port_in_use", String((error as { port: number }).port), { cause: error });
    }
    throw error;
  }
}

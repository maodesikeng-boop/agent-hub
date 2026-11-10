// 组装（m1-plan 第 3 节 W5，m2-plan 第 3 节接口约定第 6 条）：启动和关闭顺序、各块之间的接线。main.ts 只管命令行、信号和退出码。
// 启动和关机的顺序只在这个文件里定，别的文件不要自己起、关别的块：
// - 启动：目录锁 → 开库迁移、账本 → agent 接口和 hub 外壳 → 驱动层 → 清上次残留的 claude → 重启恢复、同步性格设定文件
//   → 第一次启动建项目经理 → 处理函数、执行器 → 调度器（定时任务，先查一次，睡眠或没开时错过的补跑一次）→ 后台写交接的跑腿的（补清上次没清掉的复制会话）
//   → 界面令牌、设备身份和配对、ssh 隧道和管理 socket、界面服务。
// - 关机（启动到哪一步就关到哪一步）：调度器 → 后台写交接的跑腿的（取消在写的、清理复制会话）→ 准备命令 → 执行器 → claude（含问模型名单、命令列表的那个）→ 隧道管理 socket、ssh 隧道 → 界面服务 → agent 接口 → 取消订阅、关库 → 放锁。
// 用到的超时都在 src/shared/limits.ts。
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import {
  AGENT_API_CLOSE_MS,
  DEFAULT_PM_MODE,
  DEFAULT_PEER_ENTRY_PORT,
  DEFAULT_UI_PORT,
  DEFAULT_AGENT_VENDOR,
  ENV_DEFAULT_MODEL,
  ENV_PORT,
  ENV_TAILNET_OWNER,
  EXECUTOR_STOP_GRACE_MS,
  HANDOVER_STOP_GRACE_MS,
  PM_ARCHIVE_CLEANUP_INTERVAL_MS,
  SCHEDULER_TICK_MS,
  VENDOR_LIST,
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
import { startFileCleanup } from "./file-cleanup.ts";
import { createHandoverRunner, type HandoverRunner } from "./handover/runner.ts";
import { startWorktreeCleanup, type WorktreeCleanup } from "./worktree-cleanup.ts";
import {
  findExecutable,
  VENDOR_FALLBACK_PATHS,
  resolveHubPaths,
  resolveVendorExecutables,
  workerSetupLogPath,
} from "../shared/paths.ts";
import { createActionExecutor } from "./actions/index.ts";
import { createProcessLedger, installProcessLedger } from "./process-ledger.ts";
import { createCommandCatalogs, type CommandCatalogs } from "./commands-catalog.ts";
import { createComposerService } from "./composer.ts";
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
import { addWorktree } from "./git/index.ts";
import { createFetchedQuota, mergeFetchedQuotas, queryFetchedQuota } from "./quota/fetched-quota.ts";
import { vendorTranscriptPath } from "./driver/transcript.ts";
import type { LedgerOptions } from "./ledger/ledger.ts";
import {
  createSessionEndHandler,
  createSessionSendHandler,
  createSessionStartHandler,
  createWorktreeCreateHandler,
  endedOnRevokedTokens,
} from "./handlers.ts";
import { createLaunchPreparer, createPersonaNoter } from "./launch.ts";
import { createLedger } from "./ledger/index.ts";
import { DEFAULT_PM_NAME } from "./prompt.ts";
import { prepareSentFilesDir } from "./sent-files.ts";
import { createSetupRunner, type SetupRunner } from "./setup/index.ts";
import { acquireLock, createSessionStore, openStore, type Db, type DirLock } from "./store/index.ts";
import { StartupError } from "./startup-error.ts";
import { loadOrCreateUiToken, loginUrl, rotateUiToken, startUiServer, type RunningUiServer } from "./ui-server/index.ts";
import { defaultDeviceName, loadOrCreateDevice, saveDevice } from "./device.ts";
import { createPeers, type Peers } from "./peers/index.ts";
import { createPushService } from "./push/index.ts";
import { createTunnelService, startTunnelAdmin, type RunningTunnelAdmin, type TunnelService } from "./tunnel/index.ts";
import {
  createSleepInhibitor,
  createTailnetProbe,
  runTailscaleStatus,
  serveCommandLine,
  serveTargetKind,
  tailscaleCommand,
  type SleepInhibitor,
  type TailnetProbe,
} from "./platform/index.ts";

/** 网页打包产物（pnpm build 的输出）。 */
export const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../../dist/web", import.meta.url));

export interface DaemonOptions {
  env?: Record<string, string | undefined>;
  userHome: string;
  staticDir?: string;
  log?: (line: string) => void;
  /** 本机 tailnet 名字和主人的探测（联机）。不给就真的问 tailscale status（结果缓存，见 daemon/platform/tailnet.ts）。 */
  tailnet?: TailnetProbe;
  /** 自动换新会话的门槛、空闲多久、写交接最多多久（默认见 limits.ts）；只给冒烟测试改小。 */
  autoRenew?: LedgerOptions["autoRenew"];
  /** 联机：认本机回环网址当设备网址（同机两个守护进程互相配对）。只给测试入口 test/e2e/loopback-daemon.ts，正式入口不传、没有环境变量开关。 */
  allowLoopbackPeers?: boolean;
}

export interface RunningDaemon {
  paths: HubPaths;
  port: number;
  url: string;
  /** 关机：停后台写交接 → 停准备命令 → 停执行器 → 停 claude（含问模型名单的）→ 关界面服务 → 关 agent 接口 → 关库 → 放锁。只做一次，多调返回同一个 Promise。 */
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

/** 启动守护进程。拿不到目录锁抛 DaemonAlreadyRunningError（这时什么都没动）。 */
export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line) => console.error(line));
  const paths = resolveHubPaths(env, options.userHome);
  const executables = resolveVendorExecutables(paths, env.PATH, options.userHome);
  const executablePaths = Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, executables[vendor].path])) as Record<AgentVendor, string>;
  const port = parsePort(env[ENV_PORT]);

  // 启动到哪一步，关机就关到哪一步；顺序固定：准备命令 → 执行器 → 驱动层 → 界面服务 → agent 接口 → 库 → 锁
  // （准备命令最先：它不回调账本，重启后重跑；不先停的话执行器、关机要等它跑完）
  // （agent 接口在 claude 都退出之后才关：最后一轮里 agent 还可能敲 hub；它要用账本，所以在库之前）
  const parts: {
    scheduler?: NodeJS.Timeout;
    autoRenew?: NodeJS.Timeout;
    archiveCleanup?: NodeJS.Timeout;
    worktreeCleanup?: WorktreeCleanup;
    handoverRunner?: HandoverRunner;
    setup?: SetupRunner;
    executor?: ActionExecutor;
    driver?: Driver;
    models?: ModelCatalogs;
    commands?: CommandCatalogs;
    ui?: RunningUiServer;
    peers?: Peers;
    tunnel?: TunnelService;
    tunnelAdmin?: RunningTunnelAdmin;
    agentApi?: RunningAgentApi;
    db?: Db;
    lock?: DirLock;
    uninstallProcessLedger?: () => void;
    stopFileCleanup?: () => void;
    stopWorkerRetention?: () => void;
    sleepInhibitor?: SleepInhibitor;
    unsubscribe: Unsubscribe[];
  } = { unsubscribe: [] };
  const step = async (what: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (error) {
      log(`${LOG_PREFIX} 关闭${what}时出错：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const shutdown = async () => {
    const { scheduler, autoRenew, archiveCleanup, worktreeCleanup, handoverRunner, setup, executor, driver, models, commands, ui, peers, tunnel, tunnelAdmin, agentApi, db, lock } = parts;
    if (scheduler) clearInterval(scheduler);
    if (autoRenew) clearInterval(autoRenew);
    if (archiveCleanup) clearInterval(archiveCleanup);
    if (worktreeCleanup) await step("worktree 自动清理", () => worktreeCleanup.stop());
    parts.sleepInhibitor?.stop();
    // 跑腿的在写的 abort、复制那份清掉，都要回报账本，所以在执行器、库之前；到点没清完的下次启动补清
    if (handoverRunner) {
      await step("后台写交接", async () => {
        if (!(await within(handoverRunner.stop(), HANDOVER_STOP_GRACE_MS))) throw new Error(`${HANDOVER_STOP_GRACE_MS / 1000} 秒没收完，不再等`);
      });
    }
    parts.stopFileCleanup?.();
    parts.stopWorkerRetention?.();
    if (setup) await step("准备命令", () => setup.shutdown());
    if (executor) {
      await step("执行器", async () => {
        const stopped = executor.stop();
        // 手上的动作可能在等 claude 启动：等一会儿还没完就先关驱动层，它们会跟着结束
        if (!(await within(stopped, EXECUTOR_STOP_GRACE_MS)) && driver) {
          await driver.shutdown();
          await stopped;
        }
      });
    }
    if (driver) await step("驱动层", () => driver.shutdown());
    if (models) await step("模型名单", () => models.close());
    if (commands) await step("命令列表", () => commands.close());
    // 隧道：先关管理 socket（不再收命令），再停 ssh 子进程
    if (tunnelAdmin) await step("隧道管理 socket", () => tunnelAdmin.close());
    if (tunnel) await step("隧道", () => tunnel.close());
    // 先停设备之间在途的请求，再关界面服务（经入口转发的 WebSocket 跟着浏览器那条一起关）
    peers?.close();
    if (ui) await step("界面服务", () => ui.close());
    if (agentApi) {
      await step("agent 接口", async () => {
        if (!(await within(agentApi.close(), AGENT_API_CLOSE_MS))) throw new Error(`${AGENT_API_CLOSE_MS / 1000} 秒没关完，不再等`);
      });
    }
    // claude 都退出了、事件都交给账本了，再取消订阅、关库
    for (const off of parts.unsubscribe.splice(0)) off();
    if (db) await step("数据库", () => db.close());
    parts.uninstallProcessLedger?.();
    if (lock) await step("目录锁", () => lock.release());
  };

  try {
    // 1. 目录锁
    parts.lock = acquireLock(paths.lockFile);
    // 1b. 子进程记账：先回收上次崩溃留下的子进程（只杀记过、且进程号上还是同一个进程的），再开始记这次的
    const processLedger = createProcessLedger({ file: paths.childProcessesFile, log });
    try {
      await processLedger.reapStale();
    } catch (error) {
      log(`${LOG_PREFIX} 回收上次残留的子进程出错：${error instanceof Error ? error.message : String(error)}`);
    }
    parts.uninstallProcessLedger = installProcessLedger(processLedger);
    // 2. 开库并迁移
    const { db, migration, autoVacuum } = openStore(paths);
    parts.db = db;
    const backupFile = autoVacuum.backupFile ?? migration.backupFile;
    if (autoVacuum.converted) {
      log(`${LOG_PREFIX} 账本数据库已改成增量回收模式（整库重建了一次${backupFile ? `，重建前的备份：${backupFile}` : ""}）`);
    } else if (autoVacuum.error !== undefined) {
      log(`${LOG_PREFIX} 账本数据库改成增量回收模式没成，本次跳过（不影响运行，下次启动再试）：${autoVacuum.error}`);
    }
    // realpath 过的两个目录，账本和启动准备用同一份：
    // - dataDir：Worker 的可写范围（write-scope.ts）按真实路径匹配，沙箱认的是真实路径；
    // - stateDir：Worker 设置文件里 state/ 的兜底拒绝规则（policy.ts 的 stateDirDenyRule）按真实路径匹配；
    // - worktreesDir：Worker 的 cwd、项目经理的 --add-dir 都由它拼出来，和主文件夹、附加文件夹一样是真实路径
    //   （macOS 上 /var 是 /private/var；git worktree list 列的也是真实路径）。
    mkdirSync(paths.worktreesDir, { recursive: true });
    // uploadsDir 也是：用户在聊天框上传的文件，agent 拿到的是这个真实路径下的绝对路径（权限规则按真实路径匹配）
    mkdirSync(paths.uploadsDir, { recursive: true, mode: 0o700 });
    const uploadsDir = realpathSync.native(paths.uploadsDir);
    // sentFilesDir：agent 在回复里发给用户的文件的副本（sent-files.ts），顺手清掉上次没拷完的
    prepareSentFilesDir(paths.sentFilesDir);
    const sentFilesDir = realpathSync.native(paths.sentFilesDir);
    // 过期的上传文件和副本：启动时清一次，之后每天一次（出错只记日志）
    parts.stopFileCleanup = startFileCleanup([uploadsDir, sentFilesDir], log);
    const dataDir = realpathSync.native(paths.home);
    const stateDir = realpathSync.native(paths.stateDir);
    const worktreesDir = realpathSync.native(paths.worktreesDir);
    // 模型名单和这台设备上各家的状态（没装 / 没登录，docs/vendor-availability-design.md）：第一次有人要（网页打开资料页、
    // 新建弹窗）时按厂商分别问本机 CLI，在用户主目录下起，不带任何项目的设置；装没装每次只查文件。
    // 账本写系统消息时用它缓存着的显示名
    const models = createModelCatalogs({
      sources: createVendorCatalogSources(
        Object.fromEntries(
          AGENT_VENDORS.map((vendor) => [
            vendor,
            {
              path: executables[vendor].path,
              cwd: options.userHome,
              installed: () => findExecutable(executables[vendor].cmd, env.PATH, VENDOR_FALLBACK_PATHS[vendor](options.userHome)) !== null,
            },
          ]),
        ) as Record<AgentVendor, VendorCatalogSourceOptions>,
      ),
      log,
    });
    parts.models = models;
    const ledger = createLedger(db, {
      modelCatalog: (vendor) => models.current(vendor),
      // 手打命令时看缓存着的命令列表（commands 在下面才建，所以现用现取）
      knownCommands: (session) => parts.commands?.cached(session) ?? null,
      pmHomeRoot: paths.pmHomeDir,
      personasDir: paths.personasDir,
      dataHome: paths.home,
      worktreesDir,
      launchDir: paths.launchDir,
      setupLogsDir: paths.setupLogsDir,
      uploadsDir,
      sentFilesDir,
      // 交接提示词里写上会话原始记录的路径
      findTranscript: (ref) => vendorTranscriptPath(ref),
      ...(options.autoRenew ? { autoRenew: options.autoRenew } : {}),
      // 账本有交接可以领了：叫醒跑腿的（它在下面才建，所以现用现取）
      onHandoverClaimable: () => parts.handoverRunner?.wake(),
      log,
    });
    parts.unsubscribe.push(() => ledger.close());
    const sessions = createSessionStore(db);
    // 有会话在干活时起 caffeinate 防闲置睡眠，全部闲下来过宽限期再结束（daemon/platform/sleep.ts）
    const sleepInhibitor = createSleepInhibitor();
    parts.sleepInhibitor = sleepInhibitor;
    parts.unsubscribe.push(
      ledger.onChange((change) => {
        if (change.type === "session.status") sleepInhibitor.onSessionStatus(change.data.session);
      }),
    );
    // 3. agent 接口（run/ 0700、删残留 socket、hub.sock 0600）和 hub 外壳，在执行器之前起。
    //    令牌只有这一份：agent 接口认人、prepareLaunch 发、session.end 处理函数作废，用的都是它
    const tokens = createSessionTokens();
    // 联机：设备身份（hub worker start 报“这台设备没装 codex”时写设备名）
    const device = loadOrCreateDevice(paths.deviceFile, defaultDeviceName(hostname()));
    const agentApi = await startAgentApi({
      ledger,
      tokens,
      runDir: paths.runDir,
      hubSock: paths.hubSock,
      log,
      models,
      vendorUsable: (vendor) => models.ensureUsable(vendor),
      deviceName: () => device.name,
    });
    parts.agentApi = agentApi;
    installHubShim({ binDir: paths.hubBinDir });
    const prepareLaunch = createLaunchPreparer({
      launchDir: paths.launchDir,
      dataDir,
      stateDir,
      worktreesDir,
      getLaunchContext: (sessionId) => ledger.getLaunchContext(sessionId),
      tokens: endedOnRevokedTokens(tokens),
      // realpath 过的：写进 HUB_SOCK 和设置文件的 allowUnixSockets
      hubSock: agentApi.socketPath,
      hubBinDir: paths.hubBinDir,
      // 项目经理提示词里“能用的厂商”只列这台设备上能用的（只看缓存，不等查询）
      vendorAvailability: () => Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, models.availability(vendor)])),
    });
    // 性格设定、模式改了不重启，下一条消息前加说明（driver.ts 的“两轮之间自动重启”）
    const personaNote = createPersonaNoter((sessionId, since) => ledger.personaUpdate(sessionId, since));
    // 换代后的新会话：开场说明 + 交接 + 最近原话拼在第一条写给它的消息前面（ledger/handover.ts）
    const launch = { store: sessions, log, prepareLaunch, personaNote, sessionPreamble: (sessionId: number) => ledger.sessionPreamble(sessionId) };
    const driver = createMultiVendorDriver({
      store: sessions,
      drivers: createVendorDrivers(
        Object.fromEntries(
          AGENT_VENDORS.map((vendor) => [
            vendor,
            {
              executablePath: executables[vendor].path,
              ...launch,
              ...(vendorSpec(vendor).capabilities.explicitDefaultModel
                ? {
                    // 没选模型时用名单里厂商报的默认（名单有缓存，不是每次起会话都问；只问这一家，docs/vendor-plugin-design.md 1.7 第 1 条）
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
    // 输入框的“/”命令列表：正在跑的会话直接问它，没在跑的另起一个对应厂商 CLI 在会话的目录里问；会话中途推来的新名单直接更新缓存
    const commands = createCommandCatalogs({
      vendors: Object.fromEntries(
        AGENT_VENDORS.map((vendor) => [vendor, DAEMON_VENDORS[vendor].createComposer({ executablePath: executables[vendor].path })]),
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
    // 真跑的结果反过来更新这台设备上厂商的状态（不用等名单缓存过期）：会话起来了就是能用，一轮因为没登录失败就是没登录
    parts.unsubscribe.push(
      driver.onEvent((sessionId, event) => {
        const vendor = sessions.get(sessionId)?.vendor;
        if (!isAgentVendor(vendor)) return;
        if (event.type === "session.started") models.report(vendor, "available");
        else if (event.type === "turn.ended" && !event.ok && event.error && vendorFailureOf(event.error.message, vendor)?.kind === "auth") {
          models.report(vendor, "signed_out");
        }
      }),
    );

    // 4. 清掉上次留下的 claude
    await driver.cleanupStale();
    // 5. 重启恢复（账本那部分；执行器启动时再把“执行中”改回“待执行”），然后按数据库同步性格设定文件
    const recovered = ledger.recoverAfterRestart();
    if (recovered.resentMessageIds.length + recovered.requeuedMessageIds.length > 0) {
      log(`${LOG_PREFIX} 重启恢复：重发 ${recovered.resentMessageIds.length} 条，补发排队中的 ${recovered.requeuedMessageIds.length} 条`);
    }
    const synced = ledger.syncPersonaFiles();
    if (synced.recordedPmIds.length > 0) log(`${LOG_PREFIX} 发现 ${synced.recordedPmIds.length} 个手改过的性格设定文件，已记下修改`);
    // 6. 第一次启动建一个项目经理（createPm 自己写性格设定文件；只查 pms 表有没有行，不拉全量 snapshot）
    if (db.get("SELECT 1 AS x FROM pms LIMIT 1") === undefined) {
      let defaultModel = env[ENV_DEFAULT_MODEL]?.trim() || undefined;
      // 不合规的模型名不让第一次启动失败：忽略，按默认
      const badModel = defaultModel === undefined ? null : checkModel(DEFAULT_AGENT_VENDOR, defaultModel);
      if (badModel !== null) {
        log(`${LOG_PREFIX} ${ENV_DEFAULT_MODEL}=${JSON.stringify(defaultModel)} 不能用（${badModel}），项目经理按默认模型建`);
        defaultModel = undefined;
      }
      const { pm } = ledger.createPm({ name: DEFAULT_PM_NAME, mode: DEFAULT_PM_MODE, persona: "", ...(defaultModel ? { defaultModel } : {}) });
      log(`${LOG_PREFIX} 第一次启动，建了项目经理“${pm.name}”`);
    }

    // 7. 处理函数、接线、启动执行器
    const executor = createActionExecutor(db, ledger);
    // worktree 准备命令（hub project setup）：在后台跑，不占执行器；网页上点停止、收工、关机时结束它
    const setup = createSetupRunner({ log });
    parts.setup = setup;
    const deps = { driver, ledger, sessions, tokens, setup };
    executor.register("session.start", createSessionStartHandler(deps));
    executor.register("session.send", createSessionSendHandler(deps));
    // Worker 收工（hub worker end）登记 session.end：这一轮回完再关，然后作废它的令牌
    executor.register("session.end", createSessionEndHandler(deps));
    executor.register(
      "worktree.create",
      createWorktreeCreateHandler({ ledger, addWorktree, setup, setupLogPath: (workerId) => workerSetupLogPath(paths.setupLogsDir, workerId) }),
    );
    parts.unsubscribe.push(
      ledger.onActionEnqueued(() => executor.wake()),
      ledger.onStopRequested(({ sessionId }) => {
        // Worker 还在准备中：只停准备命令，Worker 照常开工（没有在跑的就什么也不做）
        setup.cancel(sessionId);
        driver.interrupt(sessionId).catch((error: unknown) => log(`${LOG_PREFIX} 停止失败：${String(error)}`));
      }),
    );
    parts.executor = executor;
    executor.start();
    // 定时任务：启动时先查一次（守护进程停着、电脑睡着时错过的只补跑一次），之后每 SCHEDULER_TICK_MS 查一次
    const runSchedules = () => {
      try {
        ledger.runDueSchedules(Date.now());
      } catch (error) {
        log(`${LOG_PREFIX} 定时任务调度出错：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    runSchedules();
    parts.scheduler = setInterval(runSchedules, SCHEDULER_TICK_MS);
    // 到期归档项目经理：启动时先清一次，之后每 PM_ARCHIVE_CLEANUP_INTERVAL_MS 清一次
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
    // 已收工 Worker 满保留期：清它们的对话（消息、步骤日志等），再把空出来的页还给文件系统（db-retention.ts）；启动时先来一轮
    parts.stopWorkerRetention = startWorkerRetention({ ledger, db, log });
    // 已收工 Worker 的 worktree：启动时先清一轮，之后每 WORKTREE_CLEANUP_INTERVAL_MS 清一轮（分支保留）
    parts.worktreeCleanup = startWorktreeCleanup({ ledger, worktreesDir, log });
    // 项目经理的对话太长：空闲一会儿后自动写交接、换新会话；写交接超时的放弃（ledger/handover.ts）
    const runAutoRenew = () => {
      try {
        ledger.runAutoRenew();
      } catch (error) {
        log(`${LOG_PREFIX} 自动换新会话出错：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    runAutoRenew();
    parts.autoRenew = setInterval(runAutoRenew, AUTO_RENEW_TICK_MS);
    // 后台写交接：跑腿的从账本领活、复制项目经理的会话去写交接（daemon/handover/runner.ts）。放在重启恢复之后：
    // 账本先把上次没做完的记成失败，跑腿的再补清它们复制出来的会话。账本接口见 shared/handover.ts 的 LedgerHandoverWork
    const handoverRunner = createHandoverRunner({ ledger, prepareLaunch, executablePaths, log });
    parts.handoverRunner = handoverRunner;
    handoverRunner.start();

    // 8. 界面令牌；9. 界面服务，只监听 127.0.0.1
    const token = loadOrCreateUiToken(paths.uiTokenFile);
    const staticDir = options.staticDir ?? DEFAULT_STATIC_DIR;
    if (!existsSync(staticDir)) log(`${LOG_PREFIX} 没找到网页文件 ${staticDir}，先跑 pnpm build`);
    const composer = createComposerService({ ledger, commands, files: createWorkspaceFiles() });
    // 额度：事件流里没有额度的厂商只能另起进程问，网页打开额度面板时才问（每家各自缓存 5 分钟），几家合在一个响应里
    const quota = mergeFetchedQuotas(
      VENDOR_LIST.flatMap(({ id, quota: spec }) => {
        const fetched = spec?.fetched;
        if (fetched === undefined) return [];
        return [createFetchedQuota({ query: () => queryFetchedQuota({ vendor: id, path: executables[id].path, spec: fetched, cwd: options.userHome }) })];
      }),
    );
    // 全部退出：换主钥匙写回 state/ui-token，新的登录链接打在日志里（旧的启动链接作废了）
    const rotateToken = () => {
      const next = rotateUiToken(paths.uiTokenFile);
      log(`${LOG_PREFIX} 已全部退出，新的登录链接：${loginUrl(parts.ui?.port ?? port, next)}`);
      return next;
    };
    // 联机：本机 tailnet 名字（后台问，不拖慢启动）；serve 转发目标（Linux 另听 run/ui.sock）。设备身份在前面 agent 接口之前就读了
    const tailscaleCli = tailscaleCommand({ env });
    const tailnet = options.tailnet ?? createTailnetProbe({ run: runTailscaleStatus(tailscaleCli), env });
    const serveTarget = serveTargetKind({ env });
    // 推送提醒（联机 P4）：VAPID 密钥、订阅在 state/；按账本的变化判断要不要推。关的时候随账本订阅一起取消
    const push = createPushService({
      vapidFile: paths.pushVapidFile,
      subscriptionsFile: paths.pushSubscriptionsFile,
      ledger,
      device,
      log: (line) => log(`${LOG_PREFIX} ${line}`),
    });
    parts.unsubscribe.push(() => push.close());
    // 已配对的设备（state/peers.json）。本机网址：tailnet 名字；测试入口下没有 Tailscale 时用本机回环地址
    const allowLoopbackPeers = options.allowLoopbackPeers === true;
    let listeningPort: number | undefined;
    const peers = createPeers({
      file: paths.peersFile,
      device,
      saveName: (name) => {
        device.name = name;
        saveDevice(paths.deviceFile, device);
      },
      selfUrl: () => {
        const self = tailnet.current();
        if (self !== null) return `https://${self.dnsName}`;
        return allowLoopbackPeers && listeningPort !== undefined ? `http://127.0.0.1:${listeningPort}` : null;
      },
      allowLoopback: allowLoopbackPeers,
      tunnelsFile: paths.tunnelsFile,
      hubSocket: paths.tunnelHubSock,
      reconnectTunnel: () => parts.tunnel?.reconnectNow() ?? false,
      log,
    });
    parts.peers = peers;
    // ssh 隧道（docs/hub-tunnel-design.md 第 6、7 节）：连入方起 ssh 子进程看着它；中心分槽位、出邀请码。
    // 隧道命令（src/tunnel/）经 run/admin.sock 找它，要带界面令牌（每次现读 state/ui-token：全部退出换了令牌也跟着变）
    const tunnel = createTunnelService({
      paths: {
        tableFile: paths.tunnelsFile,
        keyFile: join(paths.tunnelDir, "id_ed25519"),
        knownHostsFile: join(paths.tunnelDir, "known_hosts"),
        pidFile: join(paths.tunnelDir, "ssh.pid"),
        peerSocket: paths.peerSock,
        hubSocket: paths.tunnelHubSock,
      },
      entryPort: DEFAULT_PEER_ENTRY_PORT,
      createInvite: (slotPort) => peers.createTunnelInvite(slotPort),
      onRemoveDevice: (deviceId) => peers.removeByTunnelSlot(deviceId),
    });
    parts.tunnel = tunnel;
    tunnel.onChange((status) => {
      if (status !== null) log(`${LOG_PREFIX} 隧道：${status.state}${status.detail ? `（${status.detail}）` : ""}`);
      if (status?.state === "connected") peers.onTunnelConnected();
    });
    await tunnel.start();
    const sha = (value: string) => createHash("sha256").update(value).digest();
    parts.tunnelAdmin = await startTunnelAdmin({
      runDir: paths.runDir,
      socketPath: paths.adminSock,
      authorize: (given) => {
        try {
          return timingSafeEqual(sha(given), sha(readFileSync(paths.uiTokenFile, "utf8").trim()));
        } catch {
          return false;
        }
      },
      service: tunnel,
      log: (line) => log(`${LOG_PREFIX} ${line}`),
    });
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
      db,
      rotateToken,
      tailnet,
      serveTarget,
      push,
      peers,
      tunnel,
      publicSock: paths.publicSock,
      publicEntryFile: paths.publicEntryFile,
      peerEntry: {
        socket: paths.peerSock,
        ...(process.platform === "linux" ? { port: port === 0 ? 0 : DEFAULT_PEER_ENTRY_PORT } : {}),
      },
      ...(serveTarget === "unix" ? { serveSocket: paths.uiSock } : {}),
    });
    const uiPort = parts.ui.port;
    listeningPort = uiPort;
    void tailnet.refresh().then((self) => {
      if (self === null) return;
      const target = serveTarget === "unix" ? { kind: "unix" as const, path: paths.uiSock } : { kind: "tcp" as const, port: uiPort };
      log(`${LOG_PREFIX} 联机：这台是 ${device.name}（${device.id}），tailnet 名字 ${self.dnsName}。别的设备、手机要访问，先跑一次：${serveCommandLine({ cli: tailscaleCli, target })}`);
      if (self.owner === null) log(`${LOG_PREFIX} 联机：这台打了 tag，问不到设备主人，经 tailnet 的访问会被拒绝；请设 ${ENV_TAILNET_OWNER}=<你的 Tailscale 登录名>`);
    });
    // 上线时把设备清单同步一遍：离线期间别的设备改了名、换了网址、加了新设备，这时补上；离线期间被移除的，对方会拒（401），这边自己删
    void tailnet.refresh().then(() => peers.announce());

    let stopping: Promise<void> | undefined;
    return {
      paths,
      port: parts.ui.port,
      url: loginUrl(parts.ui.port, token),
      stop: () => (stopping ??= shutdown()),
    };
  } catch (error) {
    await shutdown();
    // 界面端口被占（再开一个守护进程、别的程序占着）：换成带 port_in_use 的错，终端上只打一句话；原文留在 cause 里写日志
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && typeof (error as { port?: unknown }).port === "number") {
      throw new StartupError("port_in_use", String((error as { port: number }).port), { cause: error });
    }
    throw error;
  }
}

// 组装（m1-plan 第 3 节 W5，m2-plan 第 3 节接口约定第 6 条）：启动和关闭顺序、各块之间的接线。main.ts 只管命令行、信号和退出码。
// 启动和关机的顺序只在这个文件里定，别的文件不要自己起、关别的块：
// - 启动：目录锁 → 开库迁移、账本 → agent 接口和 hub 外壳 → 驱动层 → 清上次残留的 claude → 重启恢复、同步性格设定文件
//   → 第一次启动建项目经理 → 处理函数、执行器 → 界面令牌、界面服务。
// - 关机（启动到哪一步就关到哪一步）：准备命令 → 执行器 → claude → 界面服务 → agent 接口 → 取消订阅、关库 → 放锁。
// 用到的超时都在 src/shared/limits.ts。
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AGENT_API_CLOSE_MS,
  DEFAULT_PM_MODE,
  DEFAULT_UI_PORT,
  ENV_DEFAULT_MODEL,
  ENV_PORT,
  EXECUTOR_STOP_GRACE_MS,
  type ActionExecutor,
  type Driver,
  type Unsubscribe,
} from "../shared/index.ts";
import type { HubPaths } from "../shared/paths.ts";
import { LOG_PREFIX } from "../shared/names.ts";
import { resolveHubPaths, workerSetupLogPath } from "../shared/paths.ts";
import { createActionExecutor } from "./actions/index.ts";
import { createSessionTokens, installHubShim, startAgentApi, type RunningAgentApi } from "./agent-api/index.ts";
import { createClaudeDriver } from "./driver/index.ts";
import { addWorktree } from "./git/index.ts";
import {
  createSessionEndHandler,
  createSessionSendHandler,
  createSessionStartHandler,
  createWorktreeCreateHandler,
  endedOnRevokedTokens,
} from "./handlers.ts";
import { createLaunchPreparer } from "./launch.ts";
import { createLedger } from "./ledger/index.ts";
import { DEFAULT_PM_NAME, DEFAULT_PM_PERSONA } from "./prompt.ts";
import { createSetupRunner, type SetupRunner } from "./setup/index.ts";
import { acquireLock, createSessionStore, openStore, type Db, type DirLock } from "./store/index.ts";
import { loadOrCreateUiToken, loginUrl, startUiServer, type RunningUiServer } from "./ui-server/index.ts";

/** 网页打包产物（pnpm build 的输出）。 */
export const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../../dist/web", import.meta.url));

export interface DaemonOptions {
  env?: Record<string, string | undefined>;
  userHome: string;
  staticDir?: string;
  log?: (line: string) => void;
}

export interface RunningDaemon {
  paths: HubPaths;
  port: number;
  url: string;
  /** 关机：停准备命令 → 停执行器 → 停 claude → 关界面服务 → 关 agent 接口 → 关库 → 放锁。只做一次，多调返回同一个 Promise。 */
  stop(): Promise<void>;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_UI_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`${ENV_PORT} must be a port number, got ${raw}`);
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
  const port = parsePort(env[ENV_PORT]);

  // 启动到哪一步，关机就关到哪一步；顺序固定：准备命令 → 执行器 → 驱动层 → 界面服务 → agent 接口 → 库 → 锁
  // （准备命令最先：它不回调账本，重启后重跑；不先停的话执行器、关机要等它跑完）
  // （agent 接口在 claude 都退出之后才关：最后一轮里 agent 还可能敲 hub；它要用账本，所以在库之前）
  const parts: {
    setup?: SetupRunner;
    executor?: ActionExecutor;
    driver?: Driver;
    ui?: RunningUiServer;
    agentApi?: RunningAgentApi;
    db?: Db;
    lock?: DirLock;
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
    const { setup, executor, driver, ui, agentApi, db, lock } = parts;
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
    if (driver) await step("claude", () => driver.shutdown());
    if (ui) await step("界面服务", () => ui.close());
    if (agentApi) {
      await step("agent 接口", async () => {
        if (!(await within(agentApi.close(), AGENT_API_CLOSE_MS))) throw new Error(`${AGENT_API_CLOSE_MS / 1000} 秒没关完，不再等`);
      });
    }
    // claude 都退出了、事件都交给账本了，再取消订阅、关库
    for (const off of parts.unsubscribe.splice(0)) off();
    if (db) await step("数据库", () => db.close());
    if (lock) await step("目录锁", () => lock.release());
  };

  try {
    // 1. 目录锁
    parts.lock = acquireLock(paths.lockFile);
    // 2. 开库并迁移
    const { db } = openStore(paths);
    parts.db = db;
    // realpath 过的两个目录，账本和启动准备用同一份：
    // - stateDir：Worker 的记忆规则（policy.ts 的 stateDirDenyRule）按真实路径匹配；
    // - worktreesDir：Worker 的 cwd、项目经理的 --add-dir 都由它拼出来，和主文件夹、附加文件夹一样是真实路径
    //   （macOS 上 /var 是 /private/var；git worktree list 列的也是真实路径）。
    mkdirSync(paths.worktreesDir, { recursive: true });
    // uploadsDir 也是：用户在聊天框上传的文件，agent 拿到的是这个真实路径下的绝对路径（权限规则按真实路径匹配）
    mkdirSync(paths.uploadsDir, { recursive: true, mode: 0o700 });
    const uploadsDir = realpathSync.native(paths.uploadsDir);
    const stateDir = realpathSync.native(paths.stateDir);
    const worktreesDir = realpathSync.native(paths.worktreesDir);
    const ledger = createLedger(db, {
      pmHomeRoot: paths.pmHomeDir,
      personasDir: paths.personasDir,
      dataHome: paths.home,
      worktreesDir,
    });
    const sessions = createSessionStore(db);
    // 3. agent 接口（run/ 0700、删残留 socket、hub.sock 0600）和 hub 外壳，在执行器之前起。
    //    令牌只有这一份：agent 接口认人、prepareLaunch 发、session.end 处理函数作废，用的都是它
    const tokens = createSessionTokens();
    const agentApi = await startAgentApi({ ledger, tokens, runDir: paths.runDir, hubSock: paths.hubSock, log });
    parts.agentApi = agentApi;
    installHubShim({ binDir: paths.hubBinDir });
    const driver = createClaudeDriver({
      claudePath: paths.claudePath,
      sessionLogsDir: paths.sessionLogsDir,
      store: sessions,
      prepareLaunch: createLaunchPreparer({
        launchDir: paths.launchDir,
        stateDir,
        worktreesDir,
        getLaunchContext: (sessionId) => ledger.getLaunchContext(sessionId),
        tokens: endedOnRevokedTokens(tokens),
        // realpath 过的：写进 HUB_SOCK 和设置文件的 allowUnixSockets
        hubSock: agentApi.socketPath,
        hubBinDir: paths.hubBinDir,
      }),
    });
    parts.driver = driver;
    parts.unsubscribe.push(driver.onEvent((sessionId, event) => ledger.applyDriverEvent(sessionId, event)));

    // 4. 清掉上次留下的 claude
    await driver.cleanupStale();
    // 5. 重启恢复（账本那部分；执行器启动时再把“执行中”改回“待执行”），然后按数据库同步性格设定文件
    const recovered = ledger.recoverAfterRestart();
    if (recovered.resentMessageIds.length + recovered.requeuedMessageIds.length > 0) {
      log(`${LOG_PREFIX} 重启恢复：重发 ${recovered.resentMessageIds.length} 条，补发排队中的 ${recovered.requeuedMessageIds.length} 条`);
    }
    const synced = ledger.syncPersonaFiles();
    if (synced.recordedPmIds.length > 0) log(`${LOG_PREFIX} 发现 ${synced.recordedPmIds.length} 个手改过的性格设定文件，已记下修改`);
    // 6. 第一次启动建一个项目经理（createPm 自己写性格设定文件）
    if (ledger.snapshot().pms.length === 0) {
      const defaultModel = env[ENV_DEFAULT_MODEL] || undefined;
      const { pm } = ledger.createPm({ name: DEFAULT_PM_NAME, mode: DEFAULT_PM_MODE, persona: DEFAULT_PM_PERSONA, ...(defaultModel ? { defaultModel } : {}) });
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

    // 8. 界面令牌；9. 界面服务，只监听 127.0.0.1
    const token = loadOrCreateUiToken(paths.uiTokenFile);
    const staticDir = options.staticDir ?? DEFAULT_STATIC_DIR;
    if (!existsSync(staticDir)) log(`${LOG_PREFIX} 没找到网页文件 ${staticDir}，先跑 pnpm build`);
    parts.ui = await startUiServer({ ledger, token, port, staticDir, uploadsDir });

    let stopping: Promise<void> | undefined;
    return {
      paths,
      port: parts.ui.port,
      url: loginUrl(parts.ui.port, token),
      stop: () => (stopping ??= shutdown()),
    };
  } catch (error) {
    await shutdown();
    throw error;
  }
}

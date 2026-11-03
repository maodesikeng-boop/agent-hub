// 组装（m1-plan 第 3 节 W5）：启动和关闭顺序、各块之间的接线。main.ts 只管命令行、信号和退出码。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PM_MODE,
  DEFAULT_UI_PORT,
  ENV_DEFAULT_MODEL,
  ENV_PORT,
  type ActionExecutor,
  type Driver,
  type Unsubscribe,
} from "../shared/index.ts";
import type { HubPaths } from "../shared/paths.ts";
import { resolveHubPaths } from "../shared/paths.ts";
import { createActionExecutor } from "./actions/index.ts";
import { createClaudeDriver } from "./driver/index.ts";
import { createSessionSendHandler, createSessionStartHandler } from "./handlers.ts";
import { createLedger } from "./ledger/index.ts";
import { createLaunchPreparer, DEFAULT_PM_NAME, DEFAULT_PM_PERSONA, writeDefaultPersona } from "./prompt.ts";
import { acquireLock, createSessionStore, openStore, type Db, type DirLock } from "./store/index.ts";
import { loadOrCreateUiToken, loginUrl, startUiServer, type RunningUiServer } from "./ui-server/index.ts";

/** 网页打包产物（pnpm build 的输出）。 */
export const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../../dist/web", import.meta.url));
/** 关机时最多等执行器手上的动作多久；还没做完（比如在等 claude 启动）就先关驱动层，让它们结束。 */
const EXECUTOR_STOP_GRACE_MS = 3_000;

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
  /** 关机：停执行器 → 停 claude → 关界面服务 → 关库 → 放锁。只做一次，多调返回同一个 Promise。 */
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

  // 启动到哪一步，关机就关到哪一步；顺序固定：执行器 → 驱动层 → 界面服务 → 库 → 锁
  const parts: {
    executor?: ActionExecutor;
    driver?: Driver;
    ui?: RunningUiServer;
    db?: Db;
    lock?: DirLock;
    unsubscribe: Unsubscribe[];
  } = { unsubscribe: [] };
  const step = async (what: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (error) {
      log(`agent-hub: 关闭${what}时出错：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const shutdown = async () => {
    const { executor, driver, ui, db, lock } = parts;
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
    const ledger = createLedger(db, { pmHomeRoot: paths.pmHomeDir });
    const sessions = createSessionStore(db);
    const personasDir = join(paths.stateDir, "personas");
    const driver = createClaudeDriver({
      claudePath: paths.claudePath,
      sessionLogsDir: paths.sessionLogsDir,
      store: sessions,
      prepareLaunch: createLaunchPreparer({ db, launchDir: paths.launchDir, personasDir }),
    });
    parts.driver = driver;
    parts.unsubscribe.push(driver.onEvent((sessionId, event) => ledger.applyDriverEvent(sessionId, event)));

    // 3. 清掉上次留下的 claude
    await driver.cleanupStale();
    // 4. 重启恢复（账本那部分；执行器启动时再把“执行中”改回“待执行”）
    const recovered = ledger.recoverAfterRestart();
    if (recovered.resentMessageIds.length + recovered.requeuedMessageIds.length > 0) {
      log(`agent-hub: 重启恢复：重发 ${recovered.resentMessageIds.length} 条，补发排队中的 ${recovered.requeuedMessageIds.length} 条`);
    }
    // 5. 第一次启动建一个项目经理
    if (ledger.snapshot().pms.length === 0) {
      const defaultModel = env[ENV_DEFAULT_MODEL] || undefined;
      const { pm } = ledger.createPm({ name: DEFAULT_PM_NAME, mode: DEFAULT_PM_MODE, persona: DEFAULT_PM_PERSONA, ...(defaultModel ? { defaultModel } : {}) });
      writeDefaultPersona(personasDir, pm.id);
      log(`agent-hub: 第一次启动，建了项目经理“${pm.name}”`);
    }

    // 6. 处理函数、接线、启动执行器
    const executor = createActionExecutor(db, ledger);
    const deps = { driver, ledger, sessions };
    executor.register("session.start", createSessionStartHandler(deps));
    executor.register("session.send", createSessionSendHandler(deps));
    parts.unsubscribe.push(
      ledger.onActionEnqueued(() => executor.wake()),
      ledger.onStopRequested(({ sessionId }) => {
        driver.interrupt(sessionId).catch((error: unknown) => log(`agent-hub: 停止失败：${String(error)}`));
      }),
    );
    parts.executor = executor;
    executor.start();

    // 7. 界面令牌；8. 界面服务，只监听 127.0.0.1
    const token = loadOrCreateUiToken(paths.uiTokenFile);
    const staticDir = options.staticDir ?? DEFAULT_STATIC_DIR;
    if (!existsSync(staticDir)) log(`agent-hub: 没找到网页文件 ${staticDir}，先跑 pnpm build`);
    parts.ui = await startUiServer({ ledger, token, port, staticDir });

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

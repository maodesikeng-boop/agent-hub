// 种子数据（docs/ui-polish-loop-design.md 第 3.2 节）：用账本自己的接口和固定时钟，往一个空的数据目录里写一套固定的数据。
// 不变量：不直接写 SQL 造业务数据，形状由账本保证；同一个剧本写两次，库里除自增编号以外的内容和时间戳逐字段相同。
import type { Scenario } from "./screens.ts";

export interface SeedOptions {
  /** 守护进程的数据目录（AGENT_HUB_HOME），必须不存在或是空的。 */
  home: string;
  /** 放演示项目主文件夹的目录（路径会显示在界面上，所以由调用方给固定路径）。 */
  projectsDir: string;
  scenario: Scenario;
}

export interface SeedResult {
  /** 剧本里起了名字的东西对应的编号，到达步骤里用（如 `#/c/<pm.lin>`）。 */
  ids: Readonly<Record<string, number>>;
  /** 种子里最后一条数据的时间，浏览器的固定时间不能早于它。 */
  lastAt: number;
}

/**
 * 前置：home 是空的。
 * 后置：home 里是这个剧本的全部数据，时间戳从 SEED_START_ISO 起按固定步长走；
 * 没有留着等执行的动作（真守护进程起来后不会去起会话、建 worktree、改任何一行）。
 * home 不是空的抛 Error，不覆盖。
 */
export async function seedScenario(options: SeedOptions): Promise<SeedResult> {
  throw new Error("未实现");
}

export interface IsolatedDaemon {
  /** 带登录口令的网址，打开就登录。 */
  loginUrl: string;
  origin: string;
  stop(): Promise<void>;
}

/**
 * 在灌好种子的数据目录上起真守护进程：端口随机，各厂商命令都换成不存在的路径或假命令，不问真的 Tailscale，
 * 发的是当前工作区 `pnpm build` 出来的网页。
 * 后置：返回时已经能登录；stop 之后进程退出、端口释放。同一台机器上可以同时起几个（two-devices 剧本要两个）。
 */
export async function startIsolatedDaemon(options: { home: string; repoRoot: string; pairWith?: IsolatedDaemon }): Promise<IsolatedDaemon> {
  throw new Error("未实现");
}

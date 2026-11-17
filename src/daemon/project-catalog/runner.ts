// 后台写档的跑腿的（docs/router-project-catalog-design.md 第 3.6 节）：从账本领活、首次建档时读项目说明文件、
// 用总助的模型配置跑一轮独立单轮（router/single-turn.ts，purpose = catalog）、校验回复、报回账本。
// 只干活不做判断：到没到期、退避、算不算次数都在账本（ledger/project-catalog.ts）。
// 守护进程的接线在 daemon.ts：账本的 onCatalogClaimable → wake；启动时 start；关机时 stop。
import type { LedgerProjectCatalogWork } from "../../shared/project-catalog.ts";
import type { RouterModelResolution } from "../../shared/router-model.ts";
import type { RouterTurnRunner } from "../router/single-turn.ts";

export interface ColdStartFile {
  name: string;
  text: string;
}

export interface ProjectCatalogRunnerOptions {
  ledger: LedgerProjectCatalogWork;
  runTurn: RouterTurnRunner;
  /** 每份活开始前现选一次模型：和总助同一份 router_settings、同一个 resolveRouterModel。 */
  resolveModel: () => Promise<RouterModelResolution>;
  /** 首次建档读说明文件，默认 readColdStartFiles；测试换假的。 */
  readFiles?: (mainFolder: string) => Promise<ColdStartFile[]>;
  log: (line: string) => void;
  /** 默认 PROJECT_CATALOG_CONCURRENCY。 */
  concurrency?: number;
  /** 默认 PROJECT_CATALOG_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** 默认 PROJECT_CATALOG_TICK_MS。 */
  tickMs?: number;
  now?: () => number;
}

export interface ProjectCatalogRunner {
  /** 启动：领一次活，之后每 tickMs 兜底领一次。只生效一次。 */
  start(): void;
  /** 账本有项目进队列了。不在调用栈里领（账本可能在事务里叫），连叫几次合成一次。 */
  wake(): void;
  /** 关机：不再领；在做的打断并报 shutdown，收完尾才返回。多次调用返回同一个 Promise。 */
  stop(): Promise<void>;
  /** 有没有在写的档案（热重启判空闲用，daemon/self-reload.ts）。 */
  busy(): boolean;
}

/**
 * 后置：同时在写的不超过 concurrency 份；每份最多 timeoutMs，到了打断并报 timeout。
 * 模型选不出来（没有能用的厂商）报 model_unavailable，不起会话；回复取不出合格档案报 invalid_reply。
 * job.input.previous 是 null 时先读主文件夹里的说明文件放进 input.files，增量刷新不读文件。
 */
export function createProjectCatalogRunner(options: ProjectCatalogRunnerOptions): ProjectCatalogRunner {
  throw new Error("未实现");
}

/**
 * 读主文件夹顶层的 README.md、AGENTS.md、CLAUDE.md（按这个顺序，存在的才读）。
 * 后置：每个文件最多 PROJECT_CATALOG_FILE_MAX_CHARS 个字；读不到、不是普通文件、是软链指到文件夹外的跳过，不抛错。
 */
export async function readColdStartFiles(mainFolder: string): Promise<ColdStartFile[]> {
  throw new Error("未实现");
}

// 守护进程侧每家厂商交出来的东西（docs/vendor-plugin-design.md 3.3 节）：src/vendors/<id>/daemon.ts 默认导出一个 VendorDaemon，
// daemon-registry.ts 按名单加载；src/vendors/<id>/paths.ts 放只给守护进程用的路径（PATH 里找不到可执行文件时去哪找）。
// 只给守护进程用（会 import 驱动、起进程的代码），网页不引。现有的接口（VendorComposerBase、VendorCatalogProbe、SessionForker、Driver）原样复用。
import type { Driver, DriverOptions } from "../shared/index.ts";
import type { TranscriptRef, TranscriptRoots } from "../daemon/driver/transcript-files.ts";
import type { VendorCatalogSource } from "../daemon/driver/model-catalog.ts";
import type { SessionForker } from "../daemon/handover/forker.ts";
import type { VendorCatalogProbe, VendorCatalogSourceOptions, VendorComposer, VendorComposerBase } from "../daemon/vendors/types.ts";

/** 起驱动要的东西（守护进程给）：通用的 DriverOptions（executablePath 是解析好的可执行文件），加上按家可选的。 */
export interface VendorDriverDeps extends DriverOptions {
  /** 输入框不起进程的那部分；不给用这家自己的（daemon/vendors/index.ts 的 createVendorDrivers 按名单给）。 */
  composer?: VendorComposerBase;
  /** 未选模型时用的默认模型（spec 的 capabilities.explicitDefaultModel 为 true 的厂商才给）。 */
  defaultModel?: () => Promise<string | null>;
}

/** 起进程问命令列表要的东西（守护进程给）。 */
export interface VendorComposerDeps {
  executablePath: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface VendorDaemon {
  /** 必需：会话驱动（启动、恢复、发消息、打断、结束、清残留）。 */
  createDriver(deps: VendorDriverDeps): Driver;
  /**
   * 可选：输入框（"/" 命令、"@" 文件）。base 不起进程（账本、驱动层拼消息用），create 带上另起进程问命令列表。
   * 缺了用 _common/composer.ts：只认 spec.composer 的命令开头、隐藏名单，命令列表只有压缩命令。
   */
  composer?: { base: VendorComposerBase; create(deps: VendorComposerDeps): VendorComposer };
  /** 可选：模型名单和登录状态（同一次查询，不得打开会话、连 MCP、跑钩子）。缺了用打包的名单，状态 unknown（当能用）。 */
  catalog?: { probe: VendorCatalogProbe; source(options: VendorCatalogSourceOptions): VendorCatalogSource };
  /** 可选：换会话复制原对话的办法，按顺序试（id 所有厂商之间唯一，契约 S9）。缺了 = []，在本会话里写交接。 */
  forkers?: readonly SessionForker[];
  /** 可选：原始记录在哪（只读文件系统，找不到返回 null，不抛）。缺了 = null，交接里不给路径。 */
  transcriptPath?(ref: TranscriptRef, roots: TranscriptRoots): string | null;
}

/** 写 daemon.ts 用：只做类型检查。 */
export function defineVendorDaemon(daemon: VendorDaemon): VendorDaemon {
  return daemon;
}

/** 算兜底安装路径时公共代码（shared/paths.ts）给的东西。 */
interface FallbackPathsInput {
  userHome: string;
  platform: string;
  /** Linux 上各家官方安装方式放可执行文件的目录（shared/paths.ts 的 linuxInstallDirs）。 */
  linuxInstallDirs: readonly string[];
  join: (...parts: string[]) => string;
}

/** src/vendors/<id>/paths.ts 的导出（只给守护进程，不进网页包）。 */
export interface VendorPathsModule {
  /** PATH 里找不到可执行文件时按顺序去哪找。不写 = 只认 PATH。 */
  fallbackPaths?: (input: FallbackPathsInput) => string[];
}

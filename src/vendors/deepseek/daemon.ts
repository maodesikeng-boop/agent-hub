// deepseek 的守护进程侧（docs/vendor-plugin-design.md 3.3 节）：daemon-registry.ts 按名单加载这个文件的默认导出。
// - launchFiles：生成关闭 dsh 自带 Seatbelt/bwrap 沙箱（设为 danger-full-access）的 Cordis overlay patch 文件；
// - catalog：零子进程读取本地凭据就绪状态并返回打包目录（绝不拉起 dsh 新建持久空会话）；输入框命令、换代复制、原始记录走通用兜底。
import { defineVendorDaemon } from "../daemon-types.ts";
import { createDeepSeekCatalogSource, deepseekCatalogProbe } from "./catalog.ts";
import { buildDeepSeekPatchSettings, createDeepSeekDriver } from "./driver.ts";

export default defineVendorDaemon({
  createDriver: (deps) => createDeepSeekDriver(deps),
  catalog: {
    probe: deepseekCatalogProbe,
    source: (options) => createDeepSeekCatalogSource(options),
  },
  launchFiles: () => ({ settings: buildDeepSeekPatchSettings() }),
});

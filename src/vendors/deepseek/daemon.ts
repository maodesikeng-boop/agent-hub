// deepseek 的守护进程侧（docs/vendor-plugin-design.md 3.3 节）：daemon-registry.ts 按名单加载这个文件的默认导出。
// - launchFiles：生成关闭 dsh 自带 Seatbelt/bwrap 沙箱（设为 danger-full-access）的 Cordis overlay patch 文件；
// - 模型目录、输入框命令、换代复制、原始记录按方案第 4、6 节走通用兜底（不做会新建持久空会话的模型探测）。
import { defineVendorDaemon } from "../daemon-types.ts";
import { buildDeepSeekPatchSettings, createDeepSeekDriver } from "./driver.ts";

export default defineVendorDaemon({
  createDriver: (deps) => createDeepSeekDriver(deps),
  launchFiles: () => ({ settings: buildDeepSeekPatchSettings() }),
});

// 假厂商 acme 的守护进程侧（docs/vendor-plugin-design.md 第 4 节的“最小可跑的新厂商”）：只写必需的 createDriver，
// 输入框、模型名单、复制会话、原始记录都不写，走公共代码的兜底（daemon/vendors/index.ts、handover/forkers.ts、driver/transcript.ts）。
// 测试里没有真的 acme 程序：起会话报 spawn_failed（acme_not_found），别的操作什么都不做。
import { DriverError, type Driver } from "../../../../src/shared/index.ts";
import { defineVendorDaemon } from "../../../../src/vendors/daemon-types.ts";

export default defineVendorDaemon({
  createDriver: ({ executablePath }): Driver => ({
    start: async () => {
      const exe = typeof executablePath === "function" ? executablePath() : executablePath;
      throw new DriverError("spawn_failed", `acme_not_found: spawn ${exe} ENOENT`);
    },
    send: async () => {
      const exe = typeof executablePath === "function" ? executablePath() : executablePath;
      throw new DriverError("spawn_failed", `acme_not_found: spawn ${exe} ENOENT`);
    },
    interrupt: async () => {},
    end: async () => {},
    shutdown: async () => {},
    cleanupStale: async () => {},
    queryCommands: async () => null,
    onEvent: () => () => {},
  }),
});

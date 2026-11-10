// 守护进程侧的名单（docs/vendor-plugin-design.md 3.4 节）：按 registry.ts 的名单加载各家 ./<id>/daemon.ts，加厂商不用改这里
// （契约测试 S1 保证每家都有 daemon.ts）。DAEMON_VENDORS、FORKERS、vendorTranscriptPath 都从这里推出来。
// 加载失败直接让启动失败（与迁移前的静态 import 一致），不把坏模块伪装成未安装或缺少可选能力。
// 只给守护进程用。注意：各家 daemon.ts 及它引到的代码（驱动、协议、composer……）在运行时不能反过来引这个文件和从它推出来的
// daemon/vendors/index.ts、handover/forkers.ts、driver/transcript.ts（只许 import type）：顶层 await 的循环引用会卡死。
import type { VendorDaemon } from "./daemon-types.ts";
import { importVendorFile } from "./load.ts";
import { VENDOR_LIST, type AgentVendor } from "./registry.ts";

export const VENDOR_DAEMONS: Readonly<Record<AgentVendor, VendorDaemon>> = Object.fromEntries(
  await Promise.all(VENDOR_LIST.map(async (spec) => [spec.id, ((await importVendorFile(spec.id, "daemon.ts")) as { default: VendorDaemon }).default])),
) as Record<AgentVendor, VendorDaemon>;

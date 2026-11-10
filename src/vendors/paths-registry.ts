// 守护进程侧按名单加载各家 ./<id>/paths.ts（只给守护进程和脚本的纯数据：兜底路径、父会话变量、凭据变量、安装命令，不进网页包；
// 见 daemon-types.ts 的 VendorPathsModule）。同 daemon-registry.ts：加厂商不用改这里（契约测试 S1 保证每家都有 paths.ts）。
// 不引 node:fs：测试的 setupFiles（test/clean-env.ts）也引它，不能抢在测试文件 mock node:fs 之前把 fs 加载进来。
// 各家 paths.ts 只引 node:path、node:os 和自家 spec.ts，不会绕回这里。
import type { VendorPathsModule } from "./daemon-types.ts";
import { importVendorFile } from "./load.ts";
import { VENDOR_LIST, type AgentVendor } from "./registry.ts";

export const VENDOR_PATHS: Readonly<Record<AgentVendor, VendorPathsModule>> = Object.fromEntries(
  await Promise.all(VENDOR_LIST.map(async ({ id }) => [id, (await importVendorFile(id, "paths.ts")) as VendorPathsModule])),
) as Record<AgentVendor, VendorPathsModule>;

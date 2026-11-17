// 按项目经理管理用的库存（docs/pm-capabilities-design.md）：本机各厂商现在能看到的技能、MCP、云端连接器的并集。
// 来源：vendor-sync 已有的 scanMcp 和标准技能目录（engine.ts 的 scanAll），加上各家可选的 scanCapabilities（插件、厂商自带技能、账号连接器）。
// 只读：不写任何用户配置。缓存按 PM_CAPABILITY_INVENTORY_TTL_MS，配置文件、技能目录的 mtime 变了提前失效；
// 有厂商扫失败时只记 PM_CAPABILITY_INVENTORY_RETRY_MS。条目上限 PM_CAPABILITY_INVENTORY_MAX_ITEMS，超了 truncated。
import type { CapabilityInventory } from "../../shared/pm-capabilities.ts";
import type { VendorSyncContext } from "../../vendors/daemon-types.ts";

export interface CapabilityInventoryOptions {
  ctx: VendorSyncContext;
  now?: () => number;
}

export interface CapabilityInventoryService {
  /**
   * 后置：projectDir 给了时含该项目 `.agents/skills`、`.claude/skills` 里的技能（分组 source 为 project）。
   * 同一个 projectDir 在缓存有效期内返回同一个对象（引用相同）。一家扫失败不影响别家，那家的项不出现。
   */
  get(scope: { projectDir: string | null }): Promise<CapabilityInventory>;
  /** 后置：下一次 get 重新扫描（vendor-sync apply 之后、用户点刷新时调）。 */
  invalidate(): void;
}

export function createCapabilityInventory(options: CapabilityInventoryOptions): CapabilityInventoryService {
  throw new Error("未实现");
}

// 项目经理的技能、MCP、云端连接器选择（pm_capability_policies、pm_capability_overrides，迁移 0033；docs/pm-capabilities-design.md）。
// 没有行的项目经理等于三类都是 all、没有单独设置；删项目经理时外键级联删掉。
// 改了选择发 pm.updated，驱动层在下一条消息前按 fingerprint 重启这个项目经理和它的 Worker。
import type { PmId } from "../../shared/domain.ts";
import type { PmCapabilitiesPatch, PmCapabilitiesStart, PmCapabilityPolicy } from "../../shared/pm-capabilities.ts";
import type { LedgerContext } from "./context.ts";

export interface LedgerPmCapabilities {
  /** 后置：没存过返回 defaultPmCapabilityPolicy。项目经理不存在抛 not_found。 */
  get(pmId: PmId): PmCapabilityPolicy;
  /**
   * 后置：在一个事务里应用 patch（applyCapabilitiesPatch），返回改完的 policy。
   * set 超过 PM_CAPABILITY_PATCH_MAX_KEYS 项、改完 overrides 超过 PM_CAPABILITY_OVERRIDES_MAX 项时拒绝（invalid_input），什么都不改。
   */
  patch(pmId: PmId, patch: PmCapabilitiesPatch): PmCapabilityPolicy;
  /** 后置：新建项目经理时调。from 为 all 不写行；from 为 pm 时复制那个项目经理的 base 和 overrides，源项目经理不存在抛 not_found。 */
  init(pmId: PmId, start: PmCapabilitiesStart): void;
}

export function createLedgerPmCapabilities(ctx: LedgerContext): LedgerPmCapabilities {
  throw new Error("未实现");
}

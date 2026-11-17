// 项目经理能力页（技能、MCP、云端连接器）的纯数据选择：搜索、只看开着的、组开关状态、摘要（docs/pm-capabilities-design.md）。
// 引用稳定：同一个 view 对象、同样的 query 和 filter 返回同一个数组（WeakMap 按 view 缓存），memo 的行不重画。
import type {
  CapabilityGroup,
  CapabilityItem,
  CapabilityKind,
  PmCapabilitiesView,
} from "../shared/index.ts";

export type CapabilityFilter = "all" | "on" | "off";

/** 组开关的样子：全开、全关、部分开（开关显示成横杠）。 */
export type GroupToggleState = "on" | "off" | "mixed";

export interface VisibleCapabilityGroup {
  group: CapabilityGroup;
  items: readonly CapabilityItem[];
  state: GroupToggleState;
  enabledCount: number;
}

/**
 * 后置：只含 kind 这一类、名字或说明里含 query（不分大小写，去掉首尾空白）的项，按 filter 留开着或关着的；
 * 一项都不剩的组不返回。组按 label 排序，组里按名字排序。
 */
export function visibleCapabilityGroups(
  view: PmCapabilitiesView,
  kind: CapabilityKind,
  query: string,
  filter: CapabilityFilter,
): readonly VisibleCapabilityGroup[] {
  throw new Error("未实现");
}

/** 后置：资料页那一行右边的摘要，开着几项（数字）；这一类一项都没有返回 null（那一行不显示）。 */
export function capabilitySummary(view: PmCapabilitiesView, kind: CapabilityKind): number | null {
  throw new Error("未实现");
}

/** 后置：这一组里能用这家却只能共用全局配置的厂商名（isolation 为 shared），给组标题旁的标签用；没有返回空数组。 */
export function sharedVendorLabels(view: PmCapabilitiesView, group: CapabilityGroup): readonly string[] {
  throw new Error("未实现");
}

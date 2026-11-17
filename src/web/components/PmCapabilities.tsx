// 项目经理资料页里的 Skills、MCP servers、Connectors 三行，和点开后的列表（docs/pm-capabilities-design.md 的界面一节）。
// 电脑外壳点行打开 PmCapabilitiesDialog；手机外壳进整屏页 #/pm/<id>/capabilities/<kind>（mobile/PmCapabilitiesPage.tsx），
// 两边共用 CapabilityList。数据走 @tanstack/react-query（GET/PATCH /api/pms/:id/capabilities），开关改了马上存，失败退回并在行下写原因。
import type { JSX } from "react";
import type { CapabilityKind, PmId } from "../../shared/index.ts";

/** 资料页里的一组三行（SettingsNavRow 样式）：名字、开着几项、右箭头；这一类没有项的那一行不显示。 */
export function PmCapabilitiesRows(props: { pmId: PmId; onOpen: (kind: CapabilityKind) => void }): JSX.Element {
  throw new Error("未实现");
}

/** 列表本体：搜索框、New items 分段选择、按来源分组（组标题行带组开关）、每项一行带开关。 */
export function CapabilityList(props: { pmId: PmId; kind: CapabilityKind }): JSX.Element {
  throw new Error("未实现");
}

/** 电脑外壳：资料页上方的弹窗，标题是类名，内容是 CapabilityList，没有底部按钮（改了马上存）。 */
export function PmCapabilitiesDialog(props: {
  pmId: PmId;
  kind: CapabilityKind | null;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  throw new Error("未实现");
}

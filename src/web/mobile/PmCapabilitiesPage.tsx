// 手机外壳的整屏能力页 #/pm/<id>/capabilities/<kind>：顶栏返回 + 类名，下面是 CapabilityList（docs/ui-standard.md 第 20 条）。
import type { JSX } from "react";
import type { CapabilityKind, PmId } from "../../shared/index.ts";

export function PmCapabilitiesPage(props: { pmId: PmId; kind: CapabilityKind }): JSX.Element {
  throw new Error("未实现");
}

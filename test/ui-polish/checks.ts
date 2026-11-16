// 机器检查（docs/ui-polish-loop-design.md 第 3.3 节）：截图的同时在页面里量出来的硬毛病。
// 裁切、溢出、对比度、点击区域这些是量得出来的，不交给评委用眼睛猜；量出来的直接算成“行业标准”这一项的发现，也当作事实告诉评委。
import type { Page } from "playwright";
import type { Finding } from "./rubric.ts";

export const MACHINE_CHECKS = [
  { id: "clipped", severity: "P0", what: "元素的内容超出了会裁切它的祖先，露不全（没有截断样式的）" },
  { id: "page-overflow", severity: "P0", what: "页面或弹窗出现横向滚动" },
  { id: "overlap", severity: "P0", what: "两个能点的东西的可点范围互相盖住" },
  { id: "contrast", severity: "P1", what: "文字对比度不到 WCAG AA（axe-core 的 color-contrast）" },
  { id: "touch-target", severity: "P1", what: "触屏视口下可点范围小于 44×44px" },
  { id: "truncated-no-title", severity: "P2", what: "文字被截成省略号，却没有 title 放全文" },
  { id: "off-scale-font", severity: "P2", what: "界面外壳的字号不在四档字号里" },
  { id: "dot-joined", severity: "P2", what: "界面外壳的字里用“·”“|”拼接" },
] as const;
export type MachineCheckId = (typeof MACHINE_CHECKS)[number]["id"];

/** 机器量出来的一条：形状同评委的发现，rule 是 `machine:<检查 id>`，另带量到的数。 */
export interface MachineFinding extends Finding {
  /** 量到的数和选择器，给修的人定位。 */
  evidence: string;
}

/**
 * 前置：页面已经画稳。
 * 后置：返回这一屏量出来的全部毛病，位置是占视口的比例；同一个元素同一种毛病只报一条。
 * 只读页面，不改 DOM、不滚动。
 */
export async function runMachineChecks(page: Page, options: { touch: boolean }): Promise<MachineFinding[]> {
  throw new Error("未实现");
}

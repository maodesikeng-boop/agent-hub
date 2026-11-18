import type { ReactElement, ReactNode } from "react";
import type { SlimeLook } from "../../shared/slimes.ts";
import type { ErrorLike } from "../format.ts";

/**
 * 换形象的浮层（docs/slime-cohesion-design.md；样子照 docs/ui-standard.md 第 11 条 Popover）：
 * 上面一组 Fruit：20 个造型，都按当前颜色画；下面一组 Color：全部颜色的色板。
 * - 点一个造型或颜色马上调 onChange（只换被点的那一项），浮层不关；选中的造型是果冻底，选中的颜色外面一圈中性细环。
 * - error 不为空时在浮层最下面一行写原因（RowError）；键盘能用方向键在格子里走、Enter 选中，Esc 和点外面关浮层。
 * - children 是触发它的头像按钮（资料页头部、新建项目经理弹窗）。
 */
export function SlimePicker({
  look,
  onChange,
  error,
  children,
}: {
  look: SlimeLook;
  onChange: (next: SlimeLook) => void;
  error?: ErrorLike | null;
  children: ReactElement;
}): ReactNode {
  throw new Error("未实现");
}

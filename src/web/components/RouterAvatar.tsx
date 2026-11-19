import type { ReactNode } from "react";

/**
 * 总助的头像（docs/slime-cohesion-design.md）：嫩芽铃，12×12 像素形象，透明底，不套框，不设 --fruit、--jelly。
 * - size 是“标准”界面大小（根字号 16px）下的像素数，写成 rem，跟着界面大小缩放（同 Avatar）。
 * - working 时以提钮为轴左右摇一下（±14°，和项目经理蹦跳同一个节奏，styles.css 的 --motion-hop-cycle），鼠标停上去摇一次；减弱动态效果时不动。
 * - 读屏不念（aria-hidden），名字由旁边的字给。
 */
export function RouterAvatar({ size = 44, working = false, className }: { size?: number; working?: boolean; className?: string }): ReactNode {
  throw new Error("未实现");
}

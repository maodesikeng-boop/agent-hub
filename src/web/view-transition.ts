import { flushSync } from "react-dom";

/**
 * 切换对话用浏览器原生的 View Transitions（docs/ui-standard.md 第 14 条）：只有顶栏的头像和标题起了 view-transition-name
 * （styles.css 的 .vt-chat-avatar / .vt-chat-title，:root 设成 none），整页和消息列表不截快照。
 * 浏览器不支持、或者系统开了“减弱动态效果”：直接换，没有动画。
 * https://developer.mozilla.org/docs/Web/API/Document/startViewTransition
 */
export function withViewTransition(update: () => void): void {
  if (typeof document.startViewTransition !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  // 回调里要同步把新页面画出来（flushSync），浏览器才拍得到“之后”的样子
  document.startViewTransition(() => flushSync(update));
}

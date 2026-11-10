import { Activity, type ReactNode } from "react";

// 电脑也经过这里（display: contents 不占盒子）：断点切换时聊天区的位置和类型不变，输入框等子树不重建。
export function MobileShell({ mobile, list, sidebar, children }: { mobile: boolean; list: boolean; sidebar: ReactNode; children: ReactNode }) {
  return <div data-shell={mobile ? "mobile" : "desktop"} className={mobile ? "mobile-shell flex h-full min-w-0 flex-1" : "contents"}>
    <Activity mode={!mobile || list ? "visible" : "hidden"}>{sidebar}</Activity>
    {(!mobile || !list) && children}
  </div>;
}

import { Activity, type ReactNode } from "react";
import { useKeyboardInset } from "./keyboard.ts";

export function MobileShell({ mobile, list, sidebar, children }: { mobile: boolean; list: boolean; sidebar: ReactNode; children: ReactNode }) {
  useKeyboardInset(mobile);
  return <div data-shell={mobile ? "mobile" : "desktop"} className={mobile ? "mobile-shell flex h-full min-w-0 flex-1" : "contents"}>
    <Activity mode={!mobile || list ? "visible" : "hidden"}>{sidebar}</Activity>
    {(!mobile || !list) && children}
  </div>;
}

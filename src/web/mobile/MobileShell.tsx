import { Activity, type ReactNode } from "react";
import { useKeyboardInset } from "./keyboard.ts";

export function MobileShell({
  mobile,
  list,
  sidebar,
  tabBar,
  children,
}: {
  mobile: boolean;
  list: boolean;
  sidebar: ReactNode;
  tabBar?: ReactNode;
  children: ReactNode;
}) {
  const keyboardOpen = useKeyboardInset(mobile);
  if (!mobile) {
    return (
      <div data-shell="desktop" className="contents">
        {sidebar}
        {children}
      </div>
    );
  }
  return (
    <div data-shell="mobile" className="mobile-shell flex h-full min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1">
        <Activity mode={list ? "visible" : "hidden"}>{sidebar}</Activity>
        {!list && children}
      </div>
      {!keyboardOpen && tabBar}
    </div>
  );
}

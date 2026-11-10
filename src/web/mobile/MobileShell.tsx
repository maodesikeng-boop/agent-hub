import { Activity, type ReactNode } from "react";

export function MobileShell({ list, sidebar, children }: { list: boolean; sidebar: ReactNode; children: ReactNode }) {
  return <div data-shell="mobile" className="mobile-shell flex h-full min-w-0 flex-1">
    <Activity mode={list ? "visible" : "hidden"}>{sidebar}</Activity>
    {!list && children}
  </div>;
}

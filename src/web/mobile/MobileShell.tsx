import type { ReactNode } from "react";
import { useKeyboardInset } from "./keyboard.ts";

export function MobileShell({ tabBar, children }: { tabBar?: ReactNode; children: ReactNode }) {
  const keyboardOpen = useKeyboardInset(true);
  return (
    <div data-shell="mobile" className="mobile-shell flex h-full min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
      {!keyboardOpen && tabBar}
    </div>
  );
}

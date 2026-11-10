import type { ReactNode } from "react";

/** 手机的整屏对话容器，顶栏和消息仍由共用的 Conversation 渲染。 */
export function MobileChat({ children }: { children: ReactNode }) {
  return <main className="chat-main tint-fade flex min-h-0 min-w-0 flex-1 flex-col bg-surface-chat">{children}</main>;
}

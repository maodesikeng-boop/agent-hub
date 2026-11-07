// 服务端所在机器能做什么（/api/state 的 server）：整个页面共用一份，控件按它显示（“选择…”、“在 Finder 中显示”）。
// 不看浏览器的系统：浏览器可能在 Mac 上，守护进程在 Linux 服务器上（SSH 隧道）。没有 Provider（单个组件的测试）时按 macOS 的全有。
import { createContext, useContext, type ReactNode } from "react";
import { serverInfoFor, type ServerInfo } from "../shared/index.ts";

const ServerInfoContext = createContext<ServerInfo>(serverInfoFor("darwin"));

export function ServerInfoProvider({ value, children }: { value: ServerInfo; children: ReactNode }) {
  return <ServerInfoContext.Provider value={value}>{children}</ServerInfoContext.Provider>;
}

export function useServerInfo(): ServerInfo {
  return useContext(ServerInfoContext);
}

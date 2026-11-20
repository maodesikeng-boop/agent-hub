import { createContext, useContext, type ReactNode } from "react";
import { serverInfoFor, type ServerInfo } from "../shared/index.ts";

const ServerInfoContext = createContext<ServerInfo>(serverInfoFor("darwin"));

export function ServerInfoProvider({ value, children }: { value: ServerInfo; children: ReactNode }) {
  return <ServerInfoContext.Provider value={value}>{children}</ServerInfoContext.Provider>;
}

export function useServerInfo(): ServerInfo {
  return useContext(ServerInfoContext);
}

// 页面里一块区域属于哪台设备（docs/multi-device-design.md 第 4.1 节）：里面的组件取数据、拼文件链接、看平台能力、选模型都用这台的。
// 没有 DeviceScope（单个组件的测试、只有本机时的外层）就是入口本机。
import { createContext, useContext, type ReactNode } from "react";
import type { ServerInfo } from "../shared/index.ts";
import { localClient, type HubClient } from "./client.ts";
import { ServerInfoProvider } from "./server-info.tsx";

const ClientContext = createContext<HubClient>(localClient);

/** client：这台设备的接口；server：这台的 /api/state 里的平台能力。 */
export function DeviceScope({ client, server, children }: { client: HubClient; server: ServerInfo; children: ReactNode }) {
  return (
    <ClientContext.Provider value={client}>
      <ServerInfoProvider value={server}>{children}</ServerInfoProvider>
    </ClientContext.Provider>
  );
}

/** 当前区域那台设备的接口。 */
export function useClient(): HubClient {
  return useContext(ClientContext);
}

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

/** 舰队视图（总助）里按设备键找那台的接口和平台能力；找不到（设备刚被删）是 null。 */
export type DeviceScopeLookup = (deviceKey: string) => { client: HubClient; server: ServerInfo } | null;

const FleetContext = createContext<DeviceScopeLookup | null>(null);

/** 总助这种一页里混着几台设备条目的地方：在外面给出按设备键找接口的办法，里面的条目用 DeviceScopeOf 包住自己。 */
export function FleetDeviceScopes({ lookup, children }: { lookup: DeviceScopeLookup; children: ReactNode }) {
  return <FleetContext.Provider value={lookup}>{children}</FleetContext.Provider>;
}

/** 这块内容属于 deviceKey 那台设备：文件地址、预览窗的按钮都按那台的。外面没有 FleetDeviceScopes 或找不到设备时照外层的。 */
export function DeviceScopeOf({ deviceKey, children }: { deviceKey: string; children: ReactNode }) {
  const scope = useContext(FleetContext)?.(deviceKey) ?? null;
  if (scope === null) return children;
  return (
    <DeviceScope client={scope.client} server={scope.server}>
      {children}
    </DeviceScope>
  );
}

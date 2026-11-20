import { createContext, useContext, type ReactNode } from "react";
import type { PmId, ServerInfo } from "../shared/index.ts";
import { defaultLookOf, type SlimeLook } from "../shared/slimes.ts";
import { localClient, type HubClient } from "./client.ts";
import { ServerInfoProvider } from "./server-info.tsx";

const ClientContext = createContext<HubClient>(localClient);

export function DeviceScope({ client, server, children }: { client: HubClient; server: ServerInfo; children: ReactNode }) {
  return (
    <ClientContext.Provider value={client}>
      <ServerInfoProvider value={server}>{children}</ServerInfoProvider>
    </ClientContext.Provider>
  );
}

export function useClient(): HubClient {
  return useContext(ClientContext);
}

export type DeviceScopeLookup = (deviceKey: string) => { client: HubClient; server: ServerInfo } | null;

const FleetContext = createContext<DeviceScopeLookup | null>(null);

export function FleetDeviceScopes({ lookup, children }: { lookup: DeviceScopeLookup; children: ReactNode }) {
  return <FleetContext.Provider value={lookup}>{children}</FleetContext.Provider>;
}

export function DeviceScopeOf({ deviceKey, children }: { deviceKey: string; children: ReactNode }) {
  const scope = useContext(FleetContext)?.(deviceKey) ?? null;
  if (scope === null) return children;
  return (
    <DeviceScope client={scope.client} server={scope.server}>
      {children}
    </DeviceScope>
  );
}

export type FleetLookOf = (deviceKey: string, pmId: PmId) => SlimeLook;

const LooksContext = createContext<FleetLookOf>((_deviceKey, pmId) => defaultLookOf(pmId));

export function FleetLooks({ lookOf, children }: { lookOf: FleetLookOf; children: ReactNode }) {
  return <LooksContext.Provider value={lookOf}>{children}</LooksContext.Provider>;
}

export function useFleetLookOf(): FleetLookOf {
  return useContext(LooksContext);
}

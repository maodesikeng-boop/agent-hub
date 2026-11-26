import { useCallback, useMemo, useState } from "react";
import type { AgentVendor } from "../shared/index.ts";
import type { DeviceKey } from "./devices.ts";

interface ProviderSheet {
  deviceKey: DeviceKey;
  vendor: AgentVendor;
  mode: "signin" | "account";
}

export function useProviderSheet() {
  const [sheet, open] = useState<ProviderSheet | null>(null);
  const setMode = useCallback((mode: ProviderSheet["mode"]) => {
    open((current) => current === null || current.mode === mode ? current : { ...current, mode });
  }, []);
  const close = useCallback(() => open(null), []);
  return useMemo(() => ({ sheet, open, setMode, close }), [sheet, setMode, close]);
}

interface ComputerRename {
  deviceKey: DeviceKey;
  name: string;
}

export function useComputerRename() {
  const [rename, setRename] = useState<ComputerRename | null>(null);
  const start = useCallback((deviceKey: DeviceKey, name: string) => setRename({ deviceKey, name }), []);
  const setName = useCallback((name: string) => {
    setRename((current) => current === null || current.name === name ? current : { ...current, name });
  }, []);
  const finish = useCallback(() => setRename(null), []);
  return useMemo(() => ({ rename, start, setName, finish }), [rename, start, setName, finish]);
}

export type ComputerRenameApi = ReturnType<typeof useComputerRename>;

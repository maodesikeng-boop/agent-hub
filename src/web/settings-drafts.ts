import type { AgentVendor } from "../shared/index.ts";
import type { DeviceKey } from "./devices.ts";

// Invariant: held in memory only, never written to storage, at most one provider sheet and one rename at a time. Both the
// settings dialog and the one-column settings pages read and write the same values.

export interface ProviderSheet {
  deviceKey: DeviceKey;
  vendor: AgentVendor;
  mode: "signin" | "account";
}

export interface ComputerRename {
  deviceKey: DeviceKey;
  name: string;
}

export interface ProviderSheetApi {
  sheet: ProviderSheet | null;
  open: (sheet: ProviderSheet) => void;
  /** Switches an open sheet between sign-in and account; no-op while closed. */
  setMode: (mode: ProviderSheet["mode"]) => void;
  /**
   * Closes the sheet. byUser is true for a close the user asked for, which cancels a sign-in flow this client owns; a sheet
   * that unmounts without close() keeps its flow running.
   */
  close: (byUser: boolean) => void;
}

/** Postcondition: the same sheet object until open, setMode, or close changes it; both settings presentations see each change. */
export function useProviderSheet(): ProviderSheetApi {
  throw new Error("Not implemented");
}

export interface ComputerRenameApi {
  rename: ComputerRename | null;
  /** Starts renaming deviceKey from its current name, replacing any other rename in progress. */
  start: (deviceKey: DeviceKey, name: string) => void;
  setName: (name: string) => void;
  /** Ends the rename after a save or a cancel. */
  finish: () => void;
}

/** Postcondition: the typed name survives any remount of the editor until finish() runs. */
export function useComputerRename(): ComputerRenameApi {
  throw new Error("Not implemented");
}

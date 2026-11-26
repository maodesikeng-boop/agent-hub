import type { ComponentProps } from "react";
import { LOCAL_DEVICE, type DeviceKey } from "../devices.ts";
import { useComputerRename } from "../settings-drafts.ts";
import { Surface, SurfaceScope } from "../shell-surfaces.tsx";
import { settingsBodies, WorkbenchSettings } from "../WorkbenchSettings.tsx";
import { AccountSettings } from "./AccountSettings.tsx";
import { CapabilitiesSettings } from "./CapabilitiesSettings.tsx";
import { ResourcesSettings } from "./ResourcesSettings.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";

export function SettingsDialogFixture({ defaultProviderDevice = LOCAL_DEVICE, ...props }:
  Omit<ComponentProps<typeof SettingsDialog>, "bodies" | "rename"> & { defaultProviderDevice?: DeviceKey }) {
  const rename = useComputerRename();
  return (
    <SurfaceScope>
      <SettingsDialog {...props} bodies={settingsBodies} rename={rename} />
      <WorkbenchSettings
        mobile={false}
        section={props.section === "providers" ? "providers" : undefined}
        notify={props.notify}
        devices={props.devices ?? null}
        defaultProviderDevice={defaultProviderDevice}
        rename={rename}
        onOpen={() => {}}
        onBack={() => {}}
      />
      {props.section === "capabilities" && <Surface id="settings:capabilities"><CapabilitiesSettings /></Surface>}
      {props.section === "resources" && <Surface id="settings:resources"><ResourcesSettings /></Surface>}
      {props.devices != null && (props.section === "computers" || props.section === undefined) && <Surface id="settings:account"><AccountSettings /></Surface>}
    </SurfaceScope>
  );
}

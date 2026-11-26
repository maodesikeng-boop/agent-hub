import { Loader2, Pencil } from "../ui/icons.ts";
import { useState, type ReactNode } from "react";
import {
  DEFAULT_AGENT_SETTING,
  MAX_PERSONA_BYTES,
  DEFAULT_PM_MODE,
  isSelectable,
  normalizeName,
  pickableVendorCatalogs,
  utf8Bytes,
  type ConversationId,
  type AgentVendor,
  type PmMode,
  type ServerInfo,
} from "../../shared/index.ts";
import type { HubClient } from "../client.ts";
import { pickNewPmLook, type SlimeLook } from "../../shared/slimes.ts";
import { DeviceScope, useClient } from "../device-scope.tsx";
import { isReadOnly, type DeviceKey, type DeviceStatus } from "../devices.ts";
import { errorText, nameError, errorLine, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useModelCatalog, useModelCatalogs } from "../models.tsx";
import { useServerInfo } from "../server-info.tsx";
import { useMobileShell } from "../shell-layout.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogForm } from "../ui/dialog.tsx";
import { Input, Textarea } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { AgentRows, draftOf, settingOf } from "./AgentRows.tsx";
import { Avatar } from "./Avatar.tsx";
import { ModeSelect } from "./ModeRows.tsx";
import { SlimePicker } from "./SlimePicker.tsx";
import { CollapsibleGroup, InfoAction, RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

const FIELD_WIDTH = "w-64";

export interface NewPmDevice {
  key: DeviceKey;
  name: string;
  status: DeviceStatus;
  client: HubClient;
  server: ServerInfo;
  takenLooks: readonly SlimeLook[];
}

function NewPmForm({
  mobile,
  deviceRow,
  takenLooks,
  onCreated,
  onManageProviders,
}: {
  mobile: boolean;
  deviceRow: ReactNode;
  takenLooks: readonly SlimeLook[];
  onCreated: (conversationId: ConversationId) => void;
  onManageProviders?: () => void;
}) {
  const client = useClient();
  const [pickedLook, setPickedLook] = useState<SlimeLook | null>(null);
  const look = pickedLook ?? pickNewPmLook(takenLooks, 0);
  const allCatalogs = useModelCatalogs();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [mode, setMode] = useState<PmMode>(DEFAULT_PM_MODE);
  const [agent, setAgent] = useState(() => draftOf(DEFAULT_AGENT_SETTING));
  const [persona, setPersona] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<ErrorLike | null>(null);
  const canPick = useServerInfo().folderPicker;

  const cleanName = normalizeName(name);
  const nameProblem = nameError(name);
  const personaTooLong = utf8Bytes(persona) > MAX_PERSONA_BYTES;
  const agentCatalog = useModelCatalog(agent.vendor);
  const agentResult = settingOf(agent, agentCatalog);
  const vendorUsable = isSelectable(agentCatalog.availability);
  const canSubmit = cleanName !== null && !personaTooLong && agentResult.ok && vendorUsable && !busy;
  const zeroProvidersReady = allCatalogs.length > 0 && pickableVendorCatalogs(allCatalogs).length === 0;

  const pickFolder = async () => {
    setPicking(true);
    setPickError(null);
    try {
      const startDir = folder.trim();
      const { path } = await client.postPickFolder(startDir ? { startDir } : {});
      if (path !== null) setFolder(path);
    } catch (err) {
      setPickError(errorText(err));
    } finally {
      setPicking(false);
    }
  };

  const submit = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (cleanName === null || !canSubmit || !agentResult.ok) return;
    setBusy(true);
    setError(null);
    try {
      const { vendor, model, effort } = agentResult.setting;
      const mainFolder = folder.trim();
      const res = await client.postCreatePm({
        name: cleanName,
        mode,
        vendor,
        ...(model !== null ? { defaultModel: model } : {}),
        ...(effort !== null ? { effort } : {}),
        persona,
        ...(mainFolder ? { folder: mainFolder } : {}),
        ...(pickedLook !== null ? { look: pickedLook } : {}),
      });
      onCreated(res.conversationId);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <DialogForm className={mobile ? "gap-0" : undefined} onSubmit={(e) => void submit(e)}>
      <DialogBody className={mobile ? "mx-0 my-0 px-4 py-4" : undefined}>
        <div className="info-list grid grid-cols-1">
          <div className="flex items-center gap-3 pb-3">
            <SlimePicker look={look} onChange={setPickedLook}>
              <button type="button" aria-label="Change look" title="Change look" className="info-avatar touch-target shrink-0">
                <Avatar look={look} size={44} />
                <span aria-hidden="true" className="info-avatar-pen">
                  <Pencil className="size-2.5" aria-hidden="true" />
                </span>
              </button>
            </SlimePicker>
            <div className="min-w-0 flex-1">
              <Input
                aria-label="Name"
                placeholder="Name"
                value={name}
                autoFocus={!mobile}
                autoComplete="off"
                className="h-8 w-full text-minor"
                aria-invalid={nameProblem !== null}
                onChange={(e) => setName(e.target.value)}
              />
              {nameProblem && <RowError error={nameProblem} />}
            </div>
          </div>
          <SettingsGroup label="Project manager">
            {deviceRow}
            <SettingsRow label="Main folder" stacked={mobile} error={pickError}>
              {(id) => (
                <div className={cn("flex items-center gap-4.5", mobile ? "min-w-0 flex-1" : FIELD_WIDTH)}>
                  <Input
                    id={id}
                    value={folder}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="Optional"
                    className="h-7.5 min-w-0 flex-1 text-minor"
                    onChange={(e) => setFolder(e.target.value)}
                  />
                  {canPick && (
                    <InfoAction className="shrink-0" disabled={picking || busy} onClick={() => void pickFolder()}>
                      {picking && <Loader2 className="size-3.5" aria-hidden="true" />}
                      Choose…
                    </InfoAction>
                  )}
                </div>
              )}
            </SettingsRow>
            <SettingsRow label="Mode">{(id) => <ModeSelect id={id} value={mode} onChange={setMode} disabled={busy} />}</SettingsRow>
            <CollapsibleGroup title="More settings" defaultOpen={zeroProvidersReady}>
              <section aria-label="Model">
                <AgentRows
                  value={agent}
                  onChange={setAgent}
                  disabled={busy}
                  stacked={mobile}
                  {...(onManageProviders !== undefined ? { onManageProviders } : {})}
                />
              </section>
              <Textarea
                aria-label="Persona"
                placeholder="Persona"
                rows={3}
                className="mt-1 block max-h-[60vh] min-h-20 w-full resize-none border-0 bg-transparent px-0 py-1.5 font-mono text-minor placeholder:font-sans placeholder:text-minor field-sizing-content focus:border-0 focus:shadow-none"
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
              />
              {personaTooLong && <RowError>Persona is too long</RowError>}
            </CollapsibleGroup>
          </SettingsGroup>
        </div>
      </DialogBody>
      {error && (
        <p role="alert" title={errorTitle(error)} className={cn("text-minor text-danger [overflow-wrap:anywhere]", mobile && "px-4 pb-2")}>
          {errorLine(error)}
        </p>
      )}
      <DialogFooter className={mobile ? "border-t border-border bg-panel px-4 py-3" : undefined}>
        <Button type="submit" size={mobile ? "default" : "sm"} disabled={!canSubmit} className={mobile ? "h-11 w-full" : undefined}>
          {busy && <Loader2 aria-hidden="true" />}
          {busy ? "Creating…" : "Create"}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}

export function NewPmDialog({
  open,
  devices,
  defaultDevice,
  onOpenChange,
  onCreated,
  onManageProviders,
}: {
  open: boolean;
  devices: readonly NewPmDevice[];
  defaultDevice: DeviceKey;
  onOpenChange: (open: boolean) => void;
  onCreated: (device: DeviceKey, conversationId: ConversationId) => void;
  onManageProviders?: (device: DeviceKey) => void;
}) {
  const mobile = useMobileShell();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New project manager"
        fullScreen={mobile}
        onOpenAutoFocus={mobile ? (e) => e.preventDefault() : undefined}
      >
        {devices.length > 0 ? (
          <DevicePicker
            mobile={mobile}
            devices={devices}
            defaultDevice={defaultDevice}
            onCreated={onCreated}
            {...(onManageProviders !== undefined ? { onManageProviders } : {})}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DevicePicker({
  mobile,
  devices,
  defaultDevice,
  onCreated,
  onManageProviders,
}: {
  mobile: boolean;
  devices: readonly NewPmDevice[];
  defaultDevice: DeviceKey;
  onCreated: (device: DeviceKey, conversationId: ConversationId) => void;
  onManageProviders?: (device: DeviceKey) => void;
}) {
  const [key, setKey] = useState(defaultDevice);
  const device = devices.find((d) => d.key === key) ?? devices[0]!;
  const deviceRow =
    devices.length > 1 ? (
      <SettingsRow label="Device">
        {(id) => (
          <Select value={device.key} onValueChange={setKey}>
            <SelectTrigger id={id} aria-label="Device" variant="plain">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {devices.map((d) => (
                <SelectItem key={d.key} value={d.key} disabled={isReadOnly(d.status)}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SettingsRow>
    ) : null;
  return (
    <DeviceScope client={device.client} server={device.server}>
      <NewPmForm
        key={device.key}
        mobile={mobile}
        deviceRow={deviceRow}
        takenLooks={device.takenLooks}
        onCreated={(conversationId) => onCreated(device.key, conversationId)}
        {...(onManageProviders !== undefined ? { onManageProviders: () => onManageProviders(device.key) } : {})}
      />
    </DeviceScope>
  );
}

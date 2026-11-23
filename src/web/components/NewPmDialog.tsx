import { ChevronRight, Loader2 } from "../ui/icons.ts";
import { useEffect, useState, type ReactNode } from "react";
import {
  DEFAULT_AGENT_SETTING,
  MAX_PERSONA_BYTES,
  DEFAULT_PM_MODE,
  isSelectable,
  normalizeName,
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
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogForm } from "../ui/dialog.tsx";
import { Input, Textarea } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { useIsMobile } from "../useMediaQuery.ts";
import { AgentRows, draftOf, settingOf } from "./AgentRows.tsx";
import { Avatar } from "./Avatar.tsx";
import { ModeRows } from "./ModeRows.tsx";
import { SlimePicker } from "./SlimePicker.tsx";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

const FIELD_WIDTH = "w-72";

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
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<ErrorLike | null>(null);
  const canPick = useServerInfo().folderPicker;

  const cleanName = normalizeName(name);
  const nameProblem = nameError(name);
  const personaTooLong = utf8Bytes(persona) > MAX_PERSONA_BYTES;
  const agentResult = settingOf(agent);
  const vendorUsable = isSelectable(useModelCatalog(agent.vendor).availability);
  const canSubmit = cleanName !== null && !personaTooLong && agentResult.ok && vendorUsable && !busy;
  const zeroProvidersReady = allCatalogs.length > 0 && allCatalogs.every((c) => !isSelectable(c.availability));

  useEffect(() => {
    if (zeroProvidersReady) setMoreOpen(true);
  }, [zeroProvidersReady]);

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
        <SettingsGroup>
          {deviceRow}
          <SettingsRow label="Name" stacked={mobile} error={nameProblem}>
            {(id) => (
              <Input
                id={id}
                value={name}
                autoFocus={!mobile}
                autoComplete="off"
                className={mobile ? "min-w-0 flex-1" : FIELD_WIDTH}
                aria-invalid={nameProblem !== null}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </SettingsRow>
          <SettingsRow label="Look" stacked={mobile}>
            {(id) => (
              <SlimePicker look={look} onChange={setPickedLook}>
                <button
                  id={id}
                  type="button"
                  aria-label="Change look"
                  className="flex cursor-pointer items-center gap-2 px-1.5 py-1 text-minor text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus"
                >
                  <Avatar look={look} size={34} />
                  <ChevronRight className="size-pixel-sm" aria-hidden="true" />
                </button>
              </SlimePicker>
            )}
          </SettingsRow>
          <SettingsRow label="Main folder" stacked={mobile} error={pickError}>
            {(id) => (
              <div className={cn("flex items-center gap-2", mobile ? "min-w-0 flex-1" : FIELD_WIDTH)}>
                <Input
                  id={id}
                  value={folder}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Optional"
                  className="min-w-0 flex-1"
                  onChange={(e) => setFolder(e.target.value)}
                />
                {canPick && (
                  <Button type="button" variant="outline" className="shrink-0" disabled={picking || busy} onClick={() => void pickFolder()}>
                    {picking && <Loader2 aria-hidden="true" />}
                    Choose…
                  </Button>
                )}
              </div>
            )}
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title="Mode">
          <ModeRows label="Mode" value={mode} onChange={setMode} disabled={busy} />
        </SettingsGroup>
        <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger className="touch-target group flex cursor-pointer items-center gap-1 px-4 text-minor font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus">
            <ChevronRight className="size-pixel-sm transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
            More settings
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 grid gap-6">
            <SettingsGroup label="Model">
              <AgentRows
                value={agent}
                onChange={setAgent}
                disabled={busy}
                stacked={mobile}
                {...(onManageProviders !== undefined ? { onManageProviders } : {})}
              />
            </SettingsGroup>
            <SettingsGroup title="Persona">
              <Textarea
                aria-label="Persona"
                placeholder="Optional"
                rows={4}
                className="block max-h-[60vh] min-h-24 resize-none border-0 bg-transparent px-4 py-3 font-mono text-minor placeholder:font-sans placeholder:text-body field-sizing-content focus:border-0"
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
              />
              {personaTooLong && (
                <div className="px-4 py-2.5">
                  <RowError>Persona is too long</RowError>
                </div>
              )}
            </SettingsGroup>
          </CollapsibleContent>
        </Collapsible>
      </DialogBody>
      {error && (
        <p role="alert" title={errorTitle(error)} className={cn("px-4 text-minor text-danger [overflow-wrap:anywhere]", mobile && "pb-2")}>
          {errorLine(error)}
        </p>
      )}
      <DialogFooter className={mobile ? "border-t-2 border-border bg-panel px-4 py-3" : undefined}>
        <Button type="submit" disabled={!canSubmit} className={mobile ? "h-11 w-full" : undefined}>
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
  const mobile = useIsMobile();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New project manager"
        fullScreen={mobile}
        onOpenAutoFocus={mobile ? (e) => e.preventDefault() : undefined}
      >
        <DevicePicker
          mobile={mobile}
          devices={devices}
          defaultDevice={defaultDevice}
          onCreated={onCreated}
          {...(onManageProviders !== undefined ? { onManageProviders } : {})}
        />
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

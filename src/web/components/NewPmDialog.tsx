import { ChevronRight, Loader2 } from "lucide-react";
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
import { DeviceScope, useClient } from "../device-scope.tsx";
import { isReadOnly, type DeviceKey, type DeviceStatus } from "../devices.ts";
import { errorText, nameError, errorLine, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useModelCatalog, useModelCatalogs } from "../models.tsx";
import { useServerInfo } from "../server-info.tsx";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogForm } from "../ui/dialog.tsx";
import { Input, Select, Textarea } from "../ui/input.tsx";
import { useIsMobile } from "../useMediaQuery.ts";
import { AgentRows, draftOf, settingOf } from "./AgentRows.tsx";
import { ModeRows } from "./ModeRows.tsx";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

/** 新建项目经理时能选的一台设备。 */
export interface NewPmDevice {
  key: DeviceKey;
  name: string;
  status: DeviceStatus;
  client: HubClient;
  server: ServerInfo;
}

/** deviceRow：两台以上设备时最上面一行“设备”；表单的接口、模型名单、能不能“选择…”都按外面 DeviceScope 的那台。 */
function NewPmForm({
  mobile,
  deviceRow,
  onCreated,
  onManageProviders,
}: {
  mobile: boolean;
  deviceRow: ReactNode;
  onCreated: (conversationId: ConversationId) => void;
  onManageProviders?: () => void;
}) {
  const client = useClient();
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
  // 服务端不是 macOS（弹不出原生对话框）：不显示“选择…”，只留手填路径的输入框
  const canPick = useServerInfo().folderPicker;

  // 表单校验（docs/ui-standard.md 第 9 条）：空着“创建”是灰的不报错；填得不对在那一行下面写原因
  const cleanName = normalizeName(name);
  const nameProblem = nameError(name);
  const personaTooLong = utf8Bytes(persona) > MAX_PERSONA_BYTES;
  const agentResult = settingOf(agent);
  // 选着的厂商这台设备用不了（没装、没登录）：不悄悄换掉（换了设备也保留原来的选择），下拉里标状态词，“创建”是灰的
  const vendorUsable = isSelectable(useModelCatalog(agent.vendor).availability);
  const canSubmit = cleanName !== null && !personaTooLong && agentResult.ok && vendorUsable && !busy;
  const zeroProvidersReady = allCatalogs.length > 0 && allCatalogs.every((c) => !isSelectable(c.availability));

  useEffect(() => {
    if (zeroProvidersReady) setMoreOpen(true);
  }, [zeroProvidersReady]);

  // 守护进程弹原生的“选择文件夹”：选中填进输入框；取消（path 为 null）输入框不变；出错在这一行下面写原因
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
      });
      onCreated(res.conversationId);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  // 标题和“创建”固定，只有中间（DialogBody）滚：展开“更多设置”后“创建”还在视野里
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
                className={mobile ? "min-w-0 flex-1" : "w-60"}
                aria-invalid={nameProblem !== null}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </SettingsRow>
          <SettingsRow label="Main folder" stacked={mobile} error={pickError}>
            {(id) => (
              <>
                <Input
                  id={id}
                  value={folder}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Optional"
                  className={mobile ? "min-w-0 flex-1" : "w-60 min-w-0"}
                  onChange={(e) => setFolder(e.target.value)}
                />
                {canPick && (
                  <Button type="button" variant="outline" disabled={picking || busy} onClick={() => void pickFolder()}>
                    {picking && <Loader2 className="animate-spin" aria-hidden="true" />}
                    Choose…
                  </Button>
                )}
              </>
            )}
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title="Mode">
          <ModeRows label="Mode" value={mode} onChange={setMode} disabled={busy} />
        </SettingsGroup>
        <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger className="touch-target group flex cursor-pointer items-center gap-1 rounded-full px-4 text-minor font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
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
                className="block max-h-[60vh] min-h-24 resize-none rounded-none border-0 bg-transparent px-4 py-3 font-mono text-minor placeholder:font-sans placeholder:text-body field-sizing-content focus-visible:ring-0"
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
      <DialogFooter className={mobile ? "border-t border-border bg-surface-sidebar px-4 py-3" : undefined}>
        <Button type="submit" disabled={!canSubmit} className={mobile ? "h-11 w-full" : undefined}>
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          {busy ? "Creating…" : "Create"}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}

/** devices：能选的设备（入口本机第一）；只有一台时没有“设备”这一行。defaultDevice：打开时选中的（当前看的那台）。 */
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
          <Select id={id} variant="plain" value={device.key} onChange={(e) => setKey(e.target.value)}>
            {devices.map((d) => (
              <option key={d.key} value={d.key} disabled={isReadOnly(d.status)}>
                {d.name}
              </option>
            ))}
          </Select>
        )}
      </SettingsRow>
    ) : null;
  return (
    <DeviceScope client={device.client} server={device.server}>
      <NewPmForm
        mobile={mobile}
        deviceRow={deviceRow}
        onCreated={(conversationId) => onCreated(device.key, conversationId)}
        {...(onManageProviders !== undefined ? { onManageProviders: () => onManageProviders(device.key) } : {})}
      />
    </DeviceScope>
  );
}

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
import { errorText, nameError } from "../format.ts";
import { useModelCatalog } from "../models.tsx";
import { useServerInfo } from "../server-info.tsx";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogForm } from "../ui/dialog.tsx";
import { Input, Select, Textarea } from "../ui/input.tsx";
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
function NewPmForm({ deviceRow, onCreated }: { deviceRow: ReactNode; onCreated: (conversationId: ConversationId) => void }) {
  const client = useClient();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [mode, setMode] = useState<PmMode>(DEFAULT_PM_MODE);
  const [agent, setAgent] = useState(() => draftOf(DEFAULT_AGENT_SETTING));
  const [persona, setPersona] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
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
    <DialogForm onSubmit={(e) => void submit(e)}>
      <DialogBody>
        <SettingsGroup>
          {deviceRow}
          <SettingsRow label="名字" error={nameProblem}>
            {(id) => (
              <Input id={id} value={name} autoFocus autoComplete="off" className="w-[240px]" aria-invalid={nameProblem !== null} onChange={(e) => setName(e.target.value)} />
            )}
          </SettingsRow>
          <SettingsRow label="主文件夹" error={pickError}>
            {(id) => (
              <>
                <Input
                  id={id}
                  value={folder}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="可选"
                  className="w-[240px] min-w-0"
                  onChange={(e) => setFolder(e.target.value)}
                />
                {canPick && (
                  <Button type="button" variant="outline" disabled={picking || busy} onClick={() => void pickFolder()}>
                    {picking && <Loader2 className="animate-spin" aria-hidden="true" />}
                    选择…
                  </Button>
                )}
              </>
            )}
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title="工作方式">
          <ModeRows label="工作方式" value={mode} onChange={setMode} disabled={busy} />
        </SettingsGroup>
        <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 rounded-full px-4 text-[13.5px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
            更多设置
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 grid gap-6">
            <SettingsGroup label="模型">
              <AgentRows value={agent} onChange={setAgent} disabled={busy} />
            </SettingsGroup>
            <SettingsGroup title="性格设定">
              <Textarea
                aria-label="性格设定"
                placeholder="可选"
                rows={4}
                className="block max-h-[60vh] min-h-24 resize-none rounded-none border-0 bg-transparent px-4 py-3 font-mono text-[13.5px] placeholder:font-sans placeholder:text-[15px] field-sizing-content focus-visible:ring-0"
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
              />
              {personaTooLong && (
                <div className="px-4 py-2.5">
                  <RowError>性格设定太长</RowError>
                </div>
              )}
            </SettingsGroup>
          </CollapsibleContent>
        </Collapsible>
      </DialogBody>
      {error && (
        <p role="alert" className="px-4 text-[13.5px] text-danger [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" disabled={!canSubmit}>
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          {busy ? "Creating…" : "创建"}
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
}: {
  open: boolean;
  devices: readonly NewPmDevice[];
  defaultDevice: DeviceKey;
  onOpenChange: (open: boolean) => void;
  onCreated: (device: DeviceKey, conversationId: ConversationId) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="新建项目经理">
        <DevicePicker devices={devices} defaultDevice={defaultDevice} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

function DevicePicker({
  devices,
  defaultDevice,
  onCreated,
}: {
  devices: readonly NewPmDevice[];
  defaultDevice: DeviceKey;
  onCreated: (device: DeviceKey, conversationId: ConversationId) => void;
}) {
  const [key, setKey] = useState(defaultDevice);
  const device = devices.find((d) => d.key === key) ?? devices[0]!;
  const deviceRow =
    devices.length > 1 ? (
      <SettingsRow label="设备">
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
      <NewPmForm deviceRow={deviceRow} onCreated={(conversationId) => onCreated(device.key, conversationId)} />
    </DeviceScope>
  );
}

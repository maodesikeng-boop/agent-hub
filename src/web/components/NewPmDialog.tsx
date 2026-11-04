import { ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import {
  DEFAULT_AGENT_SETTING,
  MAX_PERSONA_BYTES,
  PM_PERSONA_TEMPLATE,
  DEFAULT_PM_MODE,
  normalizeName,
  utf8Bytes,
  type ConversationId,
  type PmMode,
} from "../../shared/index.ts";
import { postCreatePm, postPickFolder } from "../client.ts";
import { errorText } from "../format.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog.tsx";
import { Input, Textarea } from "../ui/input.tsx";
import { AgentRows, draftOf, settingOf } from "./AgentRows.tsx";
import { ModeRows } from "./ModeRows.tsx";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

function NewPmForm({ onCreated }: { onCreated: (conversationId: ConversationId) => void }) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [mode, setMode] = useState<PmMode>(DEFAULT_PM_MODE);
  const [agent, setAgent] = useState(() => draftOf(DEFAULT_AGENT_SETTING));
  const [persona, setPersona] = useState(PM_PERSONA_TEMPLATE);
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  const cleanName = normalizeName(name);
  const personaTooLong = utf8Bytes(persona) > MAX_PERSONA_BYTES;
  const agentResult = settingOf(agent);
  const canSubmit = cleanName !== null && !personaTooLong && agentResult.ok && !busy;

  // 守护进程弹原生的“选择文件夹”：选中填进输入框；取消（path 为 null）输入框不变；出错在这一行下面写原因
  const pickFolder = async () => {
    setPicking(true);
    setPickError(null);
    try {
      const startDir = folder.trim();
      const { path } = await postPickFolder(startDir ? { startDir } : {});
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
      const res = await postCreatePm({
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

  return (
    <form className="grid gap-6" onSubmit={(e) => void submit(e)}>
      <SettingsGroup>
        <SettingsRow label="名字">
          {(id) => <Input id={id} value={name} autoFocus autoComplete="off" className="w-[240px]" onChange={(e) => setName(e.target.value)} />}
        </SettingsRow>
        <SettingsRow label="主文件夹（可选）" error={pickError}>
          {(id) => (
            <>
              <Input
                id={id}
                value={folder}
                autoComplete="off"
                spellCheck={false}
                placeholder="~/code/my-project"
                className="w-[160px]"
                onChange={(e) => setFolder(e.target.value)}
              />
              <Button type="button" variant="outline" disabled={picking || busy} onClick={() => void pickFolder()}>
                {picking && <Loader2 className="animate-spin" aria-hidden="true" />}
                选择…
              </Button>
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
          <SettingsGroup title="Agent">
            <AgentRows value={agent} onChange={setAgent} disabled={busy} />
          </SettingsGroup>
          <SettingsGroup title="性格设定">
            <Textarea
              aria-label="性格设定"
              rows={8}
              className="block max-h-[60vh] min-h-32 resize-none rounded-none border-0 bg-transparent px-4 py-3 font-mono text-[13.5px] field-sizing-content focus-visible:ring-0"
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
      {error && (
        <p role="alert" className="px-4 text-[13.5px] text-danger [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" disabled={!canSubmit}>
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          {busy ? "创建中" : "创建"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function NewPmDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (conversationId: ConversationId) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="新建项目经理">
        <NewPmForm onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

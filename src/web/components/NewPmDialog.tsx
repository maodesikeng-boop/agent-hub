import { ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import {
  DEFAULT_AGENT_SETTING,
  MAX_PERSONA_BYTES,
  DEFAULT_PM_MODE,
  normalizeName,
  utf8Bytes,
  type ConversationId,
  type PmMode,
} from "../../shared/index.ts";
import { postCreatePm, postPickFolder } from "../client.ts";
import { errorText, nameError } from "../format.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogForm } from "../ui/dialog.tsx";
import { Input, Textarea } from "../ui/input.tsx";
import { AgentRows, draftOf, settingOf } from "./AgentRows.tsx";
import { ModeRows } from "./ModeRows.tsx";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

function NewPmForm({ onCreated }: { onCreated: (conversationId: ConversationId) => void }) {
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

  // 表单校验（docs/ui-standard.md 第 9 条）：空着“创建”是灰的不报错；填得不对在那一行下面写原因
  const cleanName = normalizeName(name);
  const nameProblem = nameError(name);
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

  // 标题和“创建”固定，只有中间（DialogBody）滚：展开“更多设置”后“创建”还在视野里
  return (
    <DialogForm onSubmit={(e) => void submit(e)}>
      <DialogBody>
        <SettingsGroup>
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

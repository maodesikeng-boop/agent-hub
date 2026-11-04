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
import { postCreatePm } from "../client.ts";
import { errorText } from "../format.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { Input, Textarea } from "../ui/input.tsx";
import { AgentFields, draftOf, settingOf } from "./AgentFields.tsx";
import { Field } from "./Field.tsx";
import { ModeField } from "./ModeField.tsx";

function NewPmForm({ onCreated }: { onCreated: (conversationId: ConversationId) => void }) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [mode, setMode] = useState<PmMode>(DEFAULT_PM_MODE);
  const [agent, setAgent] = useState(() => draftOf(DEFAULT_AGENT_SETTING));
  const [persona, setPersona] = useState(PM_PERSONA_TEMPLATE);
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanName = normalizeName(name);
  const personaTooLong = utf8Bytes(persona) > MAX_PERSONA_BYTES;
  const agentResult = settingOf(agent);
  const canSubmit = cleanName !== null && !personaTooLong && agentResult.ok && !busy;

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
    <form className="grid gap-5" onSubmit={(e) => void submit(e)}>
      <Field label="名字">
        {(id) => <Input id={id} value={name} autoFocus autoComplete="off" onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="主文件夹（可选）">
        {(id) => (
          <Input
            id={id}
            value={folder}
            autoComplete="off"
            spellCheck={false}
            placeholder="~/code/my-project"
            onChange={(e) => setFolder(e.target.value)}
          />
        )}
      </Field>
      <ModeField label="模式" value={mode} onChange={setMode} disabled={busy} />
      <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
        <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-[13.5px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
          <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
          更多设置
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 grid gap-4">
          <AgentFields value={agent} onChange={setAgent} disabled={busy} />
          <Field label="性格设定">
            {(id) => <Textarea id={id} rows={8} value={persona} onChange={(e) => setPersona(e.target.value)} />}
          </Field>
          {personaTooLong && <p className="text-[13px] text-danger">性格设定太长</p>}
        </CollapsibleContent>
      </Collapsible>
      {error && (
        <p role="alert" className="text-[13.5px] text-danger [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      <Button type="submit" disabled={!canSubmit} className="justify-self-end">
        {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
        {busy ? "创建中" : "创建"}
      </Button>
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

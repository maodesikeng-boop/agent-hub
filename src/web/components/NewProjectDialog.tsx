import { Loader2 } from "lucide-react";
import { useState } from "react";
import { MAX_DESCRIPTION_CHARS, normalizeName, type ConversationId, type Pm } from "../../shared/index.ts";
import { postCreateProject } from "../client.ts";
import { errorText } from "../format.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { Input, Select } from "../ui/input.tsx";
import { Field } from "./Field.tsx";

function NewProjectForm({ pms, onCreated }: { pms: Pm[]; onCreated: (conversationId: ConversationId) => void }) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [pmId, setPmId] = useState<number | null>(pms[0]?.id ?? null);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanName = normalizeName(name);
  const cleanFolder = folder.trim();
  const canSubmit = cleanName !== null && cleanFolder !== "" && pmId !== null && !busy;

  const submit = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (cleanName === null || pmId === null || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const text = description.trim();
      const res = await postCreateProject({ name: cleanName, folder: cleanFolder, pmId, ...(text ? { description: text } : {}) });
      onCreated(res.conversationId);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form className="grid gap-4" onSubmit={(e) => void submit(e)}>
      <Field label="项目名">
        {(id) => <Input id={id} value={name} autoFocus autoComplete="off" onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="文件夹">
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
      <Field label="项目经理">
        {(id) => (
          <Select id={id} value={pmId ?? ""} disabled={pms.length === 0} onChange={(e) => setPmId(Number(e.target.value))}>
            {pms.length === 0 && <option value="">还没有项目经理</option>}
            {pms.map((pm) => (
              <option key={pm.id} value={pm.id}>
                {pm.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="说明（可选）">
        {(id) => <Input id={id} value={description} maxLength={MAX_DESCRIPTION_CHARS} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      {error && (
        <p role="alert" className="text-[13.5px] text-danger">
          {error}
        </p>
      )}
      <Button type="submit" disabled={!canSubmit} className="mt-1 justify-self-end">
        {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
        {busy ? "创建中" : "创建"}
      </Button>
    </form>
  );
}

export function NewProjectDialog({
  open,
  onOpenChange,
  pms,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pms: Pm[];
  onCreated: (conversationId: ConversationId) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="新建项目">
        <NewProjectForm pms={pms} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

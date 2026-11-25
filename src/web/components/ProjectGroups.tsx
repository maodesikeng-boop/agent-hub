import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { MAX_SETUP_COMMAND_BYTES, utf8Bytes, type Project } from "../../shared/index.ts";
import { useClient } from "../device-scope.tsx";
import { errorText } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import { useShellCarry } from "../shell-carry.tsx";
import { Button } from "../ui/button.tsx";
import { Loader2 } from "../ui/icons.ts";
import { Textarea } from "../ui/input.tsx";
import { RowError, SettingsGroup } from "./SettingsList.tsx";

function setupCommandProblem(text: string): string | null {
  if (text.includes("\0")) return "Setup command can't contain NUL characters";
  if (utf8Bytes(text) > MAX_SETUP_COMMAND_BYTES) return `Setup command must be ${MAX_SETUP_COMMAND_BYTES / 1024} KB or less`;
  return null;
}

const commandOf = (text: string): string | null => (text.trim() === "" ? null : text);

// The PUT reply can land before or after the project.updated echo, so keep whichever copy is newer.
function newerProject(live: Project, confirmed: Project | null): Project {
  return confirmed !== null && confirmed.id === live.id && confirmed.updatedAt >= live.updatedAt ? confirmed : live;
}

function useSetupCommandEditor(project: Project) {
  const client = useClient();
  const qc = useHubQueryClient();
  const [confirmed, setConfirmed] = useState<Project | null>(null);
  const [draft, setDraft] = useShellCarry<string | null>(`project:${project.id}:setup-command`, null);
  const mutation = useMutation(
    {
      mutationFn: async (command: string | null) => (await client.putProjectSetupCommand(project.id, command)).project,
      onSuccess: (next: Project, command: string | null) => {
        setConfirmed(next);
        setDraft((current) => (current !== null && commandOf(current) === command ? null : current));
      },
    },
    qc,
  );
  const saved = newerProject(project, confirmed).setupCommand;
  const text = draft ?? saved ?? "";
  if (draft !== null && draft === (saved ?? "") && !mutation.isPending) setDraft(null);
  const problem = setupCommandProblem(text);
  const dirty = draft !== null && draft !== (saved ?? "");
  const resetError = () => {
    if (mutation.isError) mutation.reset();
  };
  return {
    text,
    saved,
    dirty,
    problem,
    saving: mutation.isPending,
    error: mutation.error === null ? null : errorText(mutation.error),
    canSave: dirty && problem === null && !mutation.isPending,
    edit: (next: string) => {
      setDraft(next);
      resetError();
    },
    clear: () => setDraft(""),
    cancel: () => {
      setDraft(null);
      resetError();
    },
    save: () => {
      if (draft !== null) mutation.mutate(commandOf(draft));
    },
  };
}

function SetupActions({ setup }: { setup: ReturnType<typeof useSetupCommandEditor> }) {
  if (setup.dirty) {
    return (
      <span className="flex items-center gap-2">
        <Button size="sm" variant="ghost" disabled={setup.saving} onClick={setup.cancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!setup.canSave} onClick={setup.save}>
          {setup.saving && <Loader2 aria-hidden="true" />}
          Save
        </Button>
      </span>
    );
  }
  if (setup.saved === null) return null;
  return (
    <Button size="sm" variant="ghost" className="-mr-3" onClick={setup.clear}>
      Clear
    </Button>
  );
}

export function WorktreeSetupGroup({ project, readOnly, titled = true }: { project: Project; readOnly: boolean; titled?: boolean }) {
  const setup = useSetupCommandEditor(project);
  const problem = setup.problem ?? setup.error;
  return (
    <SettingsGroup {...(titled ? { title: "Worktree setup" } : { label: "Worktree setup" })} action={readOnly ? null : <SetupActions setup={setup} />}>
      <Textarea
        aria-label="Worktree setup"
        placeholder="No setup command"
        rows={1}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        aria-invalid={setup.problem !== null || undefined}
        className={cn(
          "block max-h-[60vh] min-h-0 resize-none border-0 bg-transparent px-4 py-3 placeholder:font-sans placeholder:text-body field-sizing-content focus:border-0 focus:shadow-none",
          setup.text === "" ? "text-body" : "font-mono text-minor",
        )}
        value={setup.text}
        onChange={(e) => setup.edit(e.target.value)}
      />
      {problem !== null && (
        <div className="px-4 py-2.5">
          <RowError error={problem} />
        </div>
      )}
    </SettingsGroup>
  );
}

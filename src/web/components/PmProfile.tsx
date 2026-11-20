import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Loader2 } from "../ui/icons.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import {
  CUSTOM_MODEL,
  DEFAULT_AGENT_VENDOR,
  MAX_PERSONA_BYTES,
  PM_MEMORY_MAX_BYTES,
  PM_MEMORY_MAX_LINES,
  PM_MEMORY_SOFT_WARN_RATIO,
  isAgentVendor,
  modelLabel,
  splitModelEffort,
  pmMemoryLineCount,
  utf8Bytes,
  vendorLabel,
  type AgentSetting,
  type EditPersonaRequest,
  type ModelCatalog,
  type PersonaChange,
  type PersonaView,
  type Pm,
  type PmMode,
  type Project,
  type ProjectFolder,
  type ScheduleRecord,
} from "../../shared/index.ts";
import { ApiError } from "../client.ts";
import { useClient } from "../device-scope.tsx";
import { ACTOR_LABELS, DEFAULT_CHOICE, MODE_LABELS, errorLine, errorText, errorTitle, formatArchiveRemaining, formatTime, shortPath, type ErrorInfo, type ErrorLike } from "../format.ts";
import { useHubQueryClient } from "../query-client.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "../ui/dialog.tsx";
import { Textarea } from "../ui/input.tsx";
import { useModelCatalog } from "../models.tsx";
import { AgentRows, draftOf, settingOf, type AgentDraft, type AgentRowKey } from "./AgentRows.tsx";
import { Avatar } from "./Avatar.tsx";
import { SlimePicker } from "./SlimePicker.tsx";
import { resolvePmLook, type SlimeLook } from "../../shared/slimes.ts";
import { ModeRows } from "./ModeRows.tsx";
import { PmMemoryFilesGroup } from "./PmMemoryFilesGroup.tsx";
import { ScheduleGroup } from "./ScheduleGroup.tsx";
import { CollapsibleGroup, RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

type Load = { phase: "loading" } | { phase: "error"; info: ErrorInfo } | { phase: "ready"; persona: PersonaView };

function usePersona(pmId: number, rev: number) {
  const client = useClient();
  const qc = useHubQueryClient();
  const queryKey = useMemo(() => ["persona", client.device ?? "", pmId] as const, [client.device, pmId]);
  const { data: persona, error, isFetching, refetch } = useQuery(
    {
      queryKey,
      queryFn: () => client.fetchPersona(pmId),
      staleTime: 0,
    },
    qc,
  );
  const prevRev = useRef(rev);
  useEffect(() => {
    if (prevRev.current !== rev) {
      prevRev.current = rev;
      void refetch();
    }
  }, [rev, refetch]);
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const set = useCallback(
    (next: PersonaView) => {
      qc.setQueryData(queryKey, next);
    },
    [qc, queryKey],
  );
  const load: Load =
    persona !== undefined
      ? { phase: "ready", persona }
      : error && !isFetching
        ? { phase: "error", info: errorText(error) }
        : { phase: "loading" };
  return { load, retry, set };
}

function describeChange(change: PersonaChange, catalog: ModelCatalog): string {
  if (change.revertOf !== null) return "undid a change";
  const parts: string[] = [];
  if (change.textBefore !== change.textAfter) parts.push("edited the persona");
  if (change.modeBefore !== change.modeAfter) parts.push(`set mode to ${MODE_LABELS[change.modeAfter]}`);
  if (change.vendorBefore !== change.vendorAfter) parts.push(`set provider to ${vendorLabel(change.vendorAfter)}`);
  const before = splitModelEffort(change.vendorBefore, change.modelBefore, change.effortBefore);
  const after = splitModelEffort(change.vendorAfter, change.modelAfter, change.effortAfter);
  if (before.model !== after.model) parts.push(`set model to ${after.model === null ? DEFAULT_CHOICE : modelLabel(change.vendorAfter, after.model, catalog)}`);
  if (before.effort !== after.effort) parts.push(`set effort to ${after.effort ?? DEFAULT_CHOICE}`);
  return parts.join(", ") || "changed settings";
}

function ChangeRow({ change, revertable, busy, onRevert }: { change: PersonaChange; revertable: boolean; busy: boolean; onRevert: () => void }) {
  const [open, setOpen] = useState(false);
  const catalog = useModelCatalog(isAgentVendor(change.vendorAfter) ? change.vendorAfter : DEFAULT_AGENT_VENDOR);
  const textChanged = change.textBefore !== change.textAfter;
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-body">
            <span className="font-medium">{ACTOR_LABELS[change.actor]}</span> {describeChange(change, catalog)}
            {change.reason && <span>: {change.reason}</span>}
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">{formatTime(change.createdAt)}</div>
        </div>
        {revertable && (
          <Button variant="outline" size="sm" disabled={busy} onClick={onRevert}>
            Undo
          </Button>
        )}
      </div>
      {textChanged && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="group mt-1 flex cursor-pointer items-center gap-1 rounded-full text-minor text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
            <ChevronRight className="size-pixel-sm transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
            View changes
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 grid gap-2 sm:grid-cols-2">
            {(["Before", "After"] as const).map((label) => (
              <div key={label} className="min-w-0">
                <div className="mb-1 text-minor font-medium text-muted-foreground">{label}</div>
                <pre className="max-h-60 overflow-auto rounded-xl bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {label === "Before" ? change.textBefore : change.textAfter}
                </pre>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </li>
  );
}

function folderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

function sameSetting(a: AgentSetting, b: AgentSetting): boolean {
  return a.vendor === b.vendor && a.model === b.model && a.effort === b.effort;
}

function useInstantSave<T>(pmId: number, onUpdate: (p: PersonaView) => void, aliveRef: { current: boolean }) {
  const client = useClient();
  const [draft, setDraft] = useState<T | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const seq = useRef(0);
  const save = (next: T, body: EditPersonaRequest) => {
    setDraft(next);
    setError(null);
    const mine = ++seq.current;
    if (Object.keys(body).length === 0) {
      setDraft(null);
      return;
    }
    client.putPersona(pmId, body).then(
      (res) => {
        if (!aliveRef.current) return;
        onUpdate(res.persona);
        if (mine === seq.current) setDraft(null);
      },
      (err: unknown) => {
        if (!aliveRef.current || mine !== seq.current) return;
        setDraft(null);
        setError(errorText(err));
      },
    );
  };
  const reset = () => {
    seq.current++;
    setDraft(null);
    setError(null);
  };
  return { draft, error, save, reset };
}

function PmEditor({
  pm,
  folders,
  schedules,
  persona,
  onUpdate,
  onManageProviders,
}: {
  pm: Pm;
  folders: ProjectFolder[];
  schedules: ScheduleRecord[];
  persona: PersonaView;
  onUpdate: (p: PersonaView) => void;
  onManageProviders?: () => void;
}) {
  const client = useClient();
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const saved: AgentSetting = { vendor: persona.vendor, ...splitModelEffort(persona.vendor, persona.model, persona.effort) };
  const [trackedPmId, setTrackedPmId] = useState(persona.pmId);
  const [editedAgent, setEditedAgent] = useState<AgentDraft | null>(null);
  const [agentError, setAgentError] = useState<ErrorInfo | null>(null);
  const [agentSaving, setAgentSaving] = useState(false);
  const agentSavingRef = useRef(false);
  const agentSeq = useRef(0);
  const [draftText, setDraftText] = useState<string | null>(null);

  if (trackedPmId !== persona.pmId) {
    setTrackedPmId(persona.pmId);
    setEditedAgent(null);
    setAgentError(null);
    setAgentSaving(false);
    setDraftText(null);
  }

  const draft: AgentDraft = editedAgent ?? draftOf(saved);
  const agentResult = settingOf(draft);
  const agentChanged = !agentResult.ok || !sameSetting(agentResult.setting, saved);
  if (!agentSaving && editedAgent !== null && editedAgent.modelChoice !== CUSTOM_MODEL && !agentChanged) {
    setEditedAgent(null);
    setAgentError(null);
  }
  const canSaveAgent = agentChanged && agentResult.ok && !agentSaving;

  const changeAgent = (next: AgentDraft, row: AgentRowKey) => {
    const updated = row === "vendor" ? draftOf({ vendor: next.vendor, model: null, effort: null }) : next;
    const result = settingOf(updated);
    setAgentError(null);
    setEditedAgent(
      updated.modelChoice !== CUSTOM_MODEL && result.ok && sameSetting(result.setting, saved) ? null : updated,
    );
  };

  const cancelAgent = () => {
    setEditedAgent(null);
    setAgentError(null);
  };

  const resetAgent = () => {
    agentSeq.current++;
    agentSavingRef.current = false;
    setAgentSaving(false);
    setEditedAgent(null);
    setAgentError(null);
  };

  const saveAgent = async () => {
    if (agentSavingRef.current || !canSaveAgent || !agentResult.ok) return;
    agentSavingRef.current = true;
    setAgentSaving(true);
    setAgentError(null);
    const mine = ++agentSeq.current;
    const { vendor, model, effort } = agentResult.setting;
    try {
      const res = await client.putPersona(pm.id, { vendor, model, effort });
      if (!aliveRef.current || mine !== agentSeq.current) return;
      onUpdate(res.persona);
      setEditedAgent(null);
      setAgentError(null);
    } catch (err) {
      if (!aliveRef.current || mine !== agentSeq.current) return;
      setAgentError(errorText(err));
    } finally {
      if (aliveRef.current && mine === agentSeq.current) {
        agentSavingRef.current = false;
        setAgentSaving(false);
      }
    }
  };

  const modeSave = useInstantSave<PmMode>(pm.id, onUpdate, aliveRef);
  const mode = modeSave.draft ?? persona.mode;

  const qc = useHubQueryClient();
  const text = draftText ?? persona.text;
  const tooLong = utf8Bytes(text) > MAX_PERSONA_BYTES;
  const textDirty = text !== persona.text;

  const textMutation = useMutation(
    {
      mutationFn: async () => (await client.putPersona(pm.id, { text })).persona,
      onSuccess: (next) => {
        if (!aliveRef.current) return;
        setDraftText(null);
        onUpdate(next);
      },
    },
    qc,
  );
  const revertMutation = useMutation(
    {
      mutationFn: async (changeId: number) => (await client.postRevertPersonaChange(changeId)).persona,
      onSuccess: (next) => {
        if (!aliveRef.current) return;
        resetAgent();
        modeSave.reset();
        setDraftText(null);
        onUpdate(next);
      },
    },
    qc,
  );
  const busy = textMutation.isPending ? ("text" as const) : revertMutation.isPending ? ("revert" as const) : null;
  const textError: ErrorLike | undefined = textMutation.error ? errorText(textMutation.error) : undefined;
  const revertError: ErrorLike | undefined = revertMutation.error
    ? revertMutation.error instanceof ApiError && revertMutation.error.status === 409
      ? "Only the latest change can be undone"
      : errorText(revertMutation.error)
    : undefined;
  const saveText = () => textMutation.mutate();
  const revert = (changeId: number) => revertMutation.mutate(changeId);
  const personaLines = pmMemoryLineCount(text);
  const personaBytes = utf8Bytes(text);
  const personaOverAutoLoad = personaLines > PM_MEMORY_MAX_LINES || personaBytes > PM_MEMORY_MAX_BYTES;
  const personaNearAutoLoad =
    !personaOverAutoLoad &&
    (personaLines >= Math.ceil(PM_MEMORY_MAX_LINES * PM_MEMORY_SOFT_WARN_RATIO) ||
      personaBytes >= Math.ceil(PM_MEMORY_MAX_BYTES * PM_MEMORY_SOFT_WARN_RATIO));

  return (
    <>
      <SettingsGroup label="Model">
        <AgentRows
          value={draft}
          onChange={changeAgent}
          disabled={agentSaving}
          switchingToVendor={persona.switchingToVendor}
          onCustomSubmit={() => void saveAgent()}
          {...(onManageProviders !== undefined ? { onManageProviders } : {})}
        />
        {editedAgent !== null && (
          <div className="px-4 py-3">
            {agentError && <RowError error={agentError} />}
            <div className={agentError ? "mt-2 flex items-center justify-end gap-2" : "flex items-center justify-end gap-2"}>
              <Button type="button" variant="ghost" disabled={agentSaving} onClick={cancelAgent}>
                Cancel
              </Button>
              <Button type="button" disabled={!canSaveAgent} onClick={() => void saveAgent()}>
                {agentSaving && <Loader2 aria-hidden="true" />}
                Save
              </Button>
            </div>
          </div>
        )}
      </SettingsGroup>
      <SettingsGroup title="Mode">
        <ModeRows label="Mode" value={mode} onChange={(m) => modeSave.save(m, m === persona.mode ? {} : { mode: m })} />
        {modeSave.error && (
          <div className="px-4 py-2.5">
            <RowError error={modeSave.error} />
          </div>
        )}
      </SettingsGroup>
      {folders.length > 0 && (
        <SettingsGroup title="Folders">
          <ul aria-label="Folders" className="divide-y divide-border">
            {folders.map((f) => (
              <li key={f.id} title={f.path} className="flex min-h-14 items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body">{folderName(f.path)}</div>
                  <div className="truncate text-minor leading-snug text-muted-foreground">{shortPath(f.path)}</div>
                </div>
                {f.isMain && <span className="shrink-0 text-xs text-muted-foreground">Main folder</span>}
              </li>
            ))}
          </ul>
        </SettingsGroup>
      )}
      <ScheduleGroup pmId={pm.id} schedules={schedules} />
      <SettingsGroup
        title="Persona"
        action={
          textDirty && (
            <Button size="sm" disabled={tooLong || busy !== null} onClick={saveText}>
              {busy === "text" && <Loader2 aria-hidden="true" />}
              Save
            </Button>
          )
        }
      >
        <Textarea
          aria-label="Persona"
          placeholder="No persona yet"
          rows={1}
          className={cn(
            "block max-h-[60vh] min-h-0 resize-none rounded-none border-0 bg-transparent px-4 py-3 placeholder:font-sans placeholder:text-body field-sizing-content focus-visible:ring-0",
            text === "" ? "text-body" : "font-mono text-minor",
          )}
          value={text}
          onChange={(e) => setDraftText(e.target.value)}
        />
        {(personaOverAutoLoad || personaNearAutoLoad) && !tooLong && (
          <p className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">
            {personaOverAutoLoad
              ? `Only the first ${PM_MEMORY_MAX_LINES} lines (${PM_MEMORY_MAX_BYTES / 1024} KB) load automatically. Move detailed notes into Memory files below`
              : `Approaching the ${PM_MEMORY_MAX_LINES} lines (${PM_MEMORY_MAX_BYTES / 1024} KB) auto-load limit. Move detailed notes into Memory files below`}
          </p>
        )}
        {(tooLong || textError) && (
          <div className="px-4 py-2.5">
            {tooLong ? <RowError>Persona is too long</RowError> : textError !== undefined && <RowError error={textError} />}
          </div>
        )}
      </SettingsGroup>
      <PmMemoryFilesGroup key={pm.id} pmId={pm.id} archived={pm.archivedAt != null} />
      <CollapsibleGroup title="History" summary={String(persona.changes.length)}>
        {revertError && (
          <div className="px-4 py-2.5">
            <RowError error={revertError} />
          </div>
        )}
        {persona.changes.length === 0 ? (
          <p className="px-4 py-3 text-body text-muted-foreground">No changes yet</p>
        ) : (
          <ul aria-label="History" className="divide-y divide-border">
            {persona.changes.map((change) => (
              <ChangeRow
                key={change.id}
                change={change}
                revertable={change.id === persona.revertableChangeId}
                busy={busy !== null || agentSaving}
                onRevert={() => revert(change.id)}
              />
            ))}
          </ul>
        )}
      </CollapsibleGroup>
    </>
  );
}

function ArchiveStatusGroup({ pmId, archivedAt }: { pmId: number; archivedAt: number }) {
  const client = useClient();
  const [unarchiving, setUnarchiving] = useState(false);
  const [unarchiveError, setUnarchiveError] = useState<ErrorLike | null>(null);
  const unarchive = async () => {
    setUnarchiving(true);
    setUnarchiveError(null);
    try {
      await client.postUnarchivePm(pmId);
    } catch (err) {
      setUnarchiveError(errorText(err));
    } finally {
      setUnarchiving(false);
    }
  };
  return (
    <SettingsGroup label="Archive status">
      <SettingsRow label="Archived" detail={formatArchiveRemaining(archivedAt)} error={unarchiveError}>
        {() => (
          <Button disabled={unarchiving} onClick={() => void unarchive()}>
            {unarchiving && <Loader2 aria-hidden="true" />}
            {unarchiving ? "Restoring…" : "Restore"}
          </Button>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}

function RenewSessionGroup({
  pmId,
  renewing,
  disabled = false,
  onArchived,
}: {
  pmId: number;
  renewing: boolean;
  disabled?: boolean;
  onArchived: () => void;
}) {
  const client = useClient();
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<ErrorLike | null>(null);
  const confirm = async () => {
    setConfirming(false);
    setSending(true);
    setError(null);
    try {
      await client.postRenewSession(pmId);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };
  const confirmArchive = async () => {
    setConfirmingArchive(false);
    setArchiving(true);
    setArchiveError(null);
    try {
      await client.postArchivePm(pmId);
      onArchived();
    } catch (err) {
      setArchiveError(errorText(err));
    } finally {
      setArchiving(false);
    }
  };
  const busy = renewing || sending;
  return (
    <SettingsGroup title="Session">
      <SettingsRow label="New session" detail="The project manager writes a handoff first. Chat history stays" error={error}>
        {() => (
          <Button variant="outline" disabled={busy || disabled} onClick={() => setConfirming(true)}>
            {busy && <Loader2 aria-hidden="true" />}
            {busy ? "Handing off…" : "Start…"}
          </Button>
        )}
      </SettingsRow>
      <SettingsRow label="Archive project manager" detail="Stops the session and schedules. Data is deleted after 7 days" error={archiveError}>
        {() => (
          <Button variant="outline" disabled={archiving} onClick={() => setConfirmingArchive(true)}>
            {archiving && <Loader2 aria-hidden="true" />}
            {archiving ? "Archiving…" : "Archive…"}
          </Button>
        )}
      </SettingsRow>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent title="Start a new session?" className="max-w-110">
          <p>The project manager writes a handoff, then continues in a fresh session. Your chat history stays.</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={() => void confirm()}>New session</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmingArchive} onOpenChange={setConfirmingArchive}>
        <DialogContent title="Archive project manager?" className="max-w-110">
          <p>Archiving stops the current session, ends unfinished Pieces and pauses schedules. You can restore it within 7 days. After that, its chat and internal data are deleted for good. Your project folder stays untouched.</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={() => void confirmArchive()}>Archive</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}

function LookButton({ pm }: { pm: Pm }) {
  const client = useClient();
  const saved = resolvePmLook(pm);
  const [preview, setPreview] = useState<{ look: SlimeLook; awaitingEchoFrom: Pm | null } | null>(null);
  const [error, setError] = useState<ErrorLike | null>(null);
  const queued = useRef<{ look: SlimeLook; before: Pm } | null>(null);
  const saving = useRef(false);
  useEffect(() => {
    if (preview?.look === saved && preview.awaitingEchoFrom !== null && pm !== preview.awaitingEchoFrom) {
      setPreview(null);
    }
  }, [preview, saved, pm]);
  const look = preview?.look ?? saved;
  const change = async (next: SlimeLook) => {
    queued.current = { look: next, before: pm };
    setPreview({ look: next, awaitingEchoFrom: null });
    setError(null);
    if (saving.current) return;
    saving.current = true;
    while (queued.current !== null) {
      const { look: pending, before } = queued.current;
      queued.current = null;
      try {
        await client.putPmLook(pm.id, pending);
        if (queued.current === null) setPreview({ look: pending, awaitingEchoFrom: before });
      } catch (err) {
        if (queued.current === null) {
          setPreview(null);
          setError(errorText(err));
        }
      }
    }
    saving.current = false;
  };
  return (
    <SlimePicker look={look} onChange={change} error={error}>
      <button
        type="button"
        aria-label="Change look"
        title="Change look"
        className="cursor-pointer rounded-2xl p-1 transition-colors outline-none hover:bg-jelly-hover focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-jelly"
      >
        <Avatar look={look} size={64} />
      </button>
    </SlimePicker>
  );
}

export function PmProfile({
  pm,
  project,
  folders,
  schedules,
  rev,
  renewing,
  onBack,
  onManageProviders,
}: {
  pm: Pm;
  project: Project | null;
  folders: ProjectFolder[];
  schedules: ScheduleRecord[];
  rev: number;
  renewing: boolean;
  onBack: () => void;
  onManageProviders?: () => void;
}) {
  const { load, retry, set } = usePersona(pm.id, rev);
  const label = `${pm.name}'s profile`;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLHeadingElement>(null);
  const [nameHidden, setNameHidden] = useState(false);
  useEffect(() => {
    const root = scrollerRef.current;
    const name = nameRef.current;
    if (root === null || name === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setNameHidden(entry !== undefined && !entry.isIntersecting), { root });
    observer.observe(name);
    return () => observer.disconnect();
  }, []);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={label}>
      <header data-window-drag className="flex h-16 min-w-0 shrink-0 items-center gap-3 overflow-hidden px-6">
        <Button variant="slot" size="icon" className="shrink-0" aria-label="Back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
        {nameHidden && (
          <div aria-hidden="true" className="flex min-w-0 items-center gap-3">
            <Avatar look={resolvePmLook(pm)} size={34} />
            <span className="min-w-0 truncate text-title leading-snug font-semibold">{pm.name}</span>
          </div>
        )}
      </header>
      <div ref={scrollerRef} className="page-fade min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-6 pt-4 pb-12">
        <div className="mx-auto grid max-w-160 grid-cols-1 gap-6">
          <header className="grid min-w-0 grid-cols-1 justify-items-center pb-2 text-center">
            <LookButton pm={pm} />
            <h1 ref={nameRef} className="mt-4 max-w-full wrap-break-word text-display leading-tight font-semibold tracking-tight">{pm.name}</h1>
            {project && (
              <p title={project.name} className="mt-1 w-full min-w-0 truncate text-minor text-muted-foreground">
                {project.name}
              </p>
            )}
          </header>
          {pm.archivedAt != null && <ArchiveStatusGroup key={pm.id} pmId={pm.id} archivedAt={pm.archivedAt} />}
          {load.phase === "loading" && (
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="size-pixel" aria-hidden="true" />
              Loading…
            </div>
          )}
          {load.phase === "error" && (
            <div className="flex items-center justify-center gap-3">
              <p role="alert" title={errorTitle(load.info)} className="text-danger">
                {errorLine(load.info)}
              </p>
              <Button variant="outline" size="sm" onClick={retry}>
                Retry
              </Button>
            </div>
          )}
          {load.phase === "ready" && (
            <PmEditor
              key={pm.id}
              pm={pm}
              folders={folders}
              schedules={schedules}
              persona={load.persona}
              onUpdate={set}
              {...(onManageProviders !== undefined ? { onManageProviders } : {})}
            />
          )}
          {load.phase === "ready" && pm.archivedAt == null && (
            <RenewSessionGroup pmId={pm.id} renewing={renewing} disabled={load.persona.switchingToVendor != null} onArchived={onBack} />
          )}
        </div>
      </div>
    </section>
  );
}

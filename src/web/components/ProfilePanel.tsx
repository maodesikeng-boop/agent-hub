import { useRef, useState, useEffect } from "react";
import type * as React from "react";
import {
  DEFAULT_AGENT_VENDOR,
  MAX_PERSONA_BYTES,
  MAX_SCHEDULES_PER_PM,
  effortLabel,
  modelLabel,
  splitModelEffort,
  utf8Bytes,
  type PersonaChange,
  type PersonaView,
  type Pm,
  type PmMode,
  type Project,
  type ProjectFolder,
  type ScheduleRecord,
} from "../../shared/index.ts";
import { resolvePmLook, type SlimeLook } from "../../shared/slimes.ts";
import { capabilitySections, capabilityTotals, useCapabilitiesView } from "../capabilities-model.ts";
import { useClient } from "../device-scope.tsx";
import { DEFAULT_CHOICE, MODE_LABELS, errorLine, errorText, formatArchiveRemaining, formatSchedule, shortPath, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useModelCatalog, vendorOptionLabel } from "../models.tsx";
import {
  formatChangeSummary,
  personaLoadHint,
  useAgentEditor,
  useAliveRef,
  useInstantSave,
  usePersona,
  usePersonaText,
} from "../pm-persona.ts";
import type { ProfilePage } from "../route.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "../ui/dialog.tsx";
import { Textarea } from "../ui/input.tsx";
import { ArrowLeft, ChevronRight, Loader2, MoreHorizontal, Pin, PinFilled } from "../ui/icons.ts";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { AgentRows } from "./AgentRows.tsx";
import { Avatar } from "./Avatar.tsx";
import { CapabilitiesPanel, countLabel } from "./CapabilitiesPanel.tsx";
import { ModeRows } from "./ModeRows.tsx";
import { PmMemoryFilesGroup } from "./PmMemoryFilesGroup.tsx";
import { WorktreeSetupGroup } from "./ProjectGroups.tsx";
import { ScheduleGroup } from "./ScheduleGroup.tsx";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";
import { SlimePicker } from "./SlimePicker.tsx";

export interface ProfilePanelProps {
  /** panel: inside the desktop side panel; page: a full-screen phone page. */
  variant: "panel" | "page";
  pm: Pm;
  project: Project | null;
  folders: ProjectFolder[];
  schedules: ScheduleRecord[];
  rev: number;
  renewing: boolean;
  /** null shows the summary. */
  page: ProfilePage | null;
  /** The PM's computer is offline: every edit and the pin toggle are disabled. */
  readOnly: boolean;
  onNavigate: (page: ProfilePage | null) => void;
  onClose: () => void;
  onTogglePin: (pinned: boolean) => void;
  onManageProviders?: () => void;
  /** Opens the Project defaults editor from the Capabilities page. */
  onEditDefaults?: () => void;
}

const EDIT_LINK =
  "touch-target cursor-pointer text-minor font-medium text-rail-ink outline-none hover:underline focus-visible:outline-2 focus-visible:outline-border-focus disabled:cursor-not-allowed disabled:opacity-50";

const PAGE_TITLES: Readonly<Record<ProfilePage, string>> = {
  capabilities: "Capabilities",
  persona: "Persona",
  memory: "Memory files",
  worktree: "Worktree setup",
  history: "History",
};

function folderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

function LookButton({ pm, disabled }: { pm: Pm; disabled: boolean }) {
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
    <SlimePicker look={look} onChange={(next) => void change(next)} error={error}>
      <button
        type="button"
        disabled={disabled}
        aria-label="Change look"
        title="Change look"
        className="cursor-pointer rounded-sm border border-transparent bg-hover p-2 transition-colors outline-none hover:border-border-strong focus-visible:outline-2 focus-visible:outline-border-focus data-[state=open]:border-select-line data-[state=open]:bg-open disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Avatar look={look} size={64} />
      </button>
    </SlimePicker>
  );
}

function ArchiveStatusGroup({ pmId, archivedAt, disabled }: { pmId: number; archivedAt: number; disabled: boolean }) {
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
          <Button disabled={disabled || unarchiving} onClick={() => void unarchive()}>
            {unarchiving && <Loader2 aria-hidden="true" />}
            {unarchiving ? "Restoring…" : "Restore"}
          </Button>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}

function SummaryHeader({
  pm,
  project,
  renewing,
  readOnly,
  switchingVendor,
  onTogglePin,
  onArchived,
}: {
  pm: Pm;
  project: Project | null;
  renewing: boolean;
  readOnly: boolean;
  switchingVendor: boolean;
  onTogglePin: (pinned: boolean) => void;
  onArchived: () => void;
}) {
  const client = useClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmRenew, setConfirmRenew] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [sendingRenew, setSendingRenew] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [actionError, setActionError] = useState<ErrorLike | null>(null);

  const pinned = typeof pm.pinnedAt === "number";
  const archived = pm.archivedAt != null;
  const renewBusy = renewing || sendingRenew;

  const doRenew = async () => {
    setConfirmRenew(false);
    setSendingRenew(true);
    setActionError(null);
    try {
      await client.postRenewSession(pm.id);
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setSendingRenew(false);
    }
  };

  const doArchive = async () => {
    setConfirmArchive(false);
    setArchiving(true);
    setActionError(null);
    try {
      await client.postArchivePm(pm.id);
      onArchived();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setArchiving(false);
    }
  };

  return (
    <header className="grid grid-cols-1 gap-3 pb-4">
      <div className="flex items-start gap-4">
        <LookButton pm={pm} disabled={readOnly || archived} />
        <div className="min-w-0 flex-1">
          <h1 title={pm.name} className="truncate text-display leading-tight font-semibold tracking-tight text-foreground">
            {pm.name}
          </h1>
          {project !== null && (
            <p title={project.name} className="mt-0.5 truncate text-minor text-muted-foreground">
              {project.name}
            </p>
          )}
          {!archived && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant={pinned ? "slot" : "outline"}
                size="sm"
                aria-pressed={pinned}
                disabled={readOnly}
                onClick={() => onTogglePin(!pinned)}
              >
                {pinned ? <PinFilled aria-hidden="true" /> : <Pin aria-hidden="true" />}
                Pinned
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={readOnly || renewBusy || switchingVendor}
                onClick={() => setConfirmRenew(true)}
              >
                {renewBusy && <Loader2 aria-hidden="true" />}
                {renewBusy ? "Handing off…" : "New session..."}
              </Button>
              <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="icon-sm" aria-label="More actions" disabled={readOnly}>
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-44 min-w-44 p-1.5">
                  <button
                    type="button"
                    disabled={readOnly || archiving}
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirmArchive(true);
                    }}
                    className="flex min-h-9 w-full cursor-pointer items-center rounded-xs px-3 py-1.5 text-left text-minor font-medium text-danger transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Archive...
                  </button>
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
      </div>
      {actionError && <RowError error={actionError} />}

      <Dialog open={confirmRenew} onOpenChange={setConfirmRenew}>
        <DialogContent title="Start a new session?" className="max-w-110">
          <p>The project manager writes a handoff, then continues in a fresh session. Your chat history stays.</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={() => void doRenew()}>New session</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <DialogContent title="Archive project manager?" className="max-w-110">
          <p>Archiving stops the current session, ends unfinished Pieces and pauses schedules. You can restore it within 7 days. After that, its chat and internal data are deleted for good. Your project folder stays untouched.</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={() => void doArchive()}>
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}

function ChangeRow({ change, revertable, busy, onRevert }: { change: PersonaChange; revertable: boolean; busy: boolean; onRevert: () => void }) {
  const [open, setOpen] = useState(false);
  const catalog = useModelCatalog(change.vendorAfter);
  const { actor, summary, timestamp } = formatChangeSummary(change, catalog);
  const textChanged = change.textBefore !== change.textAfter;
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-body break-words">
            <span className="font-medium">{actor}</span> {summary}
            {change.reason && <span>: {change.reason}</span>}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{timestamp}</div>
        </div>
        {revertable && (
          <Button variant="ghost" size="sm" className="shrink-0" disabled={busy} onClick={onRevert}>
            Undo
          </Button>
        )}
      </div>
      {textChanged && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="group mt-1.5 flex cursor-pointer items-center gap-1 text-minor text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus">
            <ChevronRight className="size-pixel-sm transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
            View changes
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 grid grid-cols-1 gap-2">
            {(["Before", "After"] as const).map((label) => (
              <div key={label} className="min-w-0">
                <div className="mb-1 text-minor font-medium text-muted-foreground">{label}</div>
                <pre className="min-h-10 max-h-60 overflow-auto rounded-sm bg-panel p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
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

function PersonaGroup({ persona, readOnly }: { persona: ReturnType<typeof usePersonaText>; readOnly: boolean }) {
  const { savedText, syncKey, textError, busy, save } = persona;
  const [trackedSyncKey, setTrackedSyncKey] = useState(syncKey);
  const [draftText, setDraftText] = useState<string | null>(null);
  if (trackedSyncKey !== syncKey) {
    setTrackedSyncKey(syncKey);
    setDraftText(null);
  }
  const text = readOnly ? savedText : (draftText ?? savedText);
  const dirty = !readOnly && text !== savedText;
  const tooLong = utf8Bytes(text) > MAX_PERSONA_BYTES;
  const hint = personaLoadHint(text);
  return (
    <SettingsGroup
      label="Persona"
      action={
        dirty && (
          <Button size="sm" disabled={tooLong || busy !== null} onClick={() => save(text)}>
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
        disabled={readOnly}
        className={cn(
          "block max-h-[60vh] min-h-0 resize-none border-0 bg-transparent px-4 py-3 placeholder:font-sans placeholder:text-body field-sizing-content focus:border-0 focus:shadow-none",
          text === "" ? "text-body" : "font-mono text-minor",
        )}
        value={text}
        onChange={(e) => {
          if (!readOnly) setDraftText(e.target.value);
        }}
      />
      {hint !== null && !tooLong && <p className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">{hint}</p>}
      {(tooLong || textError) && (
        <div className="px-4 py-2.5">
          {tooLong ? <RowError>Persona is too long</RowError> : textError !== undefined && <RowError error={textError} />}
        </div>
      )}
    </SettingsGroup>
  );
}

function HistoryGroup({
  persona,
  revertError,
  busy,
  onRevert,
}: {
  persona: PersonaView;
  revertError: ErrorLike | undefined;
  busy: boolean;
  onRevert: (changeId: number) => void;
}) {
  return (
    <SettingsGroup label="History">
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
              busy={busy}
              onRevert={() => onRevert(change.id)}
            />
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}

function SectionFrame({
  title,
  actionLabel,
  editing,
  readOnly,
  onToggle,
  children,
}: {
  title: string;
  actionLabel?: string;
  editing?: boolean;
  readOnly?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="border-t border-border py-3.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-minor font-semibold text-foreground">{title}</h2>
        {onToggle !== undefined && actionLabel !== undefined && (
          <button type="button" disabled={readOnly && !editing} onClick={onToggle} className={EDIT_LINK}>
            {editing ? "Done" : actionLabel}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function SummaryContent({
  pm,
  project,
  folders,
  schedules,
  persona,
  readOnly,
  onUpdate,
  onNavigate,
  onManageProviders,
}: {
  pm: Pm;
  project: Project | null;
  folders: ProjectFolder[];
  schedules: ScheduleRecord[];
  persona: PersonaView;
  readOnly: boolean;
  onUpdate: (p: PersonaView) => void;
  onNavigate: (page: ProfilePage) => void;
  onManageProviders: (() => void) | undefined;
}) {
  const aliveRef = useAliveRef();
  const agent = useAgentEditor(pm.id, persona, onUpdate, aliveRef);
  const modeSave = useInstantSave<PmMode>(pm.id, onUpdate, aliveRef);
  const catalog = useModelCatalog(persona.vendor);
  const { data: capsView } = useCapabilitiesView({ kind: "pm", pmId: pm.id });

  const [editing, setEditing] = useState<"model" | "mode" | "schedules" | null>(null);
  const toggleSection = (key: "model" | "mode" | "schedules") => {
    setEditing((prev) => (prev === key ? null : key));
  };

  const locked = readOnly || pm.archivedAt != null;
  const mode = modeSave.draft ?? persona.mode;
  const split = splitModelEffort(persona.vendor, persona.model, persona.effort, catalog);
  const modelText = split.model === null ? DEFAULT_CHOICE : modelLabel(persona.vendor, split.model, catalog);
  const effortText = split.effort === null ? DEFAULT_CHOICE : effortLabel(split.effort, persona.vendor, catalog);
  const capTotals = capsView === undefined ? null : capabilityTotals(capabilitySections(capsView));
  const capsSummary = capTotals !== null && capTotals.total > 0 ? countLabel(capTotals.enabled, capTotals.total) : undefined;

  return (
    <div>
      <SectionFrame title="Model" actionLabel="Edit" editing={editing === "model"} readOnly={locked} onToggle={() => toggleSection("model")}>
        {editing === "model" ? (
          <SettingsGroup>
            <AgentRows
              value={agent.draft}
              onChange={agent.change}
              disabled={agent.saving || locked}
              switchingToVendor={persona.switchingToVendor}
              onCustomSubmit={() => void agent.save()}
              {...(onManageProviders !== undefined ? { onManageProviders } : {})}
            />
            {agent.edited && (
              <div className="px-4 py-3">
                {agent.error && <RowError error={agent.error} />}
                <div className={agent.error ? "mt-2 flex items-center justify-end gap-2" : "flex items-center justify-end gap-2"}>
                  <Button type="button" variant="ghost" size="sm" disabled={agent.saving} onClick={agent.cancel}>
                    Cancel
                  </Button>
                  <Button type="button" size="sm" disabled={!agent.canSave || locked} onClick={() => void agent.save()}>
                    {agent.saving && <Loader2 aria-hidden="true" />}
                    Save
                  </Button>
                </div>
              </div>
            )}
          </SettingsGroup>
        ) : (
          <dl className="grid grid-cols-1 gap-1 text-body">
            <div className="flex items-baseline gap-3">
              <dt className="w-18 shrink-0 text-minor text-muted-foreground">Provider</dt>
              <dd className="min-w-0 truncate">{vendorOptionLabel(catalog)}</dd>
            </div>
            <div className="flex items-baseline gap-3">
              <dt className="w-18 shrink-0 text-minor text-muted-foreground">Model</dt>
              <dd className="min-w-0 truncate">{modelText}</dd>
            </div>
            <div className="flex items-baseline gap-3">
              <dt className="w-18 shrink-0 text-minor text-muted-foreground">Effort</dt>
              <dd className="min-w-0 truncate">{effortText}</dd>
            </div>
          </dl>
        )}
      </SectionFrame>

      <SectionFrame title="Mode" actionLabel="Edit" editing={editing === "mode"} readOnly={locked} onToggle={() => toggleSection("mode")}>
        {editing === "mode" ? (
          <SettingsGroup>
            <ModeRows label="Mode" value={mode} disabled={locked} onChange={(m) => modeSave.save(m, m === persona.mode ? {} : { mode: m })} />
            {modeSave.error && (
              <div className="px-4 py-2.5">
                <RowError error={modeSave.error} />
              </div>
            )}
          </SettingsGroup>
        ) : (
          <p className="text-body text-foreground">{MODE_LABELS[mode]}</p>
        )}
      </SectionFrame>

      <SectionFrame title="Folders">
        {folders.length === 0 ? (
          <p className="text-body text-muted-foreground">No folders</p>
        ) : (
          <ul className="grid grid-cols-1 gap-2">
            {folders.map((f) => (
              <li key={f.id} title={f.path} className="min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-body">{folderName(f.path)}</span>
                  {f.isMain && <span className="shrink-0 text-xs text-muted-foreground">Main folder</span>}
                </div>
                <div className="truncate text-minor text-muted-foreground">{shortPath(f.path)}</div>
              </li>
            ))}
          </ul>
        )}
      </SectionFrame>

      <SectionFrame
        title="Schedules"
        actionLabel={schedules.length === 0 ? "New" : "Edit"}
        editing={editing === "schedules"}
        readOnly={locked}
        onToggle={() => toggleSection("schedules")}
      >
        {editing === "schedules" ? (
          <ScheduleGroup pmId={pm.id} schedules={schedules} disabled={locked} />
        ) : schedules.length === 0 ? (
          <p className="text-body text-muted-foreground">No schedules</p>
        ) : (
          <ul className="grid grid-cols-1 gap-1.5">
            {schedules.slice(0, MAX_SCHEDULES_PER_PM).map((s) => (
              <li key={s.id} className="flex items-baseline justify-between gap-2 text-body">
                <span className="min-w-0 truncate">{s.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{s.enabled ? formatSchedule(s) : "Paused"}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionFrame>

      <nav aria-label="Project manager settings pages" className="divide-y divide-border border-y border-border">
        {pm.archivedAt == null && (
          <button
            type="button"
            onClick={() => onNavigate("capabilities")}
            className="flex min-h-12 w-full cursor-pointer rounded-none items-center justify-between gap-3 py-2.5 text-left text-body transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus"
          >
            <span>Capabilities</span>
            <span className="flex items-center gap-2 text-minor text-muted-foreground tabular-nums">
              {capsSummary}
              <ChevronRight className="size-pixel-sm shrink-0" aria-hidden="true" />
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={() => onNavigate("persona")}
          className="flex min-h-12 w-full cursor-pointer rounded-none items-center justify-between gap-3 py-2.5 text-left text-body transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus"
        >
          <span>Persona</span>
          <span className="flex items-center gap-2 text-minor text-muted-foreground tabular-nums">
            <span>{persona.text.trim() === "" ? "Empty" : "Set"}</span>
            <ChevronRight className="size-pixel-sm shrink-0" aria-hidden="true" />
          </span>
        </button>
        <button
          type="button"
          onClick={() => onNavigate("memory")}
          className="flex min-h-12 w-full cursor-pointer rounded-none items-center justify-between gap-3 py-2.5 text-left text-body transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus"
        >
          <span>Memory files</span>
          <ChevronRight className="size-pixel-sm shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
        {project !== null && (
          <button
            type="button"
            onClick={() => onNavigate("worktree")}
            className="flex min-h-12 w-full cursor-pointer rounded-none items-center justify-between gap-3 py-2.5 text-left text-body transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus"
          >
            <span>Worktree setup</span>
            <span className="flex items-center gap-2 text-minor text-muted-foreground">
              <span>{project.setupCommand ? "Configured" : "None"}</span>
              <ChevronRight className="size-pixel-sm shrink-0" aria-hidden="true" />
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={() => onNavigate("history")}
          className="flex min-h-12 w-full cursor-pointer rounded-none items-center justify-between gap-3 py-2.5 text-left text-body transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus"
        >
          <span>History</span>
          <span className="flex items-center gap-2 text-minor text-muted-foreground tabular-nums">
            <span>{persona.changes.length}</span>
            <ChevronRight className="size-pixel-sm shrink-0" aria-hidden="true" />
          </span>
        </button>
      </nav>
    </div>
  );
}

function DetailPageContent({
  page,
  pm,
  project,
  persona,
  readOnly,
  onUpdate,
  onEditDefaults,
}: {
  page: ProfilePage;
  pm: Pm;
  project: Project | null;
  persona: PersonaView;
  readOnly: boolean;
  onUpdate: (p: PersonaView) => void;
  onEditDefaults: (() => void) | undefined;
}) {
  const aliveRef = useAliveRef();
  const text = usePersonaText({ pmId: pm.id, persona, onUpdate, aliveRef, onReverted: () => {} });

  const locked = readOnly || pm.archivedAt != null;
  if (page === "capabilities") {
    return (
      <CapabilitiesPanel
        scope={{ kind: "pm", pmId: pm.id }}
        lead={pm.vendor ?? DEFAULT_AGENT_VENDOR}
        disabled={locked}
        {...(onEditDefaults !== undefined ? { onEditDefaults } : {})}
      />
    );
  }
  if (page === "persona") return <PersonaGroup persona={text} readOnly={locked} />;
  if (page === "memory") return <PmMemoryFilesGroup key={pm.id} pmId={pm.id} archived={locked} titled={false} />;
  if (page === "worktree") {
    return project !== null ? <WorktreeSetupGroup project={project} readOnly={locked} titled={false} /> : null;
  }
  return <HistoryGroup persona={persona} revertError={text.revertError} busy={locked || text.busy !== null} onRevert={text.revert} />;
}

/**
 * Postcondition: the summary shows the PM's tile, name, and project with Pinned, New session..., and the ... menu holding
 * Archive..., then Model, Mode, Folders, and Schedules sections whose Edit or New swaps in the existing editor in place,
 * then rows that open the capabilities, persona, memory, worktree, and history pages; a page shows a back arrow to the
 * summary. Archived PMs show the restore group and no Pinned button.
 */
export function ProfilePanel({
  variant,
  pm,
  project,
  folders,
  schedules,
  rev,
  renewing,
  page,
  readOnly,
  onNavigate,
  onClose,
  onTogglePin,
  onManageProviders,
  onEditDefaults,
}: ProfilePanelProps): React.ReactElement {
  const { load, retry, set } = usePersona(pm.id, rev);
  const activePage = pm.archivedAt != null && page === "capabilities" ? null : page;
  const isPage = variant === "page";
  const pageTitle = activePage === null ? pm.name : PAGE_TITLES[activePage];

  const body = (
    <div className={cn("min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain", isPage ? "page-fade px-6 pt-4 pb-12" : "right-rail-scroll px-5 py-4")}>
      <div className={cn("mx-auto grid grid-cols-1 gap-4", isPage && "max-w-160")}>
        {activePage === null && (
          <>
            <SummaryHeader
              pm={pm}
              project={project}
              renewing={renewing}
              readOnly={readOnly}
              switchingVendor={load.phase === "ready" && load.persona.switchingToVendor != null}
              onTogglePin={onTogglePin}
              onArchived={onClose}
            />
            {pm.archivedAt != null && <ArchiveStatusGroup key={pm.id} pmId={pm.id} archivedAt={pm.archivedAt} disabled={readOnly} />}
          </>
        )}

        {load.phase === "loading" && (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="size-pixel" aria-hidden="true" />
            Loading…
          </div>
        )}

        {load.phase === "error" && (
          <div className="flex items-center justify-center gap-3 py-8">
            <p role="alert" className="text-danger">
              {errorLine(load.info)}
            </p>
            <Button variant="outline" size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        )}

        {load.phase === "ready" &&
          (activePage === null ? (
            <SummaryContent
              key={pm.id}
              pm={pm}
              project={project}
              folders={folders}
              schedules={schedules}
              persona={load.persona}
              readOnly={readOnly}
              onUpdate={set}
              onNavigate={(next) => onNavigate(next)}
              onManageProviders={onManageProviders}
            />
          ) : (
            <DetailPageContent
              page={activePage}
              pm={pm}
              project={project}
              persona={load.persona}
              readOnly={readOnly}
              onUpdate={set}
              onEditDefaults={onEditDefaults}
            />
          ))}
      </div>
    </div>
  );

  if (isPage) {
    return (
      <section aria-label={`${pm.name}'s settings`} className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel text-foreground">
        <header data-window-drag className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 pt-[var(--safe-top)]">
          <Button
            variant="ghost"
            size="icon"
            aria-label={activePage === null ? "Back" : "Back to settings summary"}
            onClick={() => (activePage === null ? onClose() : onNavigate(null))}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <span title={pageTitle} className="min-w-0 flex-1 truncate text-title font-semibold">
            {pageTitle}
          </span>
        </header>
        {body}
      </section>
    );
  }

  return body;
}

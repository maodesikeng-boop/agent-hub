import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Loader2 } from "lucide-react";
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
import { ModeRows } from "./ModeRows.tsx";
import { PmMemoryFilesGroup } from "./PmMemoryFilesGroup.tsx";
import { ScheduleGroup } from "./ScheduleGroup.tsx";
import { CollapsibleGroup, RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

type Load = { phase: "loading" } | { phase: "error"; info: ErrorInfo } | { phase: "ready"; persona: PersonaView };

/** 性格设定：进页面拉一次；rev 变了（pm.updated，别处改了）重新拉。 */
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
  // 老数据里 agy 的模型是带档位的完整 ID：拆成 模型 + 思考程度，各写各的
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
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
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

/** 路径最后一段（文件夹名）。 */
function folderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

function sameSetting(a: AgentSetting, b: AgentSetting): boolean {
  return a.vendor === b.vendor && a.model === b.model && a.effort === b.effort;
}

/** 只带改了的几项。 */
function agentPatch(next: AgentSetting, saved: AgentSetting): EditPersonaRequest {
  return {
    ...(next.vendor !== saved.vendor ? { vendor: next.vendor } : {}),
    ...(next.model !== saved.model ? { model: next.model } : {}),
    ...(next.effort !== saved.effort ? { effort: next.effort } : {}),
  };
}

/**
 * 一项“改了马上存”的设置：先显示改后的值（乐观），存成功换成服务端回的；失败退回服务端的值，错误给调用方显示在那一行。
 * 连着改几次时，只有最后一次的结果决定显示什么（前面的回来了也照样更新服务端的值）。
 */
function useInstantSave<T, K extends string>(pmId: number, onUpdate: (p: PersonaView) => void, aliveRef: { current: boolean }) {
  const client = useClient();
  const [draft, setDraft] = useState<T | null>(null);
  const [error, setError] = useState<{ key: K; info: ErrorInfo } | null>(null);
  const seq = useRef(0);
  const save = (next: T, key: K, body: EditPersonaRequest | null) => {
    setDraft(next);
    setError(null);
    const mine = ++seq.current;
    if (body === null) return; // 还不能存（比如自定义模型名还没填好）：只显示
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
        setError({ key, info: errorText(err) });
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

/** 模型、工作方式改了马上存；性格设定改了才出现“保存”；修改记录在最后（默认收起）。项目名只在头部，这里不再列。 */
function PmEditor({
  pm,
  folders,
  schedules,
  persona,
  onUpdate,
}: {
  pm: Pm;
  folders: ProjectFolder[];
  schedules: ScheduleRecord[];
  persona: PersonaView;
  onUpdate: (p: PersonaView) => void;
}) {
  const client = useClient();
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  // 老数据里 agy 的模型可能是带档位的完整 ID：按 模型 + 思考程度 拆开再比，没改的不重复存
  const saved: AgentSetting = { vendor: persona.vendor, ...splitModelEffort(persona.vendor, persona.model, persona.effort) };
  const agentSave = useInstantSave<AgentDraft, AgentRowKey>(pm.id, onUpdate, aliveRef);
  const modeSave = useInstantSave<PmMode, "mode">(pm.id, onUpdate, aliveRef);
  const agent = agentSave.draft ?? draftOf(saved);
  const mode = modeSave.draft ?? persona.mode;

  const changeAgent = (next: AgentDraft, row: AgentRowKey) => {
    const result = settingOf(next);
    agentSave.save(next, row, next.modelChoice === CUSTOM_MODEL || !result.ok ? null : agentPatch(result.setting, saved));
  };
  const agentResult = settingOf(agent);
  const customDirty = agent.modelChoice === CUSTOM_MODEL && agentResult.ok && !sameSetting(agentResult.setting, saved);
  const saveCustom = () => {
    if (customDirty && agentResult.ok) agentSave.save({ ...agent, modelChoice: agentResult.setting.model ?? "", customModel: "" }, "model", agentPatch(agentResult.setting, saved));
  };

  // 性格设定：null = 没动过，显示服务端的最新；动过就保留自己的输入，别处改了也不覆盖
  const qc = useHubQueryClient();
  const [draftText, setDraftText] = useState<string | null>(null);
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
        // 撤销的结果回来后，本地没提交的输入已经没意义了
        agentSave.reset();
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
      {/* 头部下面第一组，头部就是它的标题，不另写组名 */}
      <SettingsGroup label="Model">
        <AgentRows
          value={agent}
          onChange={changeAgent}
          switchingToVendor={persona.switchingToVendor}
          errors={agentSave.error ? { [agentSave.error.key]: agentSave.error.info } : {}}
          onCustomSubmit={saveCustom}
          customAction={
            customDirty && (
              <Button onClick={saveCustom}>
                Save
              </Button>
            )
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Mode">
        <ModeRows label="Mode" value={mode} onChange={(m) => modeSave.save(m, "mode", m === persona.mode ? {} : { mode: m })} />
        {modeSave.error && (
          <div className="px-4 py-2.5">
            <RowError error={modeSave.error.info} />
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
              {busy === "text" && <Loader2 className="animate-spin" aria-hidden="true" />}
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
      {/* 修改记录会越攒越多：默认收起，标题行带条数，点开才列出来 */}
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
                busy={busy !== null}
                onRevert={() => revert(change.id)}
              />
            ))}
          </ul>
        )}
      </CollapsibleGroup>
    </>
  );
}

/**
 * 已归档项目经理顶部的“归档状态”一组：显示剩余删除天数与“恢复”按钮。
 */
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
      <SettingsRow label="Archived" detail={`${formatArchiveRemaining(archivedAt)}. Your project folder stays untouched`} error={unarchiveError}>
        {() => (
          <Button variant="outline" disabled={unarchiving} onClick={() => void unarchive()}>
            {unarchiving && <Loader2 className="animate-spin" aria-hidden="true" />}
            {unarchiving ? "Restoring…" : "Restore"}
          </Button>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * “会话”一组：开新会话、归档项目经理。点了先确认；确认后项目经理先写交接，写完换一个新会话（ledger/handover.ts）。
 * renewing：在换（交接请求还没结果），按钮不能点。对话太长时系统也会自动换（同一套，聊天里只多一条分隔线）。
 */
function RenewSessionGroup({ pmId, renewing, onArchived }: { pmId: number; renewing: boolean; onArchived: () => void }) {
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
      {/* 行名说是什么，按钮说做什么（不重复）；“…”表示点了还要确认。在换的时候是状态，用英文 */}
      <SettingsRow label="New session" detail="The project manager writes a handoff first. Chat history stays" error={error}>
        {() => (
          <Button variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            {busy ? "Handing off…" : "Start…"}
          </Button>
        )}
      </SettingsRow>
      <SettingsRow label="Archive project manager" detail="Stops the session and schedules. Data is deleted after 7 days" error={archiveError}>
        {() => (
          <Button variant="outline" disabled={archiving} onClick={() => setConfirmingArchive(true)}>
            {archiving && <Loader2 className="animate-spin" aria-hidden="true" />}
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

/** 项目经理资料页（设计第 3.6 节）：头像、名字、项目名居中，下面是模型、工作方式、文件夹、定时任务、性格设定、修改记录、会话几组设置。 */
export function PmProfile({
  pm,
  project,
  folders,
  schedules,
  rev,
  renewing,
  onBack,
}: {
  pm: Pm;
  project: Project | null;
  /** 项目没移除的文件夹，主文件夹在前。 */
  folders: ProjectFolder[];
  /** 这个项目经理的定时任务。 */
  schedules: ScheduleRecord[];
  /** pm.updated 的次数，变了就重新拉。 */
  rev: number;
  /** 在换新会话（selectors.ts 的 isRenewing）。 */
  renewing: boolean;
  onBack: () => void;
}) {
  const { load, retry, set } = usePersona(pm.id, rev);
  const label = `${pm.name}'s profile`;
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={label}>
      <header data-window-drag className="flex h-16 shrink-0 items-center px-6">
        <Button variant="ghost" size="icon" aria-label="Back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-6 pb-12">
        <div className="mx-auto grid max-w-160 gap-6">
          <header className="flex flex-col items-center pb-2 text-center">
            <Avatar colorKey={pm.id} size={64} />
            <h1 className="mt-4 text-display leading-tight font-semibold tracking-tight">{pm.name}</h1>
            {project && <p className="mt-1 text-minor text-muted-foreground">{project.name}</p>}
          </header>
          {pm.archivedAt != null && <ArchiveStatusGroup key={pm.id} pmId={pm.id} archivedAt={pm.archivedAt} />}
          {load.phase === "loading" && (
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
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
          {load.phase === "ready" && <PmEditor pm={pm} folders={folders} schedules={schedules} persona={load.persona} onUpdate={set} />}
          {load.phase === "ready" && pm.archivedAt == null && (
            <RenewSessionGroup pmId={pm.id} renewing={renewing || (load.phase === "ready" && load.persona.switchingToVendor != null)} onArchived={onBack} />
          )}
        </div>
      </div>
    </section>
  );
}

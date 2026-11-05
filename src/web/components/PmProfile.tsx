import { ArrowLeft, ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CUSTOM_MODEL,
  DEFAULT_AGENT_VENDOR,
  MAX_PERSONA_BYTES,
  PM_MODE_LABELS,
  effortLabel,
  isAgentVendor,
  modelLabel,
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
import { ApiError, fetchPersona, postRenewSession, postRevertPersonaChange, putPersona } from "../client.ts";
import { ACTOR_LABELS, errorText, formatTime, shortPath } from "../format.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "../ui/dialog.tsx";
import { Textarea } from "../ui/input.tsx";
import { useModelCatalog } from "../models.tsx";
import { AgentRows, draftOf, settingOf, type AgentDraft, type AgentRowKey } from "./AgentRows.tsx";
import { Avatar } from "./Avatar.tsx";
import { ModeRows } from "./ModeRows.tsx";
import { ScheduleGroup } from "./ScheduleGroup.tsx";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

type Load = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; persona: PersonaView };

/** 性格设定：进页面拉一次；rev 变了（pm.updated，别处改了）重新拉。 */
function usePersona(pmId: number, rev: number) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchPersona(pmId).then(
      (persona) => alive && setLoad({ phase: "ready", persona }),
      (err: unknown) => alive && setLoad((prev) => (prev.phase === "ready" ? prev : { phase: "error", message: errorText(err) })),
    );
    return () => {
      alive = false;
    };
  }, [pmId, rev, attempt]);
  const retry = useCallback(() => {
    setLoad({ phase: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  const set = useCallback((persona: PersonaView) => setLoad({ phase: "ready", persona }), []);
  return { load, retry, set };
}

function describeChange(change: PersonaChange, catalog: ModelCatalog): string {
  if (change.revertOf !== null) return "撤销了一次修改";
  const parts: string[] = [];
  if (change.textBefore !== change.textAfter) parts.push("改了性格设定");
  if (change.modeBefore !== change.modeAfter) parts.push(`模式改成${PM_MODE_LABELS[change.modeAfter]}`);
  if (change.vendorBefore !== change.vendorAfter) parts.push(`厂商改成${vendorLabel(change.vendorAfter)}`);
  if (change.modelBefore !== change.modelAfter) parts.push(`模型改成${modelLabel(change.vendorAfter, change.modelAfter, catalog)}`);
  if (change.effortBefore !== change.effortAfter) parts.push(`思考程度改成${effortLabel(change.effortAfter)}`);
  return parts.join("，") || "改了设置";
}

function ChangeRow({ change, revertable, busy, onRevert }: { change: PersonaChange; revertable: boolean; busy: boolean; onRevert: () => void }) {
  const [open, setOpen] = useState(false);
  const catalog = useModelCatalog(isAgentVendor(change.vendorAfter) ? change.vendorAfter : DEFAULT_AGENT_VENDOR);
  const textChanged = change.textBefore !== change.textAfter;
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[15px]">
            <span className="font-medium">{ACTOR_LABELS[change.actor]}</span> {describeChange(change, catalog)}
            {change.reason && <span>：{change.reason}</span>}
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">{formatTime(change.createdAt)}</div>
        </div>
        {revertable && (
          <Button variant="outline" size="sm" disabled={busy} onClick={onRevert}>
            撤销
          </Button>
        )}
      </div>
      {textChanged && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="group mt-1 flex cursor-pointer items-center gap-1 rounded-full text-[13.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
            查看改动
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 grid gap-2 sm:grid-cols-2">
            {(["改之前", "改之后"] as const).map((label) => (
              <div key={label} className="min-w-0">
                <div className="mb-1 text-[13.5px] font-medium text-muted-foreground">{label}</div>
                <pre className="max-h-60 overflow-auto rounded-xl bg-background p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {label === "改之前" ? change.textBefore : change.textAfter}
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
  const [draft, setDraft] = useState<T | null>(null);
  const [error, setError] = useState<{ key: K; message: string } | null>(null);
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
    putPersona(pmId, body).then(
      (res) => {
        if (!aliveRef.current) return;
        onUpdate(res.persona);
        if (mine === seq.current) setDraft(null);
      },
      (err: unknown) => {
        if (!aliveRef.current || mine !== seq.current) return;
        setDraft(null);
        setError({ key, message: errorText(err) });
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

/** 模型、工作方式改了马上存；性格设定改了才出现“保存”；修改记录在最后。项目名只在头部，这里不再列。 */
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
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const saved: AgentSetting = { vendor: persona.vendor, model: persona.model, effort: persona.effort };
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
  const [draftText, setDraftText] = useState<string | null>(null);
  const [busy, setBusy] = useState<"text" | "revert" | null>(null);
  const [errors, setErrors] = useState<Partial<Record<"text" | "revert", string>>>({});
  const text = draftText ?? persona.text;
  const tooLong = utf8Bytes(text) > MAX_PERSONA_BYTES;
  const textDirty = text !== persona.text;

  const run = async (what: "text" | "revert", call: () => Promise<PersonaView>, reset: () => void, failText?: (err: unknown) => string) => {
    setBusy(what);
    setErrors((e) => ({ ...e, [what]: undefined }));
    try {
      const next = await call();
      if (!aliveRef.current) return;
      reset();
      onUpdate(next);
    } catch (err) {
      if (aliveRef.current) setErrors((e) => ({ ...e, [what]: failText?.(err) ?? errorText(err) }));
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };
  const saveText = () => void run("text", async () => (await putPersona(pm.id, { text })).persona, () => setDraftText(null));
  const revert = (changeId: number) =>
    void run(
      "revert",
      async () => (await postRevertPersonaChange(changeId)).persona,
      // 撤销的结果回来后，本地没提交的输入已经没意义了
      () => {
        agentSave.reset();
        modeSave.reset();
        setDraftText(null);
      },
      (err) => (err instanceof ApiError && err.status === 409 ? "只能撤销最近一次" : errorText(err)),
    );

  return (
    <>
      {/* 头部下面第一组，头部就是它的标题，不另写组名 */}
      <SettingsGroup label="模型">
        <AgentRows
          value={agent}
          onChange={changeAgent}
          errors={agentSave.error ? { [agentSave.error.key]: agentSave.error.message } : {}}
          onCustomSubmit={saveCustom}
          customAction={
            customDirty && (
              <Button onClick={saveCustom}>
                保存
              </Button>
            )
          }
        />
      </SettingsGroup>
      <SettingsGroup title="工作方式">
        <ModeRows label="工作方式" value={mode} onChange={(m) => modeSave.save(m, "mode", m === persona.mode ? {} : { mode: m })} />
        {modeSave.error && (
          <div className="px-4 py-2.5">
            <RowError>{modeSave.error.message}</RowError>
          </div>
        )}
      </SettingsGroup>
      {folders.length > 0 && (
        <SettingsGroup title="文件夹">
          <ul aria-label="文件夹" className="divide-y divide-sidebar-active">
            {folders.map((f) => (
              <li key={f.id} title={f.path} className="flex min-h-14 items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px]">{folderName(f.path)}</div>
                  <div className="truncate text-[13.5px] leading-snug text-muted-foreground">{shortPath(f.path)}</div>
                </div>
                {f.isMain && <span className="shrink-0 text-xs text-muted-foreground">主文件夹</span>}
              </li>
            ))}
          </ul>
        </SettingsGroup>
      )}
      <ScheduleGroup pmId={pm.id} schedules={schedules} />
      <SettingsGroup
        title="性格设定"
        action={
          textDirty && (
            <Button size="sm" disabled={tooLong || busy !== null} onClick={saveText}>
              {busy === "text" && <Loader2 className="animate-spin" aria-hidden="true" />}
              保存
            </Button>
          )
        }
      >
        <Textarea
          aria-label="性格设定"
          rows={12}
          className="block max-h-[60vh] min-h-32 resize-none rounded-none border-0 bg-transparent px-4 py-3 font-mono text-[13.5px] field-sizing-content focus-visible:ring-0"
          value={text}
          onChange={(e) => setDraftText(e.target.value)}
        />
        {(tooLong || errors.text) && (
          <div className="px-4 py-2.5">
            <RowError>{tooLong ? "性格设定太长" : errors.text}</RowError>
          </div>
        )}
      </SettingsGroup>
      <SettingsGroup title="修改记录">
        {errors.revert && (
          <div className="px-4 py-2.5">
            <RowError>{errors.revert}</RowError>
          </div>
        )}
        {persona.changes.length === 0 ? (
          <p className="px-4 py-3 text-[15px] text-muted-foreground">还没有修改</p>
        ) : (
          <ul aria-label="修改记录" className="divide-y divide-sidebar-active">
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
      </SettingsGroup>
    </>
  );
}

/**
 * “会话”一组：开新会话。点了先确认；确认后项目经理先写交接，写完换一个新会话（ledger/handover.ts）。
 * renewing：在换（交接请求还没结果、新会话的第一条还没发），按钮不能点。
 */
function RenewSessionGroup({ pmId, renewing }: { pmId: number; renewing: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setConfirming(false);
    setSending(true);
    setError(null);
    try {
      await postRenewSession(pmId);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };
  const busy = renewing || sending;
  return (
    <SettingsGroup title="会话">
      {/* 行名说是什么，按钮说做什么（不重复）；“…”表示点了还要确认。在换的时候是状态，用英文 */}
      <SettingsRow label="开新会话" detail="项目经理先写交接，聊天记录都在" error={error}>
        {() => (
          <Button variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            {busy ? "Handing off…" : "开始…"}
          </Button>
        )}
      </SettingsRow>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent title="开新会话？" className="max-w-[440px]">
          <p>项目经理先写一份交接，写完换一个新会话接着干。聊天记录都还在。</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <Button onClick={() => void confirm()}>开新会话</Button>
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
  const label = `${pm.name} 的资料`;
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={label}>
      <div className="flex h-16 shrink-0 items-center px-6">
        <Button variant="ghost" size="icon" aria-label="返回" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-12">
        <div className="mx-auto grid max-w-[640px] gap-6">
          <header className="flex flex-col items-center pb-2 text-center">
            <Avatar colorKey={pm.id} size={64} />
            <h1 className="mt-4 text-[22px] leading-tight font-semibold tracking-tight">{pm.name}</h1>
            {project && <p className="mt-1 text-[13.5px] text-muted-foreground">{project.name}</p>}
          </header>
          {load.phase === "loading" && (
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              加载中
            </div>
          )}
          {load.phase === "error" && (
            <div className="flex items-center justify-center gap-3">
              <p role="alert" className="text-danger">
                {load.message}
              </p>
              <Button variant="outline" size="sm" onClick={retry}>
                重试
              </Button>
            </div>
          )}
          {load.phase === "ready" && <PmEditor pm={pm} folders={folders} schedules={schedules} persona={load.persona} onUpdate={set} />}
          {load.phase === "ready" && <RenewSessionGroup pmId={pm.id} renewing={renewing} />}
        </div>
      </div>
    </section>
  );
}

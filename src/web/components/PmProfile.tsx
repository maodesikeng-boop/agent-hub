import { ArrowLeft, ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  MAX_PERSONA_BYTES,
  PM_MODE_LABELS,
  effortLabel,
  modelLabel,
  utf8Bytes,
  vendorLabel,
  type AgentSetting,
  type EditPersonaRequest,
  type PersonaChange,
  type PersonaView,
  type Pm,
  type PmMode,
  type Project,
  type ProjectFolder,
} from "../../shared/index.ts";
import { ApiError, fetchPersona, postRevertPersonaChange, putPersona } from "../client.ts";
import { ACTOR_LABELS, errorText, formatTime } from "../format.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { Textarea } from "../ui/input.tsx";
import { AgentFields, draftOf, settingOf, type AgentDraft } from "./AgentFields.tsx";
import { Avatar } from "./Avatar.tsx";
import { ModeField } from "./ModeField.tsx";

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

function describeChange(change: PersonaChange): string {
  if (change.revertOf !== null) return "撤销了一次修改";
  const parts: string[] = [];
  if (change.textBefore !== change.textAfter) parts.push("改了性格设定");
  if (change.modeBefore !== change.modeAfter) parts.push(`模式改成${PM_MODE_LABELS[change.modeAfter]}`);
  if (change.vendorBefore !== change.vendorAfter) parts.push(`厂商改成${vendorLabel(change.vendorAfter)}`);
  if (change.modelBefore !== change.modelAfter) parts.push(`模型改成${modelLabel(change.vendorAfter, change.modelAfter)}`);
  if (change.effortBefore !== change.effortAfter) parts.push(`思考程度改成${effortLabel(change.effortAfter)}`);
  return parts.join("，") || "改了设置";
}

function ChangeRow({ change, revertable, busy, onRevert }: { change: PersonaChange; revertable: boolean; busy: boolean; onRevert: () => void }) {
  const [open, setOpen] = useState(false);
  const textChanged = change.textBefore !== change.textAfter;
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[15px]">
            <span className="font-medium">{ACTOR_LABELS[change.actor]}</span> {describeChange(change)}
            {change.reason && <span>：{change.reason}</span>}
          </div>
          <div className="text-[13px] text-muted-foreground tabular-nums">{formatTime(change.createdAt)}</div>
        </div>
        {revertable && (
          <Button variant="outline" size="sm" disabled={busy} onClick={onRevert}>
            撤销
          </Button>
        )}
      </div>
      {textChanged && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="group mt-1 flex cursor-pointer items-center gap-1 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
            查看改动
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 grid gap-2 sm:grid-cols-2">
            {(["改之前", "改之后"] as const).map((label) => (
              <div key={label} className="min-w-0">
                <div className="mb-1 text-[13px] font-medium">{label}</div>
                <pre className="max-h-60 overflow-auto rounded-xl bg-muted p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
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

/** 资料页的一张卡片：标题 + 内容。aria-label 就是标题。 */
function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-4 rounded-2xl border border-border p-5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** 卡片底部：保存失败的原因 + 保存按钮。 */
function SaveRow({ error, canSave, saving, onSave }: { error: string | null; canSave: boolean; saving: boolean; onSave: () => void }) {
  return (
    <div className="flex items-center justify-end gap-4">
      {error && (
        <p role="alert" className="mr-auto text-[13.5px] text-danger [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      <Button disabled={!canSave} onClick={onSave}>
        {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
        保存
      </Button>
    </div>
  );
}

type Section = "agent" | "mode" | "text";

function sameSetting(a: AgentSetting, b: AgentSetting): boolean {
  return a.vendor === b.vendor && a.model === b.model && a.effort === b.effort;
}

/** Agent、工作方式、性格设定三张卡片各自保存（只发自己那几项），修改记录在最后。 */
function PmEditor({ pm, persona, onUpdate }: { pm: Pm; persona: PersonaView; onUpdate: (p: PersonaView) => void }) {
  // null：没动过，显示服务端的最新；动过就保留自己的输入，别处改了也不覆盖
  const [draftAgent, setDraftAgent] = useState<AgentDraft | null>(null);
  const [draftMode, setDraftMode] = useState<PmMode | null>(null);
  const [draftText, setDraftText] = useState<string | null>(null);
  const [busy, setBusy] = useState<Section | "revert" | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Section | "revert", string>>>({});
  const saved: AgentSetting = { vendor: persona.vendor, model: persona.model, effort: persona.effort };
  const agent = draftAgent ?? draftOf(saved);
  const agentResult = settingOf(agent);
  const agentDirty = agentResult.ok ? !sameSetting(agentResult.setting, saved) : true;
  const mode = draftMode ?? persona.mode;
  const text = draftText ?? persona.text;
  const tooLong = utf8Bytes(text) > MAX_PERSONA_BYTES;
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const run = async (section: Section | "revert", call: () => Promise<PersonaView>, reset: () => void, failText?: (err: unknown) => string) => {
    setBusy(section);
    setErrors((e) => ({ ...e, [section]: undefined }));
    try {
      const next = await call();
      if (!aliveRef.current) return;
      reset();
      onUpdate(next);
    } catch (err) {
      if (aliveRef.current) setErrors((e) => ({ ...e, [section]: failText?.(err) ?? errorText(err) }));
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };

  const save = (section: Section) => {
    let body: EditPersonaRequest;
    if (section === "agent") {
      if (!agentResult.ok) return;
      const next = agentResult.setting;
      body = {
        ...(next.vendor !== saved.vendor ? { vendor: next.vendor } : {}),
        ...(next.model !== saved.model ? { model: next.model } : {}),
        ...(next.effort !== saved.effort ? { effort: next.effort } : {}),
      };
    } else body = section === "mode" ? { mode } : { text };
    const reset = { agent: () => setDraftAgent(null), mode: () => setDraftMode(null), text: () => setDraftText(null) }[section];
    void run(section, async () => (await putPersona(pm.id, body)).persona, reset);
  };

  const revert = (changeId: number) =>
    void run(
      "revert",
      async () => (await postRevertPersonaChange(changeId)).persona,
      // 撤销的结果回来后，本地没提交的输入已经没意义了
      () => {
        setDraftAgent(null);
        setDraftMode(null);
        setDraftText(null);
      },
      (err) => (err instanceof ApiError && err.status === 409 ? "只能撤销最近一次" : errorText(err)),
    );

  const disabled = busy !== null;
  return (
    <>
      <Card title="Agent">
        <AgentFields value={agent} onChange={setDraftAgent} disabled={disabled} />
        <SaveRow error={errors.agent ?? null} canSave={agentDirty && agentResult.ok && !disabled} saving={busy === "agent"} onSave={() => save("agent")} />
      </Card>
      <Card title="工作方式">
        <ModeField label="工作方式" value={mode} onChange={setDraftMode} disabled={disabled} />
        <SaveRow error={errors.mode ?? null} canSave={mode !== persona.mode && !disabled} saving={busy === "mode"} onSave={() => save("mode")} />
      </Card>
      <Card title="性格设定">
        <Textarea
          aria-label="性格设定"
          rows={10}
          className="font-mono text-[13.5px]"
          value={text}
          onChange={(e) => setDraftText(e.target.value)}
        />
        {tooLong && <p className="-mt-2 text-[13px] text-danger">性格设定太长</p>}
        <SaveRow
          error={errors.text ?? null}
          canSave={text !== persona.text && !tooLong && !disabled}
          saving={busy === "text"}
          onSave={() => save("text")}
        />
      </Card>
      <Card title="修改记录">
        {errors.revert && (
          <p role="alert" className="-mt-2 text-[13.5px] text-danger">
            {errors.revert}
          </p>
        )}
        {persona.changes.length === 0 ? (
          <p className="text-[14px] text-muted-foreground">还没有修改</p>
        ) : (
          <ul aria-label="修改记录" className="divide-y divide-border">
            {persona.changes.map((change) => (
              <ChangeRow
                key={change.id}
                change={change}
                revertable={change.id === persona.revertableChangeId}
                busy={disabled}
                onRevert={() => revert(change.id)}
              />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/** 项目经理资料页（设计第 3.6 节）：基本信息、Agent、工作方式、性格设定、修改记录五张卡片。 */
export function PmProfile({
  pm,
  project,
  folders,
  rev,
  onBack,
}: {
  pm: Pm;
  project: Project | null;
  /** 项目没移除的文件夹，主文件夹在前。 */
  folders: ProjectFolder[];
  /** pm.updated 的次数，变了就重新拉。 */
  rev: number;
  onBack: () => void;
}) {
  const { load, retry, set } = usePersona(pm.id, rev);
  const label = `${pm.name} 的资料`;
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={label}>
      <header className="flex h-16 shrink-0 items-center gap-3 px-6">
        <Button variant="ghost" size="icon-sm" aria-label="返回" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
        <Avatar colorKey={pm.id} size={34} />
        <h1 className="text-[17px] font-semibold">{pm.name}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
        <div className="mx-auto grid max-w-[720px] gap-5 pt-2">
          <Card title="基本信息">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[15px]">
              <dt className="text-muted-foreground">项目</dt>
              <dd>{project ? project.name : "还没有"}</dd>
              {folders.length > 0 && (
                <>
                  <dt className="text-muted-foreground">文件夹</dt>
                  <dd className="min-w-0">
                    <ul aria-label="文件夹" className="grid gap-0.5">
                      {folders.map((f) => (
                        <li key={f.id} className="truncate" title={f.path}>
                          {f.path}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </>
              )}
            </dl>
          </Card>
          {load.phase === "loading" && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              加载中
            </div>
          )}
          {load.phase === "error" && (
            <div className="flex items-center gap-3">
              <p role="alert" className="text-danger">
                {load.message}
              </p>
              <Button variant="outline" size="sm" onClick={retry}>
                重试
              </Button>
            </div>
          )}
          {load.phase === "ready" && <PmEditor pm={pm} persona={load.persona} onUpdate={set} />}
        </div>
      </div>
    </section>
  );
}

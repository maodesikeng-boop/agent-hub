import { ArrowLeft, ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_PERSONA_BYTES,
  PM_MODE_LABELS,
  utf8Bytes,
  type EditPersonaRequest,
  type PersonaChange,
  type PersonaView,
  type Pm,
  type PmMode,
  type Project,
} from "../../shared/index.ts";
import { ApiError, fetchPersona, postRevertPersonaChange, putPersona } from "../client.ts";
import { ACTOR_LABELS, errorText, formatTime } from "../format.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { Textarea } from "../ui/input.tsx";
import { Avatar } from "./Avatar.tsx";
import { Field } from "./Field.tsx";
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
  if (change.modeBefore !== change.modeAfter) {
    parts.push(`模式改成${PM_MODE_LABELS[change.modeAfter]}`);
  }
  return parts.join("，") || "改了设置";
}

function ChangeRow({ change, revertable, busy, onRevert }: { change: PersonaChange; revertable: boolean; busy: boolean; onRevert: () => void }) {
  const [open, setOpen] = useState(false);
  const textChanged = change.textBefore !== change.textAfter;
  return (
    <li className="py-3">
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

function PersonaEditor({ pm, persona, onUpdate }: { pm: Pm; persona: PersonaView; onUpdate: (p: PersonaView) => void }) {
  // null：没动过，显示服务端的最新；动过就保留自己的输入，别处改了也不覆盖
  const [draftText, setDraftText] = useState<string | null>(null);
  const [draftMode, setDraftMode] = useState<PmMode | null>(null);
  const [busy, setBusy] = useState<"save" | "revert" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const text = draftText ?? persona.text;
  const mode = draftMode ?? persona.mode;
  const textDirty = text !== persona.text;
  const modeDirty = mode !== persona.mode;
  const tooLong = utf8Bytes(text) > MAX_PERSONA_BYTES;
  const canSave = (textDirty || modeDirty) && !tooLong && busy === null;
  // 撤销的结果回来后，本地没提交的输入已经没意义了
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const save = async () => {
    const body: EditPersonaRequest = { ...(textDirty ? { text } : {}), ...(modeDirty ? { mode } : {}) };
    setBusy("save");
    setError(null);
    try {
      const res = await putPersona(pm.id, body);
      if (!aliveRef.current) return;
      setDraftText(null);
      setDraftMode(null);
      onUpdate(res.persona);
    } catch (err) {
      if (aliveRef.current) setError(errorText(err));
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };

  const revert = async (changeId: number) => {
    setBusy("revert");
    setError(null);
    try {
      const res = await postRevertPersonaChange(changeId);
      if (!aliveRef.current) return;
      setDraftText(null);
      setDraftMode(null);
      onUpdate(res.persona);
    } catch (err) {
      if (aliveRef.current) setError(err instanceof ApiError && err.status === 409 ? "只能撤销最近一次" : errorText(err));
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };

  return (
    <div className="grid gap-8">
      <div className="grid gap-2">
        <div className="text-[13.5px] font-medium">模式</div>
        <ModeField label="模式" value={mode} onChange={setDraftMode} disabled={busy !== null} />
      </div>
      <Field label="性格设定">
        {(id) => <Textarea id={id} rows={10} className="font-mono text-[13.5px]" value={text} onChange={(e) => setDraftText(e.target.value)} />}
      </Field>
      {tooLong && <p className="-mt-6 text-[13px] text-danger">性格设定太长</p>}
      {error && (
        <p role="alert" className="-mt-4 text-[13.5px] text-danger">
          {error}
        </p>
      )}
      <div className="-mt-4 flex justify-end">
        <Button disabled={!canSave} onClick={() => void save()}>
          {busy === "save" && <Loader2 className="animate-spin" aria-hidden="true" />}
          保存
        </Button>
      </div>
      <section aria-label="修改历史" className="grid gap-1">
        <h2 className="text-[15px] font-semibold">修改记录</h2>
        {persona.changes.length === 0 ? (
          <p className="text-[14px] text-muted-foreground">还没有修改</p>
        ) : (
          <ul aria-label="修改记录" className="divide-y divide-border">
            {persona.changes.map((change) => (
              <ChangeRow
                key={change.id}
                change={change}
                revertable={change.id === persona.revertableChangeId}
                busy={busy !== null}
                onRevert={() => void revert(change.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** 项目经理资料页（设计第 3.6 节）：模式、模型、性格设定可改，修改记录，管着哪些项目。 */
export function PmProfile({
  pm,
  projects,
  rev,
  onBack,
}: {
  pm: Pm;
  projects: Project[];
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
        <div className="mx-auto grid max-w-[720px] gap-8 pt-2">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[15px]">
            <dt className="text-muted-foreground">模型</dt>
            <dd>{pm.defaultModel ?? "默认"}</dd>
            <dt className="text-muted-foreground">管着的项目</dt>
            <dd>
              {projects.length === 0 ? (
                "还没有"
              ) : (
                <ul className="flex flex-wrap gap-x-4">
                  {projects.map((p) => (
                    <li key={p.id}>{p.name}</li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
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
          {load.phase === "ready" && <PersonaEditor pm={pm} persona={load.persona} onUpdate={set} />}
        </div>
      </div>
    </section>
  );
}

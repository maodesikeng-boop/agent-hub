// 资料页的“定时任务”组（M6）：一个任务一行（名字，下面频率、下次时间，失败了才写上次结果），右边开关（暂停/恢复）和删除（要二次确认）；
// 最后一行“新建”，点了在组里展开表单。表单照 docs/ui-standard.md 第 9 条“表单校验”：空着“保存”是灰的，填得不对边输入边在那一行下面写原因；
// 后台再查一遍（同 hub schedule add），后台拒绝的原因写在按钮上面。
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  MAX_SCHEDULES_PER_PM,
  MAX_SCHEDULE_NAME_CHARS,
  MAX_TASK_BYTES,
  checkEveryMinutes,
  parseDailyTime,
  scheduleLabel,
  scheduledTimeText,
  utf8Bytes,
  type ScheduleRecord,
} from "../../shared/index.ts";
import { useClient } from "../device-scope.tsx";
import { errorText, nameError } from "../format.ts";
import { Button } from "../ui/button.tsx";
import { Input, Select, Textarea } from "../ui/input.tsx";
import { Switch } from "../ui/switch.tsx";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

function ScheduleItem({ schedule }: { schedule: ScheduleRecord }) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const now = Date.now();
  return (
    <SettingsRow
      label={schedule.name}
      error={error}
      detail={
        // 各项各自一段、用间距隔开（不用逗号拼）；上次成功、跳过、还没跑过都不用管，只有失败才写
        <span className="flex flex-wrap gap-x-3 tabular-nums">
          <span>{scheduleLabel(schedule)}</span>
          <span>{schedule.enabled ? `下次 ${scheduledTimeText(schedule.nextRunAt, now)}` : "已暂停"}</span>
          {schedule.lastStatus === "failed" && (
            <span className="text-danger" title={schedule.lastError ?? undefined}>
              上次失败
            </span>
          )}
        </span>
      }
    >
      {(id) =>
        confirming ? (
          <>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              取消
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void run(() => client.deleteSchedule(schedule.id))}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              确认删除
            </Button>
          </>
        ) : (
          <>
            <Switch id={id} aria-label={`${schedule.name} 运行中`} checked={schedule.enabled} disabled={busy} onCheckedChange={(on) => void run(() => client.putScheduleEnabled(schedule.id, on))} />
            <Button variant="ghost" size="icon-sm" aria-label={`删除 ${schedule.name}`} disabled={busy} onClick={() => setConfirming(true)}>
              <Trash2 aria-hidden="true" />
            </Button>
          </>
        )
      }
    </SettingsRow>
  );
}

type Unit = "minutes" | "hours";

function NewScheduleForm({ pmId, onClose }: { pmId: number; onClose: () => void }) {
  const client = useClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"daily" | "interval">("daily");
  const [time, setTime] = useState("09:00");
  const [every, setEvery] = useState("1");
  const [unit, setUnit] = useState<Unit>("hours");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每一行自己的错：空着不算错（只是不能保存），填了不对才写
  const nameProblem = nameError(name, MAX_SCHEDULE_NAME_CHARS) ?? (/[【】]/.test(name) ? "名字里不能有“【”“】”" : null);
  const minutes = /^[0-9]+$/.test(every.trim()) ? Number(every.trim()) * (unit === "hours" ? 60 : 1) : NaN;
  const freqEmpty = kind === "daily" ? time.trim() === "" : every.trim() === "";
  const freqProblem = freqEmpty
    ? null
    : kind === "daily"
      ? parseDailyTime(time.trim()) === null
        ? "时间要写成 HH:MM，比如 09:00"
        : null
      : checkEveryMinutes(minutes);
  const promptProblem = utf8Bytes(prompt) > MAX_TASK_BYTES ? "要它做什么写得太长了" : null;
  const canSave = name.trim() !== "" && nameProblem === null && !freqEmpty && freqProblem === null && prompt.trim() !== "" && promptProblem === null && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await client.postAddSchedule(pmId, { name: name.trim(), prompt, ...(kind === "daily" ? { daily: time.trim() } : { everyMinutes: minutes }) });
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsRow label="名字" error={nameProblem}>
        {(id) => <Input id={id} className="w-[240px]" autoComplete="off" value={name} aria-invalid={nameProblem !== null} onChange={(e) => setName(e.target.value)} />}
      </SettingsRow>
      <SettingsRow label="频率" error={freqProblem}>
        {(id) => (
          <>
            <Select id={id} aria-label="频率" value={kind} onChange={(e) => setKind(e.target.value as "daily" | "interval")}>
              <option value="daily">每天</option>
              <option value="interval">每隔</option>
            </Select>
            {kind === "daily" ? (
              <Input aria-label="时间" className="w-24 tabular-nums" placeholder="09:00" value={time} aria-invalid={freqProblem !== null} onChange={(e) => setTime(e.target.value)} />
            ) : (
              <>
                <Input aria-label="间隔" inputMode="numeric" className="w-20 tabular-nums" value={every} aria-invalid={freqProblem !== null} onChange={(e) => setEvery(e.target.value)} />
                <Select aria-label="单位" value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
                  <option value="minutes">分钟</option>
                  <option value="hours">小时</option>
                </Select>
              </>
            )}
          </>
        )}
      </SettingsRow>
      {/* 框里的多行输入是一整行：没有边框和拖拽角，跟着内容长高；名字放占位符 */}
      <div data-slot="settings-row">
        <Textarea
          aria-label="要它做什么"
          placeholder="要它做什么"
          rows={3}
          className="block max-h-[40vh] min-h-24 resize-none rounded-none border-0 bg-transparent px-4 py-3 field-sizing-content focus-visible:ring-0"
          value={prompt}
          aria-invalid={promptProblem !== null}
          onChange={(e) => setPrompt(e.target.value)}
        />
        {promptProblem && (
          <div className="px-4 pb-3">
            <RowError>{promptProblem}</RowError>
          </div>
        )}
      </div>
      <div className="px-4 py-3">
        {error && <RowError>{error}</RowError>}
        <div className={error ? "mt-2 flex items-center justify-end gap-2" : "flex items-center justify-end gap-2"}>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            保存
          </Button>
        </div>
      </div>
    </>
  );
}

export function ScheduleGroup({ pmId, schedules }: { pmId: number; schedules: ScheduleRecord[] }) {
  const [adding, setAdding] = useState(false);
  const full = schedules.length >= MAX_SCHEDULES_PER_PM;
  return (
    <SettingsGroup title="定时任务">
      {schedules.map((s) => (
        <ScheduleItem key={s.id} schedule={s} />
      ))}
      {adding ? (
        <NewScheduleForm pmId={pmId} onClose={() => setAdding(false)} />
      ) : (
        // 满了不让填完才知道：“新建”直接不能点，右边写状态
        <button
          type="button"
          disabled={full}
          className="flex min-h-13 w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-[15px] transition-colors outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:cursor-default disabled:hover:bg-transparent"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className={full ? "text-muted-foreground" : undefined}>新建</span>
          {full && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{`已满 ${MAX_SCHEDULES_PER_PM} 个`}</span>}
        </button>
      )}
    </SettingsGroup>
  );
}

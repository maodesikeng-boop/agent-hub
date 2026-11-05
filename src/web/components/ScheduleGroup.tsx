// 资料页的“定时任务”组（M6）：一个任务一行（名字、频率和下次时间、上次结果），右边开关（暂停/恢复）和删除（要二次确认）；
// 最后一行“新建”，点了在组里展开表单。校验和写库都在后台（同 hub schedule add），这里只先拦明显的错，失败原因显示在表单下面。
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  MAX_SCHEDULES_PER_PM,
  MAX_SCHEDULE_NAME_CHARS,
  checkEveryMinutes,
  normalizeName,
  parseDailyTime,
  scheduleLabel,
  scheduledTimeText,
  type ScheduleRecord,
  type ScheduleStatus,
} from "../../shared/index.ts";
import { deleteSchedule, postAddSchedule, putScheduleEnabled } from "../client.ts";
import { errorText } from "../format.ts";
import { Button } from "../ui/button.tsx";
import { Input, Select, Textarea } from "../ui/input.tsx";
import { Switch } from "../ui/switch.tsx";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

const RESULT_LABELS: Record<ScheduleStatus, string> = { sent: "成功", skipped: "跳过", failed: "失败" };

function ScheduleItem({ schedule }: { schedule: ScheduleRecord }) {
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
        <>
          <div>{`${scheduleLabel(schedule)}，${schedule.enabled ? `下次 ${scheduledTimeText(schedule.nextRunAt, now)}` : "已暂停"}`}</div>
          <div className="text-xs">
            {schedule.lastStatus === null ? (
              "还没跑过"
            ) : (
              <span className={schedule.lastStatus === "failed" ? "text-danger" : undefined} title={schedule.lastError ?? undefined}>
                {`上次${RESULT_LABELS[schedule.lastStatus]}`}
              </span>
            )}
          </div>
        </>
      }
    >
      {(id) =>
        confirming ? (
          <>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              取消
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void run(() => deleteSchedule(schedule.id))}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              确认删除
            </Button>
          </>
        ) : (
          <>
            <Switch id={id} aria-label={`${schedule.name} 运行中`} checked={schedule.enabled} disabled={busy} onCheckedChange={(on) => void run(() => putScheduleEnabled(schedule.id, on))} />
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

function NewScheduleForm({ pmId, count, onClose }: { pmId: number; count: number; onClose: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"daily" | "interval">("daily");
  const [time, setTime] = useState("09:00");
  const [every, setEvery] = useState("1");
  const [unit, setUnit] = useState<Unit>("hours");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = (): { daily?: string; everyMinutes?: number } | string => {
    if (count >= MAX_SCHEDULES_PER_PM) return `定时任务最多 ${MAX_SCHEDULES_PER_PM} 个，先删掉不要的`;
    const clean = normalizeName(name, MAX_SCHEDULE_NAME_CHARS);
    if (clean === null) return `名字不能是空的，最多 ${MAX_SCHEDULE_NAME_CHARS} 个字符`;
    if (clean.includes("【") || clean.includes("】")) return "名字里不能有“【”“】”";
    if (kind === "daily") {
      if (parseDailyTime(time.trim()) === null) return "每天的时间要写成 HH:MM（24 小时制，如 09:00）";
    } else {
      const bad = checkEveryMinutes(/^[0-9]+$/.test(every.trim()) ? Number(every.trim()) * (unit === "hours" ? 60 : 1) : NaN);
      if (bad !== null) return bad;
    }
    if (prompt.trim() === "") return "要它做什么不能是空的";
    return kind === "daily" ? { daily: time.trim() } : { everyMinutes: Number(every.trim()) * (unit === "hours" ? 60 : 1) };
  };

  const save = async () => {
    const frequency = check();
    if (typeof frequency === "string") return setError(frequency);
    setBusy(true);
    setError(null);
    try {
      await postAddSchedule(pmId, { name: name.trim(), prompt, ...frequency });
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsRow label="名字">{(id) => <Input id={id} className="w-[240px]" value={name} onChange={(e) => setName(e.target.value)} />}</SettingsRow>
      <SettingsRow label="频率">
        {(id) => (
          <>
            <Select id={id} aria-label="频率" value={kind} onChange={(e) => setKind(e.target.value as "daily" | "interval")}>
              <option value="daily">每天</option>
              <option value="interval">每隔</option>
            </Select>
            {kind === "daily" ? (
              <Input aria-label="时间" className="w-24" placeholder="09:00" value={time} onChange={(e) => setTime(e.target.value)} />
            ) : (
              <>
                <Input aria-label="间隔" inputMode="numeric" className="w-20" value={every} onChange={(e) => setEvery(e.target.value)} />
                <Select aria-label="单位" value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
                  <option value="minutes">分钟</option>
                  <option value="hours">小时</option>
                </Select>
              </>
            )}
          </>
        )}
      </SettingsRow>
      <div className="px-4 py-2.5">
        <label htmlFor="schedule-prompt" className="text-[15px]">
          要它做什么
        </label>
        <Textarea id="schedule-prompt" rows={4} className="mt-2 min-h-24" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </div>
      <div className="px-4 py-2.5">
        <div className="flex min-h-9 items-center justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            保存
          </Button>
        </div>
        {error && <RowError>{error}</RowError>}
      </div>
    </>
  );
}

export function ScheduleGroup({ pmId, schedules }: { pmId: number; schedules: ScheduleRecord[] }) {
  const [adding, setAdding] = useState(false);
  return (
    <SettingsGroup title="定时任务">
      {schedules.map((s) => (
        <ScheduleItem key={s.id} schedule={s} />
      ))}
      {adding ? (
        <NewScheduleForm pmId={pmId} count={schedules.length} onClose={() => setAdding(false)} />
      ) : (
        <button
          type="button"
          className="flex min-h-14 w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left text-[15px] transition-colors outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-4 text-muted-foreground" aria-hidden="true" />
          新建
        </button>
      )}
    </SettingsGroup>
  );
}

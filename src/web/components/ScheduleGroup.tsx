import { Loader2, Plus, Trash2 } from "../ui/icons.ts";
import { useState } from "react";
import {
  MAX_SCHEDULES_PER_PM,
  MAX_SCHEDULE_NAME_CHARS,
  MAX_TASK_BYTES,
  checkEveryMinutes,
  parseDailyTime,
  scheduledTimeText,
  utf8Bytes,
  type ScheduleRecord,
} from "../../shared/index.ts";
import { useClient } from "../device-scope.tsx";
import { errorText, formatSchedule, nameError, type ErrorLike } from "../format.ts";
import { Button } from "../ui/button.tsx";
import { Input, Textarea } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { Switch } from "../ui/switch.tsx";
import { cn } from "../lib/utils.ts";
import { INFO_ROW, InfoAction, RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

function ScheduleItem({ schedule, disabled }: { schedule: ScheduleRecord; disabled: boolean }) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
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
  const locked = busy || disabled;
  return (
    <SettingsRow
      label={schedule.name}
      error={error}
      detail={
        <span className="flex flex-wrap gap-x-3 tabular-nums">
          <span>{formatSchedule(schedule)}</span>
          <span>{schedule.enabled ? `Next ${scheduledTimeText(schedule.nextRunAt, now)}` : "Paused"}</span>
          {schedule.lastStatus === "failed" && (
            <span className="text-danger" title={schedule.lastError ?? undefined}>
              Last run failed
            </span>
          )}
        </span>
      }
    >
      {(id) =>
        confirming ? (
          <>
            <span className="info-actions">
              <InfoAction disabled={locked} onClick={() => setConfirming(false)}>
                Cancel
              </InfoAction>
              <InfoAction danger disabled={locked} onClick={() => void run(() => client.deleteSchedule(schedule.id))}>
                {busy && <Loader2 className="size-3.5" aria-hidden="true" />}
                Delete
              </InfoAction>
            </span>
          </>
        ) : (
          <>
            <Switch id={id} aria-label={`${schedule.name} enabled`} checked={schedule.enabled} disabled={locked} onCheckedChange={(on) => void run(() => client.putScheduleEnabled(schedule.id, on))} />
            <Button variant="ghost" size="icon-sm" className="size-6 [&_svg]:size-3.5" aria-label={`Delete ${schedule.name}`} disabled={locked} onClick={() => setConfirming(true)}>
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
  const [error, setError] = useState<ErrorLike | null>(null);

  const nameProblem = nameError(name, MAX_SCHEDULE_NAME_CHARS) ?? (/[【】]/.test(name) ? "Name can't contain 【 or 】" : null);
  const minutes = /^[0-9]+$/.test(every.trim()) ? Number(every.trim()) * (unit === "hours" ? 60 : 1) : NaN;
  const freqEmpty = kind === "daily" ? time.trim() === "" : every.trim() === "";
  const freqProblem = freqEmpty
    ? null
    : kind === "daily"
      ? parseDailyTime(time.trim()) === null
        ? "Use HH:MM, like 09:00"
        : null
      : checkEveryMinutes(minutes);
  const promptProblem = utf8Bytes(prompt) > MAX_TASK_BYTES ? "Task is too long" : null;
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
      <SettingsRow label="Name" error={nameProblem}>
        {(id) => <Input id={id} className="h-7.5 w-60 text-minor" autoComplete="off" value={name} aria-invalid={nameProblem !== null} onChange={(e) => setName(e.target.value)} />}
      </SettingsRow>
      <SettingsRow label="Repeat" error={freqProblem}>
        {(id) => (
          <>
            <Select value={kind} onValueChange={(next) => setKind(next as "daily" | "interval")}>
              <SelectTrigger id={id} aria-label="Repeat" variant="plain">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily at</SelectItem>
                <SelectItem value="interval">Every</SelectItem>
              </SelectContent>
            </Select>
            {kind === "daily" ? (
              <Input aria-label="Time" className="h-7.5 w-20 text-minor tabular-nums" placeholder="09:00" value={time} aria-invalid={freqProblem !== null} onChange={(e) => setTime(e.target.value)} />
            ) : (
              <>
                <Input aria-label="Interval" inputMode="numeric" className="h-7.5 w-16 text-minor tabular-nums" value={every} aria-invalid={freqProblem !== null} onChange={(e) => setEvery(e.target.value)} />
                <Select value={unit} onValueChange={(next) => setUnit(next as Unit)}>
                  <SelectTrigger aria-label="Unit" variant="plain">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="minutes">minutes</SelectItem>
                    <SelectItem value="hours">hours</SelectItem>
                  </SelectContent>
                </Select>
              </>
            )}
          </>
        )}
      </SettingsRow>
      <div data-slot="settings-row">
        <Textarea
          aria-label="Task"
          placeholder="Task"
          rows={3}
          className="block max-h-[40vh] min-h-20 resize-none border-0 bg-transparent px-0 py-1.5 text-minor placeholder:text-minor field-sizing-content focus-visible:outline-none"
          value={prompt}
          aria-invalid={promptProblem !== null}
          onChange={(e) => setPrompt(e.target.value)}
        />
        {promptProblem && <RowError>{promptProblem}</RowError>}
      </div>
      <div className="py-2">
        {error && <RowError error={error} />}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>
            {busy && <Loader2 aria-hidden="true" />}
            Save
          </Button>
        </div>
      </div>
    </>
  );
}

export function ScheduleGroup({ pmId, schedules, disabled = false }: { pmId: number; schedules: ScheduleRecord[]; disabled?: boolean }) {
  const [adding, setAdding] = useState(false);
  const full = schedules.length >= MAX_SCHEDULES_PER_PM;
  return (
    <SettingsGroup label="Schedules">
      {schedules.map((s) => (
        <ScheduleItem key={s.id} schedule={s} disabled={disabled} />
      ))}
      {adding && !disabled ? (
        <NewScheduleForm pmId={pmId} onClose={() => setAdding(false)} />
      ) : (
        <button
          type="button"
          disabled={disabled || full}
          className={cn(INFO_ROW, "h-7.5 text-minor")}
          onClick={() => setAdding(true)}
        >
          <Plus className="info-chevron size-3.5" aria-hidden="true" />
          <span className="flex-1 text-foreground">New</span>
          {full && <span className="info-val text-minor tabular-nums">{`${MAX_SCHEDULES_PER_PM} max`}</span>}
        </button>
      )}
    </SettingsGroup>
  );
}

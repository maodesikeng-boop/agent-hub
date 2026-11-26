import { PM_MODES, type PmMode } from "../../shared/index.ts";
import { MODE_LABELS, MODE_OPTION_DETAILS } from "../format.ts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { ChoiceRows, type ChoiceOption } from "./ChoiceRows.tsx";

const MODE_OPTIONS: readonly ChoiceOption<PmMode>[] = PM_MODES.map((mode) => ({
  value: mode,
  label: MODE_LABELS[mode],
  detail: MODE_OPTION_DETAILS[mode],
}));

export function ModeRows({
  value,
  onChange,
  disabled,
  label,
}: {
  value: PmMode;
  onChange: (mode: PmMode) => void;
  disabled?: boolean;
  label: string;
}) {
  return <ChoiceRows label={label} value={value} options={MODE_OPTIONS} disabled={disabled} onChange={onChange} />;
}

export function ModeSelect({ id, value, onChange, disabled }: { id: string; value: PmMode; onChange: (mode: PmMode) => void; disabled?: boolean }) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as PmMode)}>
      <SelectTrigger id={id} aria-label="Mode" variant="plain">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {MODE_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value} detail={o.detail}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

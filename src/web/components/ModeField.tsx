import { useId } from "react";
import { PM_MODES, type PmMode } from "../../shared/index.ts";
import { MODE_OPTION_DETAILS, MODE_OPTION_LABELS } from "../format.ts";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group.tsx";

/** 项目经理的模式单选，新建和资料页共用。 */
export function ModeField({
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
  const prefix = useId();
  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(v as PmMode)} disabled={disabled} aria-label={label}>
      {PM_MODES.map((mode) => {
        const id = `${prefix}-${mode}`;
        return (
          <div key={mode} className="flex items-start gap-2.5">
            <RadioGroupItem id={id} value={mode} aria-describedby={`${id}-detail`} />
            <div className="min-w-0">
              <label htmlFor={id} className="cursor-pointer text-[15px] leading-[22px] font-medium">
                {MODE_OPTION_LABELS[mode]}
              </label>
              <div id={`${id}-detail`} className="text-[13.5px] text-muted-foreground">
                {MODE_OPTION_DETAILS[mode]}
              </div>
            </div>
          </div>
        );
      })}
    </RadioGroup>
  );
}

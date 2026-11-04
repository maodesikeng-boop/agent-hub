import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Check } from "lucide-react";
import { useId } from "react";
import { PM_MODES, type PmMode } from "../../shared/index.ts";
import { MODE_OPTION_DETAILS, MODE_OPTION_LABELS } from "../format.ts";

/** 项目经理的模式：分组框里一种模式一行（名字、一句说明，选中的右边打勾），新建和资料页共用。放在 SettingsGroup 里。 */
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
  const prefix = useId();
  return (
    <RadioGroupPrimitive.Root
      value={value}
      onValueChange={(v) => onChange(v as PmMode)}
      disabled={disabled}
      aria-label={label}
      className="divide-y divide-sidebar-active"
    >
      {PM_MODES.map((mode) => {
        const id = `${prefix}-${mode}`;
        return (
          <RadioGroupPrimitive.Item
            key={mode}
            value={mode}
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-detail`}
            className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors hover:bg-sidebar-hover focus-visible:bg-sidebar-hover disabled:cursor-default disabled:opacity-50"
          >
            <span className="min-w-0 flex-1">
              <span id={`${id}-label`} className="block text-[15px]">
                {MODE_OPTION_LABELS[mode]}
              </span>
              <span id={`${id}-detail`} className="block text-[13px] text-muted-foreground">
                {MODE_OPTION_DETAILS[mode]}
              </span>
            </span>
            <RadioGroupPrimitive.Indicator>
              <Check className="size-[18px] text-primary" aria-hidden="true" />
            </RadioGroupPrimitive.Indicator>
          </RadioGroupPrimitive.Item>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}

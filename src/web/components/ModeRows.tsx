import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Check } from "lucide-react";
import { useId } from "react";
import { PM_MODES, PM_MODE_LABELS, type PmMode } from "../../shared/index.ts";
import { MODE_OPTION_DETAILS } from "../format.ts";
import { cn } from "../lib/utils.ts";

/** 多选一的标记（docs/ui-standard.md 第 9 条）：20px 的圆，没选中是灰边空心，选中是主色实心里一个白色粗勾。 */
function RadioMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full transition-colors",
        checked ? "bg-primary text-primary-foreground" : "border-[1.5px] border-zinc-300 bg-background",
      )}
    >
      {checked && <Check className="size-3" strokeWidth={3.5} />}
    </span>
  );
}

/** 项目经理的模式：分组框里一种模式一行（名字、一句说明，右边一个圆，选中的打勾），新建和资料页共用。放在 SettingsGroup 里。 */
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
            className="flex w-full cursor-pointer items-center gap-4 px-4 py-3 text-left outline-none transition-colors hover:bg-sidebar-hover focus-visible:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset disabled:cursor-default disabled:opacity-50"
          >
            <span className="min-w-0 flex-1">
              <span id={`${id}-label`} className="block text-[15px]">
                {PM_MODE_LABELS[mode]}
              </span>
              <span id={`${id}-detail`} className="block text-[13.5px] leading-snug text-muted-foreground">
                {MODE_OPTION_DETAILS[mode]}
              </span>
            </span>
            <RadioMark checked={mode === value} />
          </RadioGroupPrimitive.Item>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}

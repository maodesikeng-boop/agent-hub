import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { useId, type ReactNode } from "react";
import { cn } from "../lib/utils.ts";

export interface ChoiceOption<T extends string> {
  value: T;
  label: ReactNode;
  detail?: ReactNode;
}

export function RadioMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors motion-reduce:transition-none",
        checked ? "border-primary bg-primary" : "border-border-strong bg-background",
      )}
    >
      {checked && <span className="size-1.5 rounded-full bg-primary-foreground" />}
    </span>
  );
}

export function ChoiceRows<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean | undefined;
  label: string;
}) {
  const prefix = useId();
  return (
    <RadioGroupPrimitive.Root
      value={value}
      onValueChange={(v) => onChange(v as T)}
      {...(disabled !== undefined ? { disabled } : {})}
      aria-label={label}
    >
      {options.map((option) => {
        const id = `${prefix}-${option.value}`;
        const hasDetail = option.detail !== undefined;
        return (
          <RadioGroupPrimitive.Item
            key={option.value}
            value={option.value}
            aria-labelledby={`${id}-label`}
            aria-describedby={hasDetail ? `${id}-detail` : undefined}
            className={cn("info-row min-h-7.5 pointer-coarse:min-h-11 cursor-pointer gap-3 disabled:cursor-default disabled:opacity-50", hasDetail ? "py-1.5" : "h-7.5")}
          >
            <span className="min-w-0 flex-1">
              <span id={`${id}-label`} className="block text-minor text-foreground">
                {option.label}
              </span>
              {hasDetail && (
                <span id={`${id}-detail`} className="block text-xs leading-snug text-muted-foreground">
                  {option.detail}
                </span>
              )}
            </span>
            <RadioMark checked={option.value === value} />
          </RadioGroupPrimitive.Item>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}

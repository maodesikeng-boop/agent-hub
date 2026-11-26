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
        "flex size-4.5 shrink-0 items-center justify-center rounded-full border transition-colors motion-reduce:transition-none",
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
      {options.map((option, idx) => {
        const id = `${prefix}-${option.value}`;
        const hasDetail = option.detail !== undefined;
        return (
          <RadioGroupPrimitive.Item
            key={option.value}
            value={option.value}
            aria-labelledby={`${id}-label`}
            aria-describedby={hasDetail ? `${id}-detail` : undefined}
            className={cn(
              "flex w-full cursor-pointer items-center gap-4 rounded-none px-4 text-left outline-none transition-colors hover:bg-hover active:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] disabled:cursor-default disabled:opacity-50",
              hasDetail ? "py-3" : "min-h-12 py-2.5",
              idx > 0 && "border-t border-border",
            )}
          >
            <span className="min-w-0 flex-1">
              <span id={`${id}-label`} className="block text-body">
                {option.label}
              </span>
              {hasDetail && (
                <span id={`${id}-detail`} className="block text-minor leading-snug text-muted-foreground">
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

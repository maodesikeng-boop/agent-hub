import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Check } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "../lib/utils.ts";

export interface ChoiceOption<T extends string> {
  value: T;
  label: ReactNode;
  detail?: ReactNode;
}

/** 多选一的标记（docs/ui-standard.md 第 9 条）：20px 的圆，没选中是灰边空心，选中是主色实心里一个白色粗勾。 */
export function RadioMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full transition-colors motion-reduce:transition-none",
        checked ? "bg-primary text-primary-foreground" : "border-[1.5px] border-zinc-300 bg-background",
      )}
    >
      {checked && <Check className="size-3" strokeWidth={3.5} />}
    </span>
  );
}

/**
 * 分组框内的通用单选勾选列表（泛化自 ModeRows）：
 * - 带 detail 说明行用 py-3（项目经理模式等）；
 * - 无 detail 纯单行用 min-h-12 px-4 py-2.5（手机界面大小档位等）；
 * 右侧统一 20px RadioMark，整行可点、点了即存。
 */
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
              "flex w-full cursor-pointer items-center gap-4 px-4 text-left outline-none transition-colors hover:bg-sidebar-hover active:bg-sidebar-hover focus-visible:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset disabled:cursor-default disabled:opacity-50",
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
